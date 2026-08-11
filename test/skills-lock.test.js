import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  acquireMcpLock,
  findLiveMcpLock,
  formatMcpAlreadyRunningError,
  isProcessAlive,
  releaseMcpLock,
} from "../lib/mcp-lock.js";
import { startMcpHttpServer } from "../lib/mcp-server.js";
import {
  formatSkillsList,
  listRemoteSkills,
  parseSkillFrontmatter,
  readRemoteSkill,
} from "../lib/skills.js";

const tempDirectories = [];

test.after(async () => {
  await Promise.all(tempDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(dir);
  return dir;
}

test("parseSkillFrontmatter extracts name and description", () => {
  const meta = parseSkillFrontmatter(`---
name: demo-skill
description: Does a useful thing for agents.
---

# Demo
`);
  assert.equal(meta.name, "demo-skill");
  assert.equal(meta.description, "Does a useful thing for agents.");
});

test("listRemoteSkills finds SKILL.md and dedupes by name/path", async () => {
  const home = await tempDir("pastepatch-skills-home-");
  const project = await tempDir("pastepatch-skills-proj-");

  await mkdir(path.join(home, ".agents", "skills", "alpha"), { recursive: true });
  await writeFile(
    path.join(home, ".agents", "skills", "alpha", "SKILL.md"),
    `---
name: alpha
description: Home alpha skill
---
# Alpha home
`,
    "utf8",
  );

  // Same name in project should win (project roots preferred)
  await mkdir(path.join(project, ".agents", "skills", "alpha"), { recursive: true });
  await writeFile(
    path.join(project, ".agents", "skills", "alpha", "SKILL.md"),
    `---
name: alpha
description: Project alpha skill
---
# Alpha project
`,
    "utf8",
  );

  await mkdir(path.join(home, ".claude", "skills", "beta"), { recursive: true });
  await writeFile(
    path.join(home, ".claude", "skills", "beta", "SKILL.md"),
    `---
name: beta
description: Claude beta
---
# Beta
`,
    "utf8",
  );

  const skills = await listRemoteSkills({ projectRoot: project, home });
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["alpha", "beta"]);

  const alpha = skills.find((s) => s.name === "alpha");
  assert.match(alpha.description, /Project alpha/);
  assert.ok(alpha.path.includes(project));

  const text = formatSkillsList(skills);
  assert.match(text, /Found 2 skills/);
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
});

test("readRemoteSkill loads by name", async () => {
  const home = await tempDir("pastepatch-skills-read-");
  await mkdir(path.join(home, ".agents", "skills", "gamma"), { recursive: true });
  await writeFile(
    path.join(home, ".agents", "skills", "gamma", "SKILL.md"),
    `---
name: gamma
description: Gamma skill
---
# Gamma body
unique-gamma-token
`,
    "utf8",
  );

  const skill = await readRemoteSkill("gamma", { home, projectRoot: null });
  assert.equal(skill.name, "gamma");
  assert.match(skill.content, /unique-gamma-token/);
});

test("mcp lock detects live process and allows stale pid reuse", async () => {
  const lockDir = await tempDir("pastepatch-lock-");
  const lockPath = path.join(lockDir, "mcp.lock");

  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999_999_999), false);

  await acquireMcpLock({
    pid: process.pid,
    port: 8787,
    root: "/tmp/proj",
    hostname: "example.test",
    lockPath,
  });

  await assert.rejects(
    () =>
      acquireMcpLock({
        pid: process.pid + 1,
        port: 8788,
        root: "/tmp/other",
        lockPath,
        packageName: "pastepatch",
      }),
    /already running/i,
  );

  const live = await findLiveMcpLock(lockPath);
  assert.equal(live.pid, process.pid);
  assert.match(formatMcpAlreadyRunningError(live), /stop_session|Ctrl\+C|kill/);

  await releaseMcpLock({ pid: process.pid, lockPath });
  assert.equal(await findLiveMcpLock(lockPath), null);

  // Stale lock (dead pid) can be overwritten
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 999_999_999, port: 1, root: "/x", startedAt: new Date().toISOString() }),
    "utf8",
  );
  await acquireMcpLock({ pid: process.pid, port: 9, root: "/y", lockPath });
  await releaseMcpLock({ pid: process.pid, lockPath });
});

test("MCP list_remote_skills, read_remote_skill, and stop_session tools work", async () => {
  const project = await tempDir("pastepatch-mcp-skills-proj-");
  await writeFile(path.join(project, "README.md"), "hi\n", "utf8");

  // Project-local skills are always scanned (home skills come from the real homedir).
  await mkdir(path.join(project, ".agents", "skills", "proj-skill"), { recursive: true });
  await writeFile(
    path.join(project, ".agents", "skills", "proj-skill", "SKILL.md"),
    `---
name: proj-skill
description: Project local skill
---
# Project skill
project-skill-marker
`,
    "utf8",
  );

  const port = await freePort();
  let stopCalls = 0;
  const server = await startMcpHttpServer({
    root: project,
    port,
    host: "127.0.0.1",
    version: "test",
    onStopSession: () => {
      stopCalls += 1;
    },
  });

  try {
    const client = new Client({ name: "pastepatch-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    const listed = await client.callTool({ name: "list_remote_skills", arguments: {} });
    assert.equal(listed.isError, undefined);
    assert.match(toolText(listed), /proj-skill/);

    const read = await client.callTool({
      name: "read_remote_skill",
      arguments: { name: "proj-skill" },
    });
    assert.equal(read.isError, undefined);
    assert.match(toolText(read), /project-skill-marker/);
    assert.match(toolText(read), /Skill: proj-skill/);

    const stop = await client.callTool({ name: "stop_session", arguments: {} });
    assert.equal(stop.isError, undefined);
    assert.match(toolText(stop), /Stopping pastepatch MCP on the remote machine/i);

    await waitFor(() => stopCalls >= 1, 2000);
    assert.equal(stopCalls, 1);

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

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}
