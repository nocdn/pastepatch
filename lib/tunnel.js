import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

const CONFIG_VERSION = 1;
const DEFAULT_TUNNEL_NAME = "pastepatch";
const DEFAULT_PORT = 8787;

/**
 * pastepatch config directory: ~/.pastepatch
 * Stores tunnel metadata + a generated cloudflared config.yml so --mcp can start
 * without re-entering tokens.
 *
 * Locally-managed tunnel flow (official docs):
 *   cloudflared tunnel login
 *   cloudflared tunnel create <NAME>
 *   write config.yml (tunnel + credentials-file + ingress)
 *   cloudflared tunnel route dns <NAME> <hostname>
 *   cloudflared tunnel --config config.yml run <NAME>
 *
 * @see https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/
 * @see https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/
 */
export function pastepatchConfigDir() {
  return path.join(os.homedir(), ".pastepatch");
}

export function pastepatchTunnelConfigPath() {
  return path.join(pastepatchConfigDir(), "mcp-tunnel.json");
}

export function pastepatchCloudflaredConfigPath() {
  return path.join(pastepatchConfigDir(), "cloudflared-config.yml");
}

export function defaultCloudflaredDir() {
  if (process.platform === "win32") {
    return path.join(os.homedir(), ".cloudflared");
  }
  return path.join(os.homedir(), ".cloudflared");
}

export function certPemPath() {
  return path.join(defaultCloudflaredDir(), "cert.pem");
}

/**
 * cloudflared tunnel login writes ~/.cloudflared/cert.pem as an ARGO TUNNEL TOKEN
 * (base64 JSON with zoneID, accountID, apiToken) — not a classic X.509 PEM.
 * That zone is the domain you picked in the browser authorize page.
 */
