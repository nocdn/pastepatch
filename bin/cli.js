#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describeCall, executeToolCall, validateToolCall } from "../lib/fs-ops.js";
import {
  createHistoryEntry,
  findDuplicateAppliedPlan,
  redactLargeFields,
  undoLatestChange,
} from "../lib/history.js";
import { acquireMcpLock, releaseMcpLock } from "../lib/mcp-lock.js";
import { startMcpHttpServer } from "../lib/mcp-server.js";
import { formatProjectBanner, resolveProjectRoot } from "../lib/project.js";
import {
  formatSetupCompleteMessage,
  loadTunnelConfig,
  requireCloudflaredBinary,
  saveTunnelConfig,
  setupTunnelInteractive,
  startCloudflaredWithConfig,
  startCloudflaredWithReconnect,
  startCloudflaredWithToken,
  writeCloudflaredConfigFile,
} from "../lib/tunnel.js";

async function main() {
  const packageInfo = await readPackageInfo();
  const logger = createLogger();

  try {
    const args = parseArgs(process.argv.slice(2), packageInfo);

    if (args.help) {
      process.stdout.write(args.mcp ? mcpHelpText(packageInfo) : helpText(packageInfo));
      return;
    }

    if (args.version) {
      process.stdout.write(`${packageInfo.version}\n`);
      return;
    }

    if (args.log) {
      await runLog();
      return;
    }

    if (args.undo) {
      await runUndo(logger);
      return;
    }

    if (args.init) {
      await runInit(args, packageInfo, logger);
      return;
    }

    if (args.edit) {
      await runEdit(args, logger);
      return;
    }

    if (args.mcp) {
      await runMcp(args, packageInfo, logger);
      return;
    }

    throw new Error(
      `Choose --init, --edit, --undo, --log, or --mcp. Run ${commandName(packageInfo)} --help for usage.`,
    );
  } catch (error) {
    await logger(`ERROR ${error.stack || error.message}`);
    if (!error.reported) {
      process.stderr.write(`Error: ${error.message}\n`);
    }
    process.stderr.write(`Log: ${logPath()}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv, packageInfo) {
  const args = {
    help: false,
    version: false,
    init: false,
    edit: false,
    undo: false,
    log: false,
    mcp: false,
    path: ".",
    pathExplicit: false,
    stdout: false,
    noClipboard: false,
    dryRun: false,
    yes: false,
    task: "",
    include: [],
    exclude: [],
    ingestArgs: [],
    port: process.env.PASTEPATCH_MCP_PORT ? Number(process.env.PASTEPATCH_MCP_PORT) : null,
    hostname: process.env.PASTEPATCH_MCP_HOSTNAME || "",
    tunnelToken: process.env.PASTEPATCH_TUNNEL_TOKEN || process.env.CLOUDFLARE_TUNNEL_TOKEN || "",
    tunnelName: process.env.PASTEPATCH_TUNNEL_NAME || "",
    noTunnel: false,
    setupTunnel: false,
    authToken: process.env.PASTEPATCH_MCP_TOKEN || "",
    noAuth: false,
    verbose: false,
    allowHome: false,
    allowOutside: false,
    /** null = auto (TTY + env), true = --color, false = --no-color */
    color: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }

    if (arg === "-v" || arg === "--version") {
      args.version = true;
      continue;
    }

    if (arg === "--init") {
      args.init = true;
      continue;
    }

    if (arg === "--edit") {
      args.edit = true;
      continue;
    }

    if (arg === "--undo") {
      args.undo = true;
      continue;
    }

    if (arg === "--log" || arg === "--last-log") {
      args.log = true;
      continue;
    }

    if (arg === "--mcp") {
      args.mcp = true;
      continue;
    }

    if (arg === "--setup-tunnel") {
      args.setupTunnel = true;
      args.mcp = true;
      continue;
    }

    if (arg === "--stdout") {
      args.stdout = true;
      continue;
    }

    if (arg === "--no-clipboard") {
      args.noClipboard = true;
      continue;
    }

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "-y" || arg === "--yes") {
      args.yes = true;
      continue;
    }

    if (arg === "--no-tunnel") {
      args.noTunnel = true;
      continue;
    }

    if (arg === "--no-auth") {
      args.noAuth = true;
      continue;
    }

    if (arg === "--verbose") {
      args.verbose = true;
      continue;
    }

    if (arg === "--no-color") {
      args.color = false;
      continue;
    }

    if (arg === "--color") {
      args.color = true;
      continue;
    }

    if (arg === "--path") {
      args.path = readOptionValue(argv, (index += 1), arg);
      args.pathExplicit = true;
      continue;
    }

    if (arg === "--allow-home") {
      args.allowHome = true;
      continue;
    }

    if (arg === "--allow-outside") {
      args.allowOutside = true;
      continue;
    }

    if (arg === "--port") {
      const raw = readOptionValue(argv, (index += 1), arg);
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port must be an integer 1-65535, got "${raw}".`);
      }
      args.port = port;
      continue;
    }

    if (arg === "--hostname") {
      args.hostname = readOptionValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "--tunnel-token") {
      args.tunnelToken = readOptionValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "--tunnel-name") {
      args.tunnelName = readOptionValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "--auth-token") {
      args.authToken = readOptionValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "-m" || arg === "--message" || arg === "--task") {
      args.task = readOptionValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "-i" || arg === "--include") {
      args.include.push(readOptionValue(argv, (index += 1), arg));
      continue;
    }

    if (arg === "-e" || arg === "--exclude") {
      args.exclude.push(readOptionValue(argv, (index += 1), arg));
      continue;
    }

    if (arg === "--") {
      args.ingestArgs.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown option "${arg}". Run ${commandName(packageInfo)} --help for usage.`,
      );
    }

    args.path = arg;
    args.pathExplicit = true;
  }

  const modes = [args.init, args.edit, args.undo, args.log, args.mcp].filter(Boolean).length;
  if (modes > 1) {
    throw new Error("Choose only one mode: --init, --edit, --undo, --log, or --mcp.");
  }

  return args;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function runInit(args, packageInfo, logger) {
  const root = path.resolve(args.path);
  await logger(`INIT root=${root}`);

  const task = args.task || (await readInitialTask());
  await logger(`INIT taskBytes=${Buffer.byteLength(task)}`);

  const digest = await runIngest(root, args, logger);
  const prompt = buildPrompt(packageInfo, root, digest, task);

  if (args.stdout || args.noClipboard) {
    process.stdout.write(prompt);
    if (!prompt.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }

  if (!args.noClipboard) {
    await copyToClipboard(prompt, logger);
    process.stderr.write("ChatGPT coding prompt copied to clipboard. Paste it into ChatGPT.\n");
  }

  await logger(`INIT complete promptBytes=${Buffer.byteLength(prompt)}`);
}

async function readInitialTask() {
  if (!process.stdin.isTTY) {
    return "";
  }

  process.stderr.write(
    "What do you want ChatGPT to implement in the first turn? Paste/type instructions, then press Enter on an empty line.\n",
  );

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const lines = [];

  try {
    for (;;) {
      const line = await rl.question("");
      if (line === "") {
        break;
      }
      lines.push(line);
    }
  } catch (error) {
    if (error.code !== "ERR_USE_AFTER_CLOSE") {
      throw error;
    }
  } finally {
    rl.close();
  }

  return lines.join("\n").trim();
}

async function runIngest(root, args, logger) {
  const ingestArgs = ["@nocdn/ingest", root, "--stdout"];

  for (const pattern of args.include) {
    ingestArgs.push("--include", pattern);
  }

  for (const pattern of args.exclude) {
    ingestArgs.push("--exclude", pattern);
  }

  ingestArgs.push(...args.ingestArgs);

  await logger(`INGEST bunx ${ingestArgs.map(shellQuote).join(" ")}`);

  try {
    if (process.platform === "win32" && !(await windowsCommandExists("bunx"))) {
      const error = new Error("bunx was not found on PATH.");
      error.code = "ENOENT";
      throw error;
    }
    return await runCommand("bunx", ingestArgs, { cwd: root });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await logger("INGEST bunx not found; falling back to npx -y @nocdn/ingest");
    return await runCommand("npx", ["-y", ...ingestArgs], { cwd: root });
  }
}

function buildPrompt(packageInfo, root, digest, task) {
  return `You are helping me code in ChatGPT, but you do not have live filesystem tools.

The codebase digest below is the current source of truth for this project at:
${root}

My requested change for your first response is:

${task || "No specific first-turn task was provided. Ask me what to change before producing a tool plan."}

We will keep using this same ChatGPT conversation for follow-up coding tasks. After you output a tool plan, I will apply it locally with the CLI and then report whether it succeeded. For follow-ups, use the original digest plus the tool plans that were applied as your working model of the repo. If uncertain, ask me to regenerate and paste a fresh --init digest.

When you propose code changes, put the JSON tool plan first, in one fenced json code block. Never put prose before the JSON code block.

After the JSON code block, you are encouraged to write freely. Treat this as a collaborative coding conversation: summarize what changed and why, list the files you touched, flag anything you were unsure about, ask me clarifying questions, suggest follow-ups, call out tests I should run, note assumptions you made, or raise anything else worth my attention. (By the way, that list was a list of suggestions, you don't have to do them every time, just when you think it's useful) Do not stay silent after the code block - the prose afterward is how we collaborate between turns.

The JSON must be either an array of tool calls or an object with a "tools" array. Each tool call must be an object with a "tool" field.

Available tools that my local ${packageInfo.name} CLI can execute:

1. create_file
   Creates or overwrites a UTF-8 text file.
   Required fields: "path", "content"

2. replace_in_file
   Replaces text inside a UTF-8 text file. Prefer this for edits to existing files.
   Required fields: "path", "old", "new"
   Optional fields: "replaceAll" (boolean, default false)
   Rules: "old" must be an exact string from the digest. If replaceAll is false, "old" must occur exactly once.

3. delete_file
   Deletes an existing file or empty/non-empty directory.
   Required fields: "path"

4. move_file
   Renames or moves a file/directory.
   Required fields: "from", "to"

5. append_to_file
   Appends UTF-8 text to a file, creating parent directories if needed.
   Required fields: "path", "content"

Example output:

\`\`\`json
[
  {
    "tool": "replace_in_file",
    "path": "README.md",
    "old": "old exact text",
    "new": "new exact text"
  },
  {
    "tool": "create_file",
    "path": "src/example.js",
    "content": "export const ok = true;\\n"
  }
]
\`\`\`

Important instructions:
- Before proposing changes, do thorough web research. Search the web liberally to confirm current, up-to-date API signatures, library versions, framework conventions, and best practices for whatever stack this project uses. Do not rely on stale training data when external APIs, SDKs, CLIs, or libraries are involved—verify against the latest official documentation. It is far better to over-research than to ship a tool plan based on outdated assumptions.
- Use relative paths only.
- Never use "." as a path.
- Never use paths containing ".." or absolute paths.
- Do not target symbolic links.
- Keep edits small and targeted.
- If you need to change an existing file, use replace_in_file with a large enough exact old string to be unique.
- Do not invent read/list/shell tools. You only have the tools above.
- Put the JSON tool plan first. Any explanation or answer must come after the code block, outside the code block.

CODEBASE DIGEST START

${digest}

CODEBASE DIGEST END
`;
}

