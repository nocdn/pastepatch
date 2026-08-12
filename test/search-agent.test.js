import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHandoffReport,
  buildStartHereGuide,
  loadProjectAgentsMd,
} from "../lib/agent-prompt.js";
import { formatProjectBanner, resolveProjectRoot } from "../lib/project.js";
import { findFiles, searchContent } from "../lib/search.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer } from "../lib/mcp-server.js";
import { resolveToolPath, validateToolCall } from "../lib/fs-ops.js";

const tempDirectories = [];

test.after(async () => {
  await Promise.all(tempDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pastepatch-search-"));
  tempDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "hello unique-token-xyz\n", "utf8");
  await writeFile(path.join(root, "src", "app.js"), "export const uniqueTokenXyz = 1;\n", "utf8");
  return root;
}

test("searchContent finds matches under project root", async () => {
  const root = await tempProject();
  const result = await searchContent({ root, pattern: "unique-token-xyz" });
  assert.match(result.output, /README\.md/);
  assert.ok(result.engine === "rg" || result.engine === "grep");
});

test("findFiles finds files by name", async () => {
  const root = await tempProject();
  const result = await findFiles({ root, pattern: "app.js" });
  assert.match(result.output, /src\/app\.js|src\\app\.js/);
  assert.ok(result.engine === "fd" || result.engine === "fdfind" || result.engine === "find");
});

test("start_here guide mentions tools and project root", () => {
  const guide = buildStartHereGuide({ root: "/tmp/proj", version: "1.1.1" });
  assert.match(guide, /\/tmp\/proj/);
  assert.match(guide, /ChatGPT/i);
  assert.match(guide, /MCP/);
  assert.match(guide, /start_here/);
  assert.match(guide, /search/);
  assert.match(guide, /replace_in_file/);
  assert.match(guide, /handoff/);
  assert.match(guide, /list_remote_skills/);
  assert.match(guide, /read_remote_skill/);
  assert.match(guide, /stop_session/);
  assert.match(guide, /view_image/);
  assert.doesNotMatch(guide, /local coding agent/i);
  assert.doesNotMatch(guide, /## AGENTS\.md guidance/);
});

test("start_here guide appends AGENTS.md verbatim when provided", () => {
  const agentsMd = "# Project rules\n\n- Prefer small diffs\n- Never invent APIs\n";
  const guide = buildStartHereGuide({
    root: "/tmp/proj",
    version: "1.1.1",
    agentsMd,
  });
  assert.match(guide, /## AGENTS\.md guidance/);
  assert.match(guide, /authoritative project-specific agent instructions/i);
  assert.ok(guide.endsWith(agentsMd) || guide.includes(agentsMd));
  // Verbatim: exact body appears after the guidance intro (not fenced away).
  const idx = guide.indexOf("## AGENTS.md guidance");
  assert.ok(idx >= 0);
  const section = guide.slice(idx);
  assert.match(section, /# Project rules/);
  assert.match(section, /- Prefer small diffs/);
  assert.match(section, /- Never invent APIs/);
  assert.doesNotMatch(section, /```[\s\S]*# Project rules/);
});

test("loadProjectAgentsMd reads file and follows symlinks", async () => {
  const root = await tempProject();
  assert.equal(await loadProjectAgentsMd(root), null);

  const body = "Use conventional commits.\nKeep PRs small.\n";
  await writeFile(path.join(root, "AGENTS.md"), body, "utf8");
  assert.equal(await loadProjectAgentsMd(root), body);

  const root2 = await tempProject();
  const target = path.join(root2, "docs", "agent-rules.md");
  await mkdir(path.dirname(target), { recursive: true });
  const linkedBody = "Linked AGENTS rules for unique-token-agents-md.\n";
  await writeFile(target, linkedBody, "utf8");
  await symlink(target, path.join(root2, "AGENTS.md"));
  assert.equal(await loadProjectAgentsMd(root2), linkedBody);
});

test("handoff report is wrapped in a markdown code block", () => {
  const report = buildHandoffReport({
    root: "/tmp/proj",
    achieved: "Added search tools",
    files: "lib/search.js",
    changes: "Implemented rg/grep fallback",
    userGuidance: "Use ripgrep",
    remember: "Port 8787",
    important: "P0: stay in project root",
    nextSteps: "Publish package",
  });
  assert.ok(report.startsWith("```markdown\n"));
  assert.ok(report.trimEnd().endsWith("```"));
  assert.match(report, /What we achieved/);
  assert.match(report, /Added search tools/);
  assert.match(report, /\/tmp\/proj/);
});

test("resolveProjectRoot refuses home without explicit path", async () => {
  await assert.rejects(
    () => resolveProjectRoot({ pathArg: os.homedir(), pathExplicit: false }),
    /Refusing to bind MCP/,
  );
  const root = await resolveProjectRoot({ pathArg: os.homedir(), pathExplicit: true });
  assert.equal(root, path.resolve(os.homedir()));
});

test("project banner includes Editing path", () => {
  const banner = formatProjectBanner({
    root: "/tmp/my-app",
    port: 8787,
    hostname: "pastepatch.example.com",
  });
  assert.match(banner, /Editing:\s+\/tmp\/my-app/);
  assert.match(banner, /pastepatch\.example\.com\/mcp/);
  assert.match(banner, /Sandbox:\s+ON/);
  // Banner body is not indented (only the frame is decorative)
  assert.match(banner, /^pastepatch MCP$/m);
  assert.match(banner, /^Editing:/m);
  assert.doesNotMatch(banner, /^ {2}pastepatch MCP$/m);
});

test("path sandbox blocks outside paths by default", async () => {
  const root = await tempProject();
  assert.throws(() => resolveToolPath("../secret.txt", root), /\.\./);
  assert.throws(() => resolveToolPath("/etc/passwd", root), /absolute/i);
  await assert.rejects(
    () => validateToolCall({ tool: "create_file", path: "../out.txt", content: "x" }, root),
    /\.\./,
  );
});

test("path sandbox allows outside paths with allowOutside", async () => {
  const root = await tempProject();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pastepatch-out-"));
  tempDirectories.push(outsideDir);
  const outside = path.join(outsideDir, "secret.txt");
  const abs = resolveToolPath(outside, root, { allowOutside: true });
  assert.equal(abs, path.resolve(outside));
  await validateToolCall(
    { tool: "create_file", path: outside, content: "ok\n" },
    root,
    { allowOutside: true },
  );
});

test("MCP exposes search, find_files, start_here, handoff", async () => {
  const root = await tempProject();
  const port = await freePort();
  const server = await startMcpHttpServer({ root, port, host: "127.0.0.1", version: "test" });

  try {
    const client = new Client({ name: "pastepatch-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const name of [
      "search",
      "find_files",
      "start_here",
      "handoff",
      "read_file",
      "list_remote_skills",
      "read_remote_skill",
      "stop_session",
      "view_image",
    ]) {
      assert.ok(names.has(name), `missing tool ${name}`);
    }

    const start = await client.callTool({ name: "start_here", arguments: {} });
    assert.equal(start.isError, undefined);
    assert.match(toolText(start), /ChatGPT/i);
    assert.match(toolText(start), /MCP/);
    assert.doesNotMatch(toolText(start), /## AGENTS\.md guidance/);

    const search = await client.callTool({
      name: "search",
      arguments: { pattern: "uniqueTokenXyz" },
    });
    assert.equal(search.isError, undefined);
    assert.match(toolText(search), /app\.js/);

    const handoff = await client.callTool({
      name: "handoff",
      arguments: {
        achieved: "Tested tools",
        files: "src/app.js",
        changes: "None",
        user_guidance: "Add search",
        remember: "Use rg",
        important: "P0 sandbox",
      },
    });
    assert.equal(handoff.isError, undefined);
    assert.match(toolText(handoff), /```markdown/);

    await client.close();
  } finally {
    await server.close();
  }
});

test("MCP start_here includes project AGENTS.md when present", async () => {
  const root = await tempProject();
  const agentsBody =
    "# Repo agent rules\n\nAlways run tests after edits.\nunique-agents-md-token-abc\n";
  await writeFile(path.join(root, "AGENTS.md"), agentsBody, "utf8");

  const port = await freePort();
  const server = await startMcpHttpServer({ root, port, host: "127.0.0.1", version: "test" });

  try {
    const client = new Client({ name: "pastepatch-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    const start = await client.callTool({ name: "start_here", arguments: {} });
    assert.equal(start.isError, undefined);
    const text = toolText(start);
    assert.match(text, /## AGENTS\.md guidance/);
    assert.match(text, /unique-agents-md-token-abc/);
    assert.match(text, /Always run tests after edits/);

    await client.close();
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
