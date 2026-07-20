import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  buildCloudflaredConfigYaml,
  buildHostname,
  cloudflaredMissingError,
  formatSetupCompleteMessage,
  isNoisyCloudflaredLine,
  normalizeHostnameInput,
  padTable,
  pastepatchCloudflaredConfigPath,
  pastepatchTunnelConfigPath,
  subdomainFromHostname,
} from "../lib/tunnel.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(repoRoot, "bin", "cli.js");

test("cloudflared missing error tells user to install", () => {
  const message = cloudflaredMissingError({ packageName: "pastepatch" }).message;
  assert.match(message, /cloudflared is not installed/i);
  assert.match(message, /setup-tunnel/);
});

test("buildCloudflaredConfigYaml includes hostname, credentials, catch-all", () => {
  const yaml = buildCloudflaredConfigYaml({
    tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef",
    credentialsFile: "/Users/me/.cloudflared/6ff42ae2-765d-4adf-8112-31c55c1551ef.json",
    hostname: "mcp.example.com",
    port: 8787,
  });

  assert.match(yaml, /tunnel: 6ff42ae2-765d-4adf-8112-31c55c1551ef/);
  assert.match(yaml, /credentials-file: '\/Users\/me\/\.cloudflared\/6ff42ae2-765d-4adf-8112-31c55c1551ef\.json'/);
  assert.match(yaml, /hostname: 'mcp\.example\.com'/);
  assert.match(yaml, /service: 'http:\/\/127\.0\.0\.1:8787'/);
  assert.match(yaml, /http_status:404/);
});

test("--mcp without cloudflared exits with install instructions", async () => {
  const result = await runCli(["--mcp", "--no-tunnel"], {
    env: { PASTEPATCH_CLOUDFLARED: "0" },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cloudflared is not installed/i);
  assert.match(result.stderr, /setup-tunnel/);
});

test("config paths live under ~/.pastepatch", () => {
  assert.ok(pastepatchTunnelConfigPath().includes(".pastepatch"));
  assert.ok(pastepatchCloudflaredConfigPath().endsWith("cloudflared-config.yml"));
});

test("noisy cloudflared lines are filtered by default", () => {
  assert.equal(
    isNoisyCloudflaredLine(
      '2026-07-19T22:09:25Z ERR  error="stream 9 canceled by remote with error code 0"',
    ),
    true,
  );
  assert.equal(
    isNoisyCloudflaredLine(
      "2026-07-19T22:07:41Z INF Registered tunnel connection connIndex=0",
    ),
    true,
  );
  assert.equal(
    isNoisyCloudflaredLine("2026-07-19T22:07:41Z ERR Unable to reach the origin service"),
    false,
  );
});

test("hostname helpers build subdomain under authenticated zone", () => {
  assert.equal(buildHostname("pastepatch", "bartoszbak.org"), "pastepatch.bartoszbak.org");
  assert.equal(subdomainFromHostname("pastepatch.bartoszbak.org", "bartoszbak.org"), "pastepatch");
  assert.equal(normalizeHostnameInput("pastepatch", "bartoszbak.org"), "pastepatch.bartoszbak.org");
  assert.equal(
    normalizeHostnameInput("pastepatch.bartoszbak.org", "bartoszbak.org"),
    "pastepatch.bartoszbak.org",
  );
  assert.throws(() => buildHostname("bad.sub", "bartoszbak.org"), /Invalid subdomain/);
});

test("setup complete message includes ChatGPT field table with No Auth", () => {
  const text = formatSetupCompleteMessage({
    config: {
      hostname: "pastepatch.bartoszbak.org",
      port: 8787,
      tunnelName: "pastepatch",
      tunnelId: "e76b9047-0820-41ae-91e7-73306717addd",
    },
  });
  assert.match(text, /ChatGPT — New Plugin fields/);
  assert.match(text, /Authentication\s+No Auth/);
  assert.match(text, /https:\/\/pastepatch\.bartoszbak\.org\/mcp/);
  assert.match(text, /Connection\s+Server URL/);
  assert.match(text, /Name\s+Pastepatch/);
  assert.ok(padTable([["A", "B"], ["1", "2"]]).includes("A"));
});

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
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

    // If MCP starts successfully, kill after a short moment
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 800);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}