async function runEdit(args, logger) {
  const root = process.cwd();
  const input = await readToolPlanInput();
  const calls = parseToolCalls(input);

  if (calls.length === 0) {
    throw new Error("No tool calls found in pasted input.");
  }

  process.stderr.write(`Parsed ${calls.length} tool call${calls.length === 1 ? "" : "s"}.\n`);
  for (const [index, call] of calls.entries()) {
    process.stderr.write(`${index + 1}. ${describeCall(call)}\n`);
  }

  try {
    await preflightToolCalls(calls, root);
  } catch (error) {
    if (Number.isInteger(error.callIndex)) {
      reportToolCallFailure({
        calls,
        failedIndex: error.callIndex,
        tool: error.callTool,
        detail: error.callDetail,
        appliedCount: 0,
        phase: "preflight",
      });
      await logger(`EDIT preflight failed at tool call ${error.callIndex + 1}: ${error.callDetail}`);
      error.reported = true;
    }
    throw error;
  }

  const duplicatePlan = await findDuplicateAppliedPlan(calls, root);

  if (args.dryRun) {
    if (duplicatePlan) {
      writeDuplicatePlanNotice(duplicatePlan);
    }
    process.stderr.write(`Dry run complete; no files changed.\nLog: ${logPath()}\n`);
    await logger("EDIT dry-run complete");
    return;
  }

  if (duplicatePlan) {
    writeDuplicatePlanNotice(duplicatePlan);
    await logger(`EDIT duplicate plan detected createdAt=${duplicatePlan.createdAt}`);

    if (!process.stdin.isTTY) {
      throw new Error(
        "Refusing to re-apply a tool plan that matches the most recent apply in this directory. Copy a new ChatGPT JSON block, or run pastepatch --edit interactively and answer y to confirm.",
      );
    }

    const confirmed = await confirm("Re-apply the same tool plan anyway? [y/N] ");
    if (!confirmed) {
      process.stderr.write("Aborted.\n");
      await logger("EDIT aborted duplicate plan");
      return;
    }
  } else if (!args.yes && process.stdin.isTTY) {
    const confirmed = await confirm("Apply these changes? [y/N] ");
    if (!confirmed) {
      process.stderr.write("Aborted.\n");
      await logger("EDIT aborted by user");
      return;
    }
  }

  const history = await createHistoryEntry(calls, root);
  await logger(`HISTORY saved ${history.path}`);

  for (const [index, call] of calls.entries()) {
    await logger(`TOOL ${index + 1}/${calls.length} ${JSON.stringify(redactLargeFields(call))}`);
    try {
      await executeToolCall(call, root);
    } catch (error) {
      reportToolCallFailure({
        calls,
        failedIndex: index,
        tool: call.tool || "unknown",
        detail: error.message,
        appliedCount: index,
        phase: "apply",
      });
      await logger(`EDIT apply failed at tool call ${index + 1}: ${error.message}`);
      error.reported = true;
      throw error;
    }
  }

  process.stderr.write(`Changes applied.\nUndo with: pastepatch --undo\nLog: ${logPath()}\n`);
  await logger("EDIT complete dryRun=false");
}