export async function parseArgoTunnelToken(certPath = certPemPath()) {
  let raw;
  try {
    raw = await readFile(certPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const match = raw.match(
    /-----BEGIN ARGO TUNNEL TOKEN-----\s*([A-Za-z0-9+/=\s]+)\s*-----END ARGO TUNNEL TOKEN-----/,
  );
  if (!match) {
    return null;
  }

  try {
    const json = Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString("utf8");
    const data = JSON.parse(json);
    if (!data.zoneID || !data.apiToken) {
      return null;
    }
    return {
      zoneId: data.zoneID,
      accountId: data.accountID || null,
      apiToken: data.apiToken,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the Cloudflare zone name (e.g. bartoszbak.org) authorized by cert.pem.
 */
export async function resolveAuthenticatedZone({ logger = async () => {} } = {}) {
  const token = await parseArgoTunnelToken();
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${token.zoneId}`, {
      headers: {
        Authorization: `Bearer ${token.apiToken}`,
        "Content-Type": "application/json",
      },
    });
    const body = await response.json();
    if (!response.ok || !body?.success || !body?.result?.name) {
      await logger(
        `Cloudflare zone lookup failed: ${response.status} ${JSON.stringify(body?.errors || body)}`,
      );
      return { zoneId: token.zoneId, zoneName: null };
    }
    return { zoneId: token.zoneId, zoneName: body.result.name };
  } catch (error) {
    await logger(`Cloudflare zone lookup error: ${error.message}`);
    return { zoneId: token.zoneId, zoneName: null };
  }
}

export function subdomainFromHostname(hostname, zoneName) {
  if (!hostname || !zoneName) {
    return "";
  }
  const host = hostname.toLowerCase();
  const zone = zoneName.toLowerCase();
  if (host === zone) {
    return "";
  }
  if (host.endsWith(`.${zone}`)) {
    return host.slice(0, -(zone.length + 1));
  }
  // hostname might be just the subdomain label already
  if (!host.includes(".")) {
    return host;
  }
  return "";
}

export function buildHostname(subdomain, zoneName) {
  const sub = String(subdomain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/^\.+|\.+$/g, "");
  const zone = String(zoneName || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  if (!zone) {
    throw new Error("Zone name is required to build a hostname.");
  }
  if (!sub) {
    throw new Error("Subdomain is required (e.g. pastepatch).");
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub) || sub.includes("..")) {
    throw new Error(
      `Invalid subdomain "${sub}". Use a single DNS label (letters, numbers, hyphens), e.g. pastepatch.`,
    );
  }
  return `${sub}.${zone}`;
}

/**
 * Normalize --hostname: full FQDN, or subdomain only when zone is known.
 */
export function normalizeHostnameInput(input, zoneName) {
  const value = String(input || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!value) {
    return "";
  }
  // Full hostname (has a dot)
  if (value.includes(".")) {
    if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value) || value.includes("..")) {
      throw new Error(`Invalid hostname: ${value}`);
    }
    return value.toLowerCase();
  }
  // Subdomain label only
  if (!zoneName) {
    throw new Error(
      `Hostname "${value}" looks like a subdomain only, but the authenticated Cloudflare zone could not be detected. Pass a full hostname (e.g. ${value}.example.com).`,
    );
  }
  return buildHostname(value, zoneName);
}

/**
 * Resolve cloudflared binary. Prefer PATH; fall back to common Homebrew locations.
 * Override with PASTEPATCH_CLOUDFLARED=/path/to/cloudflared, or set PASTEPATCH_CLOUDFLARED=0 to force missing.
 */
export async function resolveCloudflaredBinary() {
  const override = process.env.PASTEPATCH_CLOUDFLARED;
  if (override === "0" || override === "false") {
    return null;
  }
  if (override) {
    return (await commandExists(override)) ? override : null;
  }

  const candidates = ["cloudflared"];
  if (process.platform === "darwin") {
    candidates.push("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared");
  }
  if (process.platform === "win32") {
    candidates.push(path.join(os.homedir(), "cloudflared.exe"));
  }

  for (const candidate of candidates) {
    if (await commandExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export function cloudflaredMissingError({ packageName = "pastepatch" } = {}) {
  const install =
    process.platform === "darwin"
      ? "brew install cloudflared"
      : process.platform === "win32"
        ? "See https://developers.cloudflare.com/tunnel/downloads/"
        : "See https://developers.cloudflare.com/tunnel/downloads/ (or your package manager)";

  return new Error(
    `cloudflared is not installed (or not on PATH).\n\n` +
      `${packageName} --mcp needs the Cloudflare Tunnel daemon to expose a stable public URL to ChatGPT.\n\n` +
      `Install it, then re-run:\n` +
      `  ${install}\n\n` +
      `Docs: https://developers.cloudflare.com/tunnel/downloads/\n` +
      `After install, run:\n` +
      `  ${packageName} --mcp --setup-tunnel`,
  );
}

export async function requireCloudflaredBinary({ packageName = "pastepatch" } = {}) {
  const binary = await resolveCloudflaredBinary();
  if (!binary) {
    throw cloudflaredMissingError({ packageName });
  }
  return binary;
}

export async function loadTunnelConfig() {
  try {
    const raw = await readFile(pastepatchTunnelConfigPath(), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") {
      return null;
    }
    return data;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveTunnelConfig(config) {
  await mkdir(pastepatchConfigDir(), { recursive: true });
  const pathToWrite = pastepatchTunnelConfigPath();
  await writeFile(pathToWrite, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  // Restrict permissions when possible (credentials paths live here)
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(pathToWrite, 0o600);
  } catch {
    // Windows / unsupported — ignore
  }
  return pathToWrite;
}

/**
 * Write a cloudflared config for a published HTTP app on localhost.
 * @see https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/
 */
export function buildCloudflaredConfigYaml({ tunnelId, credentialsFile, hostname, port }) {
  // Minimal YAML (no dependency). Paths may contain special chars — quote them.
  const cred = yamlSingleQuoted(credentialsFile);
  const host = yamlSingleQuoted(hostname);
  const service = yamlSingleQuoted(`http://127.0.0.1:${port}`);
  return [
    `# Generated by pastepatch — do not commit secrets`,
    `tunnel: ${tunnelId}`,
    `credentials-file: ${cred}`,
    ``,
    `ingress:`,
    `  - hostname: ${host}`,
    `    service: ${service}`,
    `  - service: http_status:404`,
    ``,
  ].join("\n");
}

function yamlSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function writeCloudflaredConfigFile({ tunnelId, credentialsFile, hostname, port }) {
  await mkdir(pastepatchConfigDir(), { recursive: true });
  const configPath = pastepatchCloudflaredConfigPath();
  const yaml = buildCloudflaredConfigYaml({ tunnelId, credentialsFile, hostname, port });
  await writeFile(configPath, yaml, "utf8");
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(configPath, 0o600);
  } catch {
    // ignore
  }
  return configPath;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isCloudflaredAuthenticated() {
  return pathExists(certPemPath());
}

/**
 * Ensure cert.pem exists by running `cloudflared tunnel login` if needed.
 * Interactive: opens a browser to authorize DNS-edit access for a zone.
 * @see https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/
 */
export async function ensureCloudflaredLogin({ binary, logger = async () => {} }) {
  if (await isCloudflaredAuthenticated()) {
    await logger("cloudflared already authenticated (cert.pem present)");
    return;
  }

  process.stderr.write(
    "cloudflared is not authenticated yet.\n" +
      "A browser window will open so you can log into Cloudflare and pick a domain (zone).\n" +
      "That grants pastepatch permission to create tunnels and DNS records for that domain.\n\n",
  );

  if (!process.stdin.isTTY) {
    throw new Error(
      `cloudflared is not authenticated (missing ${certPemPath()}).\n` +
        `Run this interactively first:\n  ${binary} tunnel login\n` +
        `Then re-run pastepatch --mcp --setup-tunnel`,
    );
  }

  const result = await runCloudflared(binary, ["tunnel", "login"], {
    inheritStdio: true,
    logger,
  });

  if (result.code !== 0) {
    throw new Error(
      `cloudflared tunnel login failed (exit ${result.code}).\n` +
        `Run manually: ${binary} tunnel login`,
    );
  }

  if (!(await isCloudflaredAuthenticated())) {
    throw new Error(
      `cloudflared tunnel login finished but ${certPemPath()} was not created.\n` +
        `Complete the browser login (select a domain on Cloudflare), then try again.`,
    );
  }

  process.stderr.write("Authenticated. cert.pem saved under ~/.cloudflared/\n");
}

/**
 * Create a named tunnel or reuse an existing one with the same name.
 * Returns { tunnelId, tunnelName, credentialsFile }.
 */
export async function ensureNamedTunnel({ binary, tunnelName = DEFAULT_TUNNEL_NAME, logger = async () => {} }) {
  const existing = await findTunnelByName(binary, tunnelName, logger);
  if (existing) {
    process.stderr.write(`Reusing existing tunnel "${tunnelName}" (${existing.tunnelId}).\n`);
    const credentialsFile = await resolveCredentialsFile(existing.tunnelId);
    if (!(await pathExists(credentialsFile))) {
      throw new Error(
        `Tunnel "${tunnelName}" exists (${existing.tunnelId}) but credentials file is missing:\n  ${credentialsFile}\n` +
          `Delete it in the Cloudflare dashboard or with:\n  ${binary} tunnel delete -f ${tunnelName}\n` +
          `Then re-run setup so credentials can be regenerated with tunnel create.`,
      );
    }
    return { ...existing, credentialsFile };
  }

  process.stderr.write(`Creating Cloudflare tunnel "${tunnelName}"...\n`);
  const result = await runCloudflared(binary, ["tunnel", "create", tunnelName], { logger });

  if (result.code !== 0) {
    // Race: created elsewhere
    const again = await findTunnelByName(binary, tunnelName, logger);
    if (again) {
      const credentialsFile = await resolveCredentialsFile(again.tunnelId);
      return { ...again, credentialsFile };
    }
    throw new Error(
      `cloudflared tunnel create failed:\n${result.stderr || result.stdout}\n` +
        `Ensure cloudflared is logged in (cert.pem) and your account can create tunnels.`,
    );
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  // Typical: "Created tunnel pastepatch with id 6ff42ae2-..."
  // and "Tunnel credentials written to /path/....json"
  const idMatch =
    combined.match(/Created tunnel .+ with id ([0-9a-f-]{36})/i) ||
    combined.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  const credMatch = combined.match(/credentials written to\s+(.+\.json)/i);

  let tunnelId = idMatch?.[1];
  let credentialsFile = credMatch?.[1]?.trim();

  if (!tunnelId) {
    const listed = await findTunnelByName(binary, tunnelName, logger);
    tunnelId = listed?.tunnelId;
  }

  if (!tunnelId) {
    throw new Error(`Could not parse tunnel id from cloudflared create output:\n${combined}`);
  }

  if (!credentialsFile) {
    credentialsFile = await resolveCredentialsFile(tunnelId);
  }

  if (!(await pathExists(credentialsFile))) {
    throw new Error(`Tunnel created but credentials file not found at ${credentialsFile}`);
  }

  process.stderr.write(`Created tunnel ${tunnelName} (${tunnelId}).\n`);
  return { tunnelId, tunnelName, credentialsFile };
}

export async function resolveCredentialsFile(tunnelId) {
  return path.join(defaultCloudflaredDir(), `${tunnelId}.json`);
}

/**
 * Parse `cloudflared tunnel list` for a tunnel by name.
 * Output columns typically: ID NAME CREATED CONNECTIONS
 */
export async function findTunnelByName(binary, tunnelName, logger = async () => {}) {
  const result = await runCloudflared(binary, ["tunnel", "list"], { logger });
  if (result.code !== 0) {
    // Not authenticated etc.
    return null;
  }

  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^ID\b/i.test(line) || line.startsWith("-")) {
      continue;
    }
    // UUID then name
    const match = line.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/i,
    );
    if (match && match[2] === tunnelName) {
      return { tunnelId: match[1], tunnelName: match[2] };
    }
  }
  return null;
}

/**
 * Create/update DNS CNAME hostname → <uuid>.cfargotunnel.com
 * @see https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/
 */
export async function routeDnsToTunnel({ binary, tunnelNameOrId, hostname, logger = async () => {} }) {
  process.stderr.write(`Routing DNS ${hostname} → tunnel ${tunnelNameOrId}...\n`);
  // --overwrite-dns / -f replaces an existing record for this hostname when present
  const result = await runCloudflared(
    binary,
    ["tunnel", "route", "dns", "--overwrite-dns", tunnelNameOrId, hostname],
    { logger },
  );

  if (result.code !== 0) {
    const message = `${result.stderr || result.stdout}`.trim();
    // Some versions already have the correct route
    if (/already exists|already configured|CNAME.*already/i.test(message)) {
      process.stderr.write(`DNS route already present for ${hostname}.\n`);
      return;
    }
    throw new Error(
      `Failed to create DNS route for ${hostname}:\n${message}\n\n` +
        `Checks:\n` +
        `  - Domain is on Cloudflare DNS (nameservers at Cloudflare)\n` +
        `  - You selected that domain during cloudflared tunnel login\n` +
        `  - Hostname is under that zone (e.g. mcp.example.com for example.com)`,
    );
  }

  process.stderr.write(`DNS CNAME created/updated for ${hostname}.\n`);
}

/**
 * Ask only for the subdomain label when the authenticated zone is known.
 * Falls back to full hostname prompt if zone cannot be resolved.
 */
export async function promptForPublicHostname({
  zoneName = "",
  defaultSubdomain = "pastepatch",
  defaultHostname = "",
  packageName = "pastepatch",
} = {}) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Hostname is required non-interactively. Pass --hostname <subdomain or FQDN>, e.g.\n` +
        `  ${packageName} --mcp --setup-tunnel --hostname pastepatch\n` +
        `  ${packageName} --mcp --setup-tunnel --hostname pastepatch.example.com`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (zoneName) {
      const existingSub =
        subdomainFromHostname(defaultHostname, zoneName) || defaultSubdomain || "pastepatch";
      process.stderr.write(`Authenticated Cloudflare zone: ${zoneName}\n`);
      const answer = await rl.question(
        `Subdomain for the MCP public URL [${existingSub}]: `,
      );
      const sub = (answer.trim() || existingSub).replace(/\.$/, "");
      // Allow pasting a full hostname by accident
      if (sub.includes(".")) {
        return normalizeHostnameInput(sub, zoneName);
      }
      return buildHostname(sub, zoneName);
    }

    const hint = defaultHostname || "pastepatch.yourdomain.com";
    const answer = await rl.question(`Public hostname for the MCP server [${hint}]: `);
    const value = (answer.trim() || defaultHostname || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    if (!value) {
      throw new Error("Hostname is required (e.g. pastepatch.example.com).");
    }
    return normalizeHostnameInput(value, "");
  } finally {
    rl.close();
  }
}

/** @deprecated use promptForPublicHostname */
export async function promptForHostname(options = {}) {
  return promptForPublicHostname({
    defaultHostname: options.defaultHostname,
    packageName: options.packageName,
  });
}

/**
 * Full automated setup: login → create tunnel → config → DNS → save pastepatch config.
 */
export async function setupTunnelInteractive({
  binary,
  hostname: hostnameArg = "",
  port = DEFAULT_PORT,
  tunnelName = DEFAULT_TUNNEL_NAME,
  packageName = "pastepatch",
  logger = async () => {},
  existingConfig = null,
} = {}) {
  await ensureCloudflaredLogin({ binary, logger });

  const zone = await resolveAuthenticatedZone({ logger });
  const zoneName = zone?.zoneName || existingConfig?.zoneName || "";
  if (zoneName) {
    process.stderr.write(`Using authenticated domain: ${zoneName}\n`);
  } else {
    process.stderr.write(
      "Could not auto-detect the Cloudflare zone from cert.pem; you may need a full hostname.\n",
    );
  }

  // Keep public subdomain aligned with tunnel name by default (e.g. pastepatch → pastepatch.zone)
  const defaultSubdomain =
    subdomainFromHostname(existingConfig?.hostname || "", zoneName) ||
    tunnelName ||
    DEFAULT_TUNNEL_NAME;

  let hostname = "";
  if (hostnameArg) {
    hostname = normalizeHostnameInput(hostnameArg, zoneName);
  } else if (existingConfig?.hostname && !process.stdin.isTTY) {
    hostname = existingConfig.hostname;
  } else {
    hostname = await promptForPublicHostname({
      zoneName,
      defaultSubdomain,
      defaultHostname: existingConfig?.hostname || "",
      packageName,
    });
  }

  const { tunnelId, tunnelName: name, credentialsFile } = await ensureNamedTunnel({
    binary,
    tunnelName,
    logger,
  });

  const configPath = await writeCloudflaredConfigFile({
    tunnelId,
    credentialsFile,
    hostname,
    port,
  });

  await routeDnsToTunnel({
    binary,
    tunnelNameOrId: name,
    hostname,
    logger,
  });

  const config = {
    version: CONFIG_VERSION,
    tunnelName: name,
    tunnelId,
    hostname,
    zoneName: zoneName || null,
    zoneId: zone?.zoneId || null,
    port,
    credentialsFile,
    cloudflaredConfigFile: configPath,
    updatedAt: new Date().toISOString(),
  };

  const savedPath = await saveTunnelConfig(config);
  await logger(`Saved tunnel config ${savedPath}`);

  return config;
}

/**
 * Start cloudflared for a locally-managed tunnel (credentials + config.yml).
 * Preferred path after --setup-tunnel.
 */
export function startCloudflaredWithConfig({
  binary = "cloudflared",
  configFile,
  tunnelIdOrName,
  logger = async () => {},
  verbose = false,
}) {
  if (!configFile) {
    throw new Error("cloudflared config file path is required.");
  }
  const args = ["tunnel", "--no-autoupdate", "--config", configFile, "run"];
  if (tunnelIdOrName) {
    args.push(tunnelIdOrName);
  }
  return spawnCloudflaredProcess({ binary, args, logger, label: "config", verbose });
}

/**
 * Start cloudflared with a remotely-managed tunnel token (dashboard token).
 * Still supported as an override via PASTEPATCH_TUNNEL_TOKEN.
 * @see https://developers.cloudflare.com/tunnel/setup/
 */
export function startCloudflaredWithToken({
  token,
  binary = "cloudflared",
  logger = async () => {},
  verbose = false,
}) {
  if (!token || typeof token !== "string") {
    throw new Error("Cloudflare tunnel token is required.");
  }
  const args = ["tunnel", "--no-autoupdate", "run", "--token", token];
  return spawnCloudflaredProcess({ binary, args, logger, label: "token", verbose });
}

/**
 * Keep a cloudflared process up across crashes without taking down the local MCP server.
 * kill() stops reconnects (used on Ctrl+C / stop_session).
 */
export function startCloudflaredWithReconnect({
  start,
  logger = async () => {},
  isShuttingDown = () => false,
  initialDelayMs = 1_000,
  maxDelayMs = 30_000,
} = {}) {
  if (typeof start !== "function") {
    throw new Error("startCloudflaredWithReconnect requires a start() factory.");
  }

  let current = null;
  let attempts = 0;
  let stopped = false;
  let timer = null;

  const spawnOnce = () => {
    if (stopped || isShuttingDown()) {
      return;
    }
    try {
      current = start();
    } catch (error) {
      scheduleRestart(error.message || String(error));
      return;
    }
    if (!current || !current.exitPromise) {
      scheduleRestart("start() did not return an exitPromise");
      return;
    }
    current.exitPromise.then(
      (info) => {
        const reason =
          info && (info.signal || info.code !== undefined)
            ? `exited code=${info.code ?? "null"} signal=${info.signal ?? "none"}`
            : "exited";
        scheduleRestart(reason);
      },
      (error) => {
        scheduleRestart(error?.message || String(error));
      },
    );
  };

  const scheduleRestart = (reason) => {
    if (stopped || isShuttingDown()) {
      return;
    }
    attempts += 1;
    const exp = Math.min(attempts - 1, 8);
    const delay = Math.min(initialDelayMs * 2 ** exp, maxDelayMs);
    const line = `cloudflared ended (${reason}); reconnecting in ${delay}ms (attempt ${attempts})`;
    process.stderr.write(`[tunnel] ${line}\n`);
    void logger(line);
    timer = setTimeout(spawnOnce, delay);
  };

  spawnOnce();

  return {
    get child() {
      return current?.child ?? null;
    },
    get attempts() {
      return attempts;
    },
    kill() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      current?.kill();
    },
  };
}

/** @deprecated use startCloudflaredWithToken */
export function startCloudflaredTunnel(options) {
  return startCloudflaredWithToken(options);
}

/**
 * cloudflared is chatty (INF spam + "stream canceled by remote" on normal client disconnects).
 * Default: silence those lines. --verbose shows everything. Always log non-noise ERRs.
 */
export function isNoisyCloudflaredLine(line) {
  const text = String(line);
  if (/\bINF\b/.test(text)) {
    return true;
  }
  if (/stream \d+ canceled by remote/i.test(text)) {
    return true;
  }
  if (/Request failed error="stream \d+ canceled by remote/i.test(text)) {
    return true;
  }
  if (/CONNECTIVITY PRE-CHECKS|SUMMARY: Environment is healthy|precheck /i.test(text)) {
    return true;
  }
  if (/Generated Connector ID|Initial protocol|ICMP proxy|metrics server|Tunnel connection curve/i.test(text)) {
    return true;
  }
  if (/Registered tunnel connection|Starting tunnel|Version |GOOS:|Settings: map|cloudflared will not automatically/i.test(text)) {
    return true;
  }
  return false;
}

function spawnCloudflaredProcess({ binary, args, logger, label, verbose = false }) {
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let settled = false;
  let resolveExit;
  let rejectExit;
  const exitPromise = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  const onData = (streamName) => (chunk) => {
    const text = chunk.toString("utf8").trimEnd();
    if (!text) {
      return;
    }
    for (const line of text.split("\n")) {
      if (!verbose && isNoisyCloudflaredLine(line)) {
        // Still keep a short trail in the pastepatch log file for debugging
        void logger(`cloudflared(${label}) quiet: ${line.slice(0, 200)}`);
        continue;
      }
      process.stderr.write(`[cloudflared] ${line}\n`);
      void logger(`cloudflared(${label}) ${streamName}: ${line.slice(0, 500)}`);
    }
  };

  child.stdout?.on("data", onData("stdout"));
  child.stderr?.on("data", onData("stderr"));

  child.on("error", (error) => {
    if (!settled) {
      settled = true;
      rejectExit(error);
    }
  });

  child.on("close", (code, signal) => {
    if (!settled) {
      settled = true;
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
        resolveExit({ code, signal });
      } else {
        rejectExit(
          new Error(
            `cloudflared exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
              "Check tunnel credentials, DNS route, and that the hostname matches the config.",
          ),
        );
      }
    }
  });

  return {
    child,
    exitPromise,
    kill() {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

/**
 * Run a cloudflared subcommand and capture output (or inherit stdio for login).
 */
export function runCloudflared(binary, args, { logger = async () => {}, inheritStdio = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    if (!inheritStdio) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      void logger(`cloudflared ${args.join(" ")} => ${code}`);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function formatSetupCompleteMessage({ config, packageName = "pastepatch" }) {
  const { hostname, port, tunnelName, tunnelId } = config;
  const mcpUrl = `https://${hostname}/mcp`;
  return [
    "",
    "Cloudflare Tunnel setup complete.",
    "",
    `  Tunnel name:  ${tunnelName}`,
    `  Tunnel id:    ${tunnelId}`,
    `  Hostname:     ${hostname}`,
    `  Local port:   ${port}`,
    `  Config:       ${pastepatchTunnelConfigPath()}`,
    `  cloudflared:  ${pastepatchCloudflaredConfigPath()}`,
    "",
    "Start MCP (from the project you want ChatGPT to edit):",
    "",
    `  ${packageName} --mcp`,
    "",
    "ChatGPT — New Plugin fields",
    "(Settings → Security and login → Developer mode ON, then Settings → Plugins → create)",
    "",
    padTable([
      ["Field", "Value"],
      ["Icon", "(optional — leave empty)"],
      ["Name", "Pastepatch"],
      ["Description", "Edit files on my local machine via pastepatch MCP"],
      ["Connection", "Server URL"],
      ["Server URL", mcpUrl],
      ["Authentication", "No Auth"],
      ["Risk checkbox", "Checked (I understand and want to continue)"],
    ]),
    "",
    "Then in a chat: + → Developer mode → enable Pastepatch.",
    "",
  ].join("\n");
}

/** Simple fixed-width two-column table for terminal output. */
export function padTable(rows) {
  if (!rows.length) {
    return "";
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col] ?? "").length)));
  return rows
    .map((row, index) => {
      const cells = row.map((cell, col) => String(cell ?? "").padEnd(widths[col]));
      const line = cells.join("  ");
      if (index === 0) {
        const rule = widths.map((w) => "-".repeat(w)).join("  ");
        return `${line}\n${rule}`;
      }
      return line;
    })
    .join("\n");
}

export function cloudflareSetupGuide({ hostname, port, packageName = "pastepatch" }) {
  // Kept for docs / tests; preferred path is automated --setup-tunnel
  const publicHost = hostname || "mcp.yourdomain.com";
  return `Automated setup (preferred)
==========================

1. Install cloudflared if needed:
     brew install cloudflared   # macOS

2. Run interactive setup (creates tunnel, DNS, saves config to ~/.pastepatch/):
     ${packageName} --mcp --setup-tunnel
     ${packageName} --mcp --setup-tunnel --hostname ${publicHost} --port ${port}

   This runs the official local-tunnel flow:
     cloudflared tunnel login
     cloudflared tunnel create pastepatch
     write ~/.pastepatch/cloudflared-config.yml
     cloudflared tunnel route dns pastepatch <hostname>

3. Start MCP (uses saved config automatically):
     ${packageName} --mcp

Docs: https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/
`;
}
