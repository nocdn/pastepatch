import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer } from "../lib/mcp-server.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(repoRoot, "bin", "cli.js");
const tempDirectories = [];

test.after(async () => {
  await Promise.all(tempDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pastepatch-mcp-"));
  tempDirectories.push(root);
  await writeFile(path.join(root, "README.md"), "hello world\n", "utf8");
  return root;
}

test("--setup-tunnel without cloudflared fails with install instructions", async () => {
  const result = await runCli(["--mcp", "--setup-tunnel", "--hostname", "mcp.example.com"], {
    env: { PASTEPATCH_CLOUDFLARED: "0" },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cloudflared is not installed/i);
});

test("MCP tools can read and write files under the project root", async () => {
  const root = await tempProject();
  const port = await freePort();
  const server = await startMcpHttpServer({
    root,
    port,
    host: "127.0.0.1",
    version: "test",
  });

  try {
    const client = new Client({ name: "pastepatch-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("create_file"));
    assert.ok(names.includes("replace_in_file"));

    const read = await client.callTool({ name: "read_file", arguments: { path: "README.md" } });
    assert.equal(read.isError, undefined);
    assert.match(toolText(read), /hello world/);

    const create = await client.callTool({
      name: "create_file",
      arguments: { path: "src/note.txt", content: "from mcp\n" },
    });
    assert.equal(create.isError, undefined);
    assert.equal(await readFile(path.join(root, "src", "note.txt"), "utf8"), "from mcp\n");

    const replace = await client.callTool({
      name: "replace_in_file",
      arguments: { path: "README.md", old: "hello world", new: "hello mcp" },
    });
    assert.equal(replace.isError, undefined);
    assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "hello mcp\n");

    const bad = await client.callTool({
      name: "read_file",
      arguments: { path: "../outside.txt" },
    });
    assert.equal(bad.isError, true);
    assert.match(toolText(bad), /\.\./);

    await client.close();
  } finally {
    await server.close();
  }
});

test("MCP healthz is available", async () => {
  const root = await tempProject();
  const port = await freePort();
  const server = await startMcpHttpServer({ root, port, host: "127.0.0.1", version: "test" });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.mcp, "/mcp");
  } finally {
    await server.close();
  }
});

function toolText(result) {
  return (result.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

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
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