async function runUndo(logger) {
  const entry = await undoLatestChange(process.cwd());
  await logger(`UNDO ${entry.id}`);
  process.stderr.write(
    `Undid ${entry.calls.length} tool call${entry.calls.length === 1 ? "" : "s"} from ${entry.createdAt}.\nLog: ${logPath()}\n`,
  );
}

async function runMcp(args, packageInfo, logger) {
  const command = commandName(packageInfo);
  const binary = await requireCloudflaredBinary({ packageName: command });

  if (args.setupTunnel) {
    const existing = await loadTunnelConfig();
    const tunnelName = args.tunnelName || existing?.tunnelName || "pastepatch";
    const config = await setupTunnelInteractive({
      binary,
      hostname: args.hostname,
      port: args.port ?? existing?.port ?? 8787,
      tunnelName,
      packageName: command,
      logger,
      existingConfig: existing,
    });
    process.stdout.write(formatSetupCompleteMessage({ config, packageName: command }));
    return;
  }

  const root = await resolveProjectRoot({
    pathArg: args.path,
    pathExplicit: args.pathExplicit,
    allowHome: args.allowHome,
  });

  const saved = await loadTunnelConfig();
  const port = args.port ?? saved?.port ?? 8787;
  let hostname = (args.hostname || saved?.hostname || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const authToken = args.noAuth ? null : args.authToken || null;
  const envToken = args.tunnelToken || "";

  // Resolve how to run the tunnel: saved local credentials (preferred) or env token.
  let tunnelMode = null; // "config" | "token" | null
  let tunnelConfigFile = saved?.cloudflaredConfigFile || null;
  let tunnelIdOrName = saved?.tunnelId || saved?.tunnelName || null;

  if (!args.noTunnel) {
    if (envToken) {
      tunnelMode = "token";
    } else if (saved?.credentialsFile && saved?.tunnelId && saved?.hostname) {
      hostname = hostname || saved.hostname;
      // Refresh config.yml in case --port / hostname changed
      tunnelConfigFile = await writeCloudflaredConfigFile({
        tunnelId: saved.tunnelId,
        credentialsFile: saved.credentialsFile,
        hostname,
        port,
      });
      tunnelIdOrName = saved.tunnelId;
      tunnelMode = "config";
      if (saved.port !== port || saved.hostname !== hostname || saved.cloudflaredConfigFile !== tunnelConfigFile) {
        await saveTunnelConfig({
          ...saved,
          hostname,
          port,
          cloudflaredConfigFile: tunnelConfigFile,
          updatedAt: new Date().toISOString(),
        });
      }
    } else {
      throw new Error(
        `No Cloudflare tunnel configured yet.\n\n` +
          `Run one-time setup (creates tunnel + DNS + saves config to ~/.pastepatch/):\n` +
          `  ${command} --mcp --setup-tunnel\n\n` +
          `Or pass a dashboard tunnel token:\n` +
          `  ${command} --mcp --tunnel-token "$PASTEPATCH_TUNNEL_TOKEN"\n\n` +
          `For local-only testing without a public URL:\n` +
          `  ${command} --mcp --no-tunnel`,
      );
    }
  }

  if (args.allowOutside) {
    process.stderr.write(
      "WARNING: --allow-outside is enabled. MCP tools can read/write paths outside the project root.\n",
    );
  }

  // Single-instance guard: one tunnel/MCP pair per machine so ChatGPT does not
  // flip between processes when a second pastepatch --mcp is started.
  await acquireMcpLock({
    port,
    root,
    hostname,
    packageName: command,
  });
  let lockHeld = true;

  process.stderr.write(
    formatProjectBanner({
      root,
      port,
      hostname,
      verbose: args.verbose,
      noTunnel: args.noTunnel,
      allowOutside: args.allowOutside,
    }),
  );

  let tunnelHandle = null;
  let mcp = null;
  let shuttingDown = false;

  const releaseLock = async () => {
    if (!lockHeld) {
      return;
    }
    lockHeld = false;
    try {
      await releaseMcpLock();
    } catch (error) {
      await logger(`MCP lock release failed: ${error.message || error}`);
    }
  };

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`\nShutting down (${signal})...\n`);
    tunnelHandle?.kill();
    try {
      await mcp?.close();
    } catch {
      // ignore close races
    }
    await releaseLock();
    process.exit(0);
  };

  try {
    mcp = await startMcpHttpServer({
      root,
      port,
      host: "127.0.0.1",
      version: packageInfo.version,
      logger,
      authToken,
      allowedHosts: hostname ? [hostname] : [],
      verbose: args.verbose,
      allowOutside: args.allowOutside,
      onStopSession: () => shutdown("stop_session"),
      color: args.color,
    });
  } catch (error) {
    await releaseLock();
    throw error;
  }

  await logger(
    `MCP listening root=${root} port=${port} verbose=${args.verbose} allowOutside=${args.allowOutside}`,
  );

  if (tunnelMode === "config") {
    process.stderr.write("Starting Cloudflare Tunnel (local credentials + config)...\n");
    if (!args.verbose) {
      process.stderr.write("Tunnel logs quiet (pass --verbose for cloudflared/HTTP details).\n");
    }
    tunnelHandle = startCloudflaredWithReconnect({
      start: () =>
        startCloudflaredWithConfig({
          binary,
          configFile: tunnelConfigFile,
          tunnelIdOrName,
          logger,
          verbose: args.verbose,
        }),
      logger,
      isShuttingDown: () => shuttingDown,
    });
  } else if (tunnelMode === "token") {
    process.stderr.write("Starting Cloudflare Tunnel (token)...\n");
    if (!args.verbose) {
      process.stderr.write("Tunnel logs quiet (pass --verbose for cloudflared/HTTP details).\n");
    }
    tunnelHandle = startCloudflaredWithReconnect({
      start: () =>
        startCloudflaredWithToken({
          token: envToken,
          binary,
          logger,
          verbose: args.verbose,
        }),
      logger,
      isShuttingDown: () => shuttingDown,
    });
  } else {
    process.stderr.write("Tunnel disabled (--no-tunnel). MCP is only on localhost.\n");
  }

  if (hostname) {
    process.stderr.write(`Public MCP URL (ChatGPT): https://${hostname}/mcp\n`);
    process.stderr.write(`Legacy SSE URL: https://${hostname}/sse\n`);
  }

  if (authToken) {
    process.stderr.write(
      "Auth: Bearer token required (Authorization: Bearer …). ChatGPT developer mode usually uses No authentication — prefer Cloudflare Access or --no-auth for ChatGPT.\n",
    );
  } else {
    process.stderr.write(
      "Auth: none (suitable for ChatGPT No authentication). Anyone who can reach the public URL can call write tools.\n",
    );
  }

  process.stderr.write("Press Ctrl+C to stop.\n");

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // Keep process alive until signal
  await new Promise(() => {});
}

