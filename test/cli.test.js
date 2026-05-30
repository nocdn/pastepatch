import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.join(repoRoot, "bin", "cli.js");
const tempDirectories = [];

test("help uses the executable bin name", async () => {
  const result = await runCli(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:\n  pastepatch --init/);
  assert.doesNotMatch(result.stdout, /@nocdn\/pastepatch --edit/);
});

test("dry run rejects invalid and stale tool plans", async () => {
  const root = await tempProject();
  await writeFile(path.join(root, "README.md"), "hello\n", "utf8");

  await assertDryRunFails(root, [{ tool: "no_such_tool", path: "README.md" }], /Unknown tool/);
  await assertDryRunFails(root, [{ tool: "create_file", path: "created.txt" }], /requires a string "content"/);
  await assertDryRunFails(root, [{ tool: "delete_file", path: "." }], /project root/);
  await assertDryRunFails(root, [{ tool: "delete_file", path: "missing.txt" }], /path does not exist/);
  await assertDryRunFails(
    root,
    [{ tool: "replace_in_file", path: "README.md", old: "not present", new: "changed" }],
    /old string was not found/,
  );
});

test("paths containing parent directory segments are rejected", async () => {
  const root = await tempProject();
  const result = await runCli(["--edit", "--dry-run"], {
    cwd: root,
    input: JSON.stringify([{ tool: "create_file", path: "src/..", content: "x" }]),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Refusing path containing "\.\."/);
});

test("writes through symlinked parents are rejected", async (t) => {
  const root = await tempProject();

  try {
    await symlink(os.tmpdir(), path.join(root, "outside"), "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${error.message}`);
    return;
  }

  const result = await runCli(["--edit", "--dry-run"], {
    cwd: root,
    input: JSON.stringify([{ tool: "create_file", path: "outside/file.txt", content: "x" }]),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /symbolic link/);
});

test("delete_file fails when the target is missing", async () => {
  const root = await tempProject();
  const result = await runCli(["--edit", "--yes"], {
    cwd: root,
    input: JSON.stringify([{ tool: "delete_file", path: "missing.txt" }]),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /path does not exist/);
});

test("undo restores paths relative to the original edit directory", async () => {
  const root = await tempProject();
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "subdir"));

  const applyResult = await runCli(["--edit", "--yes"], {
    cwd: root,
    input: JSON.stringify([{ tool: "create_file", path: "created.txt", content: "hello\n" }]),
  });
  assert.equal(applyResult.code, 0, applyResult.stderr);
  assert.equal(await readFile(path.join(root, "created.txt"), "utf8"), "hello\n");

  const undoResult = await runCli(["--undo"], { cwd: path.join(root, "subdir") });
  assert.equal(undoResult.code, 0, undoResult.stderr);

  await assertFileMissing(path.join(root, "created.txt"));
  await assertFileMissing(path.join(root, "subdir", "created.txt"));
});

async function assertDryRunFails(cwd, plan, expectedError) {
  const result = await runCli(["--edit", "--dry-run"], {
    cwd,
    input: JSON.stringify(plan),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, expectedError);
}

async function assertFileMissing(filePath) {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

async function tempProject() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pastepatch-test-"));
  tempDirectories.push(directory);
  return directory;
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd || repoRoot,
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
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(options.input || "");
  });
}

test.after(async () => {
  await Promise.all(tempDirectories.map((directory) => rm(directory, { force: true, recursive: true })));
});