async function runLog() {
  try {
    process.stdout.write(await readFile(logPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      process.stdout.write(`No pastepatch log found at ${logPath()}\n`);
      return;
    }
    throw error;
  }
}

function writeDuplicatePlanNotice(entry) {
  process.stderr.write(
    `\nWarning: This tool plan matches the most recent pastepatch apply in this directory (${entry.createdAt}).\n` +
      "You may have forgotten to copy a new ChatGPT JSON block from ChatGPT.\n" +
      "Re-applying can fail (for example, replace_in_file) or repeat side effects (for example, append_to_file).\n",
  );
}

async function readToolPlanInput() {
  if (!process.stdin.isTTY) {
    return await readStream(process.stdin);
  }

  process.stderr.write("Reading ChatGPT JSON tool plan from clipboard...\n");
  const input = await readClipboard();

  if (!input.trim()) {
    throw new Error("Clipboard is empty. Copy ChatGPT's JSON tool plan, then run --edit again.");
  }

  return input;
}

async function readClipboard() {
  const commands = clipboardReadCommands();
  const errors = [];

  for (const [command, args] of commands) {
    try {
      return await runCommand(command, args);
    } catch (error) {
      errors.push(`${command}: ${error.message}`);
    }
  }

  throw new Error(
    `Could not read from the system clipboard. You can still pipe input with: ${clipboardPipeExample()}. ${errors.join(" ")}`,
  );
}

function clipboardReadCommands() {
  if (process.platform === "darwin") {
    return [["pbpaste", []]];
  }

  if (process.platform === "win32") {
    const script = `${windowsPowerShellUtf8Setup()} Get-Clipboard -Raw`;
    return [
      ["powershell.exe", windowsPowerShellArgs(script)],
      ["pwsh.exe", windowsPowerShellArgs(script)],
    ];
  }

  return [
    ["wl-paste", []],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ];
}

function parseToolCalls(input) {
  const candidates = extractJsonCandidates(input);
  const errors = [];

  for (const candidate of candidates) {
    try {
      return normalizeToolPlan(JSON.parse(candidate));
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(
    `Clipboard/input does not contain a valid JSON tool plan. Copy ChatGPT's fenced json code block using the code block copy button, then run --edit again. ${errors.join(" ")}`.trim(),
  );
}

function extractJsonCandidates(input) {
  const candidates = [];
  const fencePattern = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let match;

  while ((match = fencePattern.exec(input)) !== null) {
    candidates.push(match[1].trim());
  }

  const trimmed = input.trim();
  if (trimmed) {
    candidates.push(trimmed);
  }

  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray !== -1 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1));
  }

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject !== -1 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }

  return [...new Set(candidates)];
}

function normalizeToolPlan(plan) {
  const rawCalls = Array.isArray(plan) ? plan : plan.tools || plan.tool_calls || plan.calls;

  if (!Array.isArray(rawCalls)) {
    throw new Error("Tool plan must be an array or an object with a tools array.");
  }

  return rawCalls.map((call) => {
    if (!call || typeof call !== "object") {
      throw new Error("Each tool call must be an object.");
    }

    const tool = call.tool || call.name;
    const args = normalizeCallArguments(call);

    if (!tool || typeof tool !== "string") {
      throw new Error("Each tool call needs a string tool field.");
    }

    return { ...args, tool };
  });
}

function normalizeCallArguments(call) {
  if (!Object.prototype.hasOwnProperty.call(call, "arguments")) {
    return call;
  }

  if (typeof call.arguments === "string") {
    return JSON.parse(call.arguments);
  }

  if (call.arguments && typeof call.arguments === "object") {
    return call.arguments;
  }

  throw new Error("Tool call arguments must be an object or JSON object string.");
}

async function preflightToolCalls(calls, root = process.cwd()) {
  for (const [index, call] of calls.entries()) {
    try {
      await validateToolCall(call, root);
    } catch (error) {
      const wrapped = new Error(`Tool call ${index + 1} (${call.tool || "unknown"}): ${error.message}`);
      wrapped.callIndex = index;
      wrapped.callDetail = error.message;
      wrapped.callTool = call.tool || "unknown";
      throw wrapped;
    }
  }
}

// Collapse a sorted list of 1-based numbers into compact ranges,
// e.g. [1,2,3,5,6,9] -> "1-3, 5-6, 9".
function formatNumberRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;

  for (const value of sorted) {
    if (start === null) {
      start = value;
      prev = value;
      continue;
    }
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = value;
    prev = value;
  }

  if (start !== null) {
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  }

  return parts.join(", ");
}

function reportToolCallFailure({ calls, failedIndex, tool, detail, appliedCount, phase }) {
  const total = calls.length;
  const failedNumber = failedIndex + 1;

  process.stderr.write(`\nTool call ${failedNumber} (${tool}): error\n`);
  process.stderr.write(`${detail}\n\n`);

  const applied = [];
  for (let i = 1; i <= appliedCount; i += 1) {
    applied.push(i);
  }

  const notApplied = [];
  for (let i = failedNumber + 1; i <= total; i += 1) {
    notApplied.push(i);
  }

  if (applied.length > 0) {
    const label = applied.length === 1 ? "Tool call" : "Tool calls";
    process.stderr.write(`${label} ${formatNumberRanges(applied)}: applied successfully\n`);
  }

  process.stderr.write(`Tool call ${failedNumber}: failed (not applied)\n`);

  if (notApplied.length > 0) {
    const label = notApplied.length === 1 ? "Tool call" : "Tool calls";
    process.stderr.write(`${label} ${formatNumberRanges(notApplied)}: not applied\n`);
  }

  if (phase === "preflight") {
    process.stderr.write(`\nNo changes were applied (validation failed before any files were edited).\n`);
  } else if (applied.length > 0) {
    process.stderr.write(`\nThe first ${applied.length} change${applied.length === 1 ? " is" : "s are"} already written to disk. Undo with: pastepatch --undo\n`);
  }
}

async function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(message);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function copyToClipboard(text, logger) {
  const commands = clipboardWriteCommands();
  const errors = [];

  for (const [command, args] of commands) {
    try {
      await runCommand(command, args, { input: text });
      return;
    } catch (error) {
      errors.push(`${command}: ${error.message}`);
      await logger(`CLIPBOARD failed command=${command} error=${error.message}`);
    }
  }

  process.stdout.write(text);
  if (!text.endsWith("\n")) {
    process.stdout.write("\n");
  }
  process.stderr.write(
    `Could not copy to clipboard, so the prompt was printed to stdout instead. ${errors.join(" ")}\n`,
  );
}

function clipboardWriteCommands() {
  if (process.platform === "darwin") {
    return [["pbcopy", []]];
  }

  if (process.platform === "win32") {
    const script = `${windowsPowerShellUtf8Setup()} $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text`;
    return [
      ["powershell.exe", windowsPowerShellArgs(script)],
      ["pwsh.exe", windowsPowerShellArgs(script)],
      ["clip.exe", []],
    ];
  }

  return [["xclip", ["-selection", "clipboard"]]];
}

function clipboardPipeExample() {
  if (process.platform === "darwin") {
    return "pbpaste | pastepatch --edit";
  }

  if (process.platform === "win32") {
    return "Get-Clipboard -Raw | pastepatch --edit";
  }

  return "wl-paste | pastepatch --edit";
}

function windowsPowerShellArgs(script) {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

function windowsPowerShellUtf8Setup() {
  return [
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false);",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
  ].join(" ");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnConfig = commandSpawnConfig(command, args);
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: options.cwd || process.cwd(),
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      ...spawnConfig.options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const error = new Error(`${command} exited with code ${code}: ${stderr.trim()}`);
      error.code = code;
      reject(error);
    });

    if (options.input) {
      child.stdin.end(options.input);
    }
  });
}

async function windowsCommandExists(command) {
  try {
    await runCommand("where.exe", [command]);
    return true;
  } catch {
    return false;
  }
}

function commandSpawnConfig(command, args) {
  if (process.platform !== "win32" || isDirectlySpawnableWindowsCommand(command)) {
    return { command, args, options: {} };
  }

  const commandLine = [command, ...args].map(quoteWindowsCmdArgument).join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function isDirectlySpawnableWindowsCommand(command) {
  const extension = path.extname(command).toLowerCase();
  return extension === ".exe" || extension === ".com";
}

function quoteWindowsCmdArgument(value) {
  const string = String(value);
  if (string.length === 0) {
    return "\"\"";
  }

  let quoted = "\"";
  let backslashes = 0;

  for (const character of string) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }

    if (character === "\"") {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += character;
      backslashes = 0;
      continue;
    }

    quoted += "\\".repeat(backslashes);
    backslashes = 0;
    quoted += character;
  }

  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    let value = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      value += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(value));
  });
}

function createLogger() {
  return async (message) => {
    await mkdir(path.dirname(logPath()), { recursive: true });
    await appendFile(logPath(), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  };
}

function logPath() {
  return path.join(process.cwd(), ".pastepatch.log");
}

function shellQuote(value) {
  return /[^A-Za-z0-9_/:=.,@+-]/.test(value) ? JSON.stringify(value) : value;
}

async function readPackageInfo() {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const rawPackageJson = await readFile(packageJsonPath, "utf8");
  return JSON.parse(rawPackageJson);
}

function commandName(packageInfo) {
  if (packageInfo.bin && typeof packageInfo.bin === "object" && !Array.isArray(packageInfo.bin)) {
    const [name] = Object.keys(packageInfo.bin);
    if (name) {
      return name;
    }
  }

  return packageInfo.name;
}

function helpText(packageInfo) {
  const command = commandName(packageInfo);
  const description = packageInfo.description || "";
  const editDryRunExample =
    process.platform === "win32"
      ? `Get-Content -Raw .\\chatgpt-tools.json | ${command} --edit --dry-run`
      : `${command} --edit --dry-run < chatgpt-tools.json`;
  const editYesExample =
    process.platform === "win32"
      ? `Get-Content -Raw .\\chatgpt-tools.json | ${command} --edit --yes`
      : `${command} --edit --yes < chatgpt-tools.json`;

  return `${command} ${packageInfo.version}
${description ? `\n${description}\n` : ""}
Usage:
  ${command} --init [path] [options] [-- ingest-options]
  ${command} --edit [options]
  ${command} --undo
  ${command} --log
  ${command} --mcp [path] [options]
  ${command} --mcp --setup-tunnel
  ${command} --mcp -h
  ${command} --help
  ${command} --version

Examples:
  ${command} --init
  ${command} --init ../my-app --exclude node_modules -- --line-numbers
  ${command} --init --stdout > chatgpt-prompt.txt
  ${command} --edit
  ${editDryRunExample}
  ${editYesExample}
  ${command} --undo
  ${command} --log
  ${command} --mcp
  ${command} --mcp --setup-tunnel
  ${command} --mcp --path ./my-app
  ${command} --help
  ${command} --mcp -h

Modes:
  --init                           Generate the initial ChatGPT coding prompt with a codebase digest.
  --edit                           Apply the ChatGPT JSON tool plan currently on the clipboard.
  --undo                           Undo the most recent applied pastepatch change set.
  --log, --last-log                Print the pastepatch log for the current directory.
  --mcp                            Start MCP server + Cloudflare Tunnel for live ChatGPT tools.

--init options:
  --path <path>                    Project path (positional path also works). Default: current directory.
  -m, --message, --task <text>      First-turn instructions instead of asking interactively.
  -i, --include <pattern>          Forward an include pattern to @nocdn/ingest. Repeatable.
  -e, --exclude <pattern>          Forward an exclude pattern to @nocdn/ingest. Repeatable.
  --stdout                         Print the prompt to stdout (still copies unless --no-clipboard).
  --no-clipboard                   Do not copy the prompt; print to stdout instead.
  --                               Forward remaining args to @nocdn/ingest.

--edit options:
  --dry-run                        Validate/preview tool calls without changing files.
  -y, --yes                        Apply without prompting (except duplicate last plan).

--mcp options:
  Run \`${command} --mcp -h\` for the full MCP-only option list.

Global:
  -h, --help                       Show this full help (all modes).
  -v, --version                    Show the package version.

Notes:
  --init runs: bunx @nocdn/ingest <path> --stdout, falling back to npx -y if bunx is unavailable.
  --edit reads from the clipboard when interactive, or stdin when piped (${clipboardPipeExample()}).
  --edit/--mcp write details to .pastepatch.log in the current directory.
  Paths for --edit are sandboxed to the current directory (no absolute paths, no "..").
`;
}

function mcpHelpText(packageInfo) {
  const command = commandName(packageInfo);
  return `${command} ${packageInfo.version} — MCP mode

Usage:
  ${command} --mcp [path] [options]
  ${command} --mcp --setup-tunnel [options]
  ${command} --mcp -h
  ${command} --mcp --help

Examples:
  ${command} --mcp
  ${command} --mcp --path ~/code/my-app
  ${command} --mcp --setup-tunnel
  ${command} --mcp --setup-tunnel --hostname pastepatch
  ${command} --mcp --no-tunnel
  ${command} --mcp --verbose
  ${command} --mcp --no-color
  ${command} --mcp --allow-outside

Options:
  --mcp                            Start the pastepatch MCP server (required for this help page).
  --setup-tunnel                   One-time Cloudflare tunnel setup (login, DNS, save ~/.pastepatch/).
  --path <path>                    Project root to bind tools to. Positional path works. Default: cwd.
  --port <n>                       Listen port (default 8787, or saved / PASTEPATCH_MCP_PORT).
  --hostname <host>                Setup: subdomain (pastepatch) or FQDN. Env: PASTEPATCH_MCP_HOSTNAME.
  --tunnel-name <name>             Setup tunnel name (default pastepatch; also default subdomain).
  --tunnel-token <token>           Optional dashboard token override. Env: PASTEPATCH_TUNNEL_TOKEN.
  --no-tunnel                      Localhost MCP only (still requires cloudflared installed).
  --auth-token <token>             Require Authorization: Bearer. Env: PASTEPATCH_MCP_TOKEN.
  --no-auth                        Disable bearer auth (default; use ChatGPT "No Auth").
  --verbose                        Cloudflared/HTTP logs + replace/create payload previews.
  --color                          Force color on MCP tool logs (even when not a TTY).
  --no-color                       Disable color on MCP tool logs (also respects NO_COLOR).
  --allow-home                     Allow binding project root to $HOME or filesystem root.
  --allow-outside                  Disable path sandbox (allow absolute paths and paths outside the project).
                                   Default is sandboxed: cannot read/create/edit/delete outside the bound root.
  -h, --help                       Show this MCP-only help (when combined with --mcp).

Sandbox (default ON):
  Tools only operate inside the bound project directory (and its subfolders).
  Relative paths only; absolute paths and ".." are rejected.
  Pass --allow-outside to lift this restriction (dangerous).

Notes:
  Requires cloudflared. First time: ${command} --mcp --setup-tunnel
  Then: ${command} --mcp   (starts local MCP + tunnel from ~/.pastepatch/)
  Only one --mcp process at a time (~/.pastepatch/mcp.lock). Stop the other first
  (Ctrl+C, stop_session tool, or kill <pid>) so the tunnel/ChatGPT connection stays stable.
  ChatGPT plugin URL: https://<hostname>/mcp   Authentication: No Auth
  For full CLI help (all modes): ${command} --help
`;
}

main();
