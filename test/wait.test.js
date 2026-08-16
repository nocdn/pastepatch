import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommandRunner } from "../lib/commands.js";
import { waitUntil } from "../lib/wait.js";

const tempDirectories = [];

test.after(async () => {
  await Promise.all(tempDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("wait_until port_open and http_status", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const { port } = server.address();

  try {
    const open = await waitUntil(
      { condition: "port_open", port, timeout_ms: 5_000 },
      { root: os.tmpdir() },
    );
    assert.equal(open.status, "satisfied");

    const httpOk = await waitUntil(
      { condition: "http_status", url: `http://127.0.0.1:${port}/`, timeout_ms: 5_000 },
      { root: os.tmpdir() },
    );
    assert.equal(httpOk.status, "satisfied");

    const closed = await waitUntil(
      { condition: "port_open", port: 1, host: "127.0.0.1", timeout_ms: 400, interval_ms: 80 },
      { root: os.tmpdir() },
    );
    assert.equal(closed.status, "timeout");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("wait_until job_exits and output_matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pastepatch-wait-"));
  tempDirectories.push(root);
  const runner = createCommandRunner({ root });
  try {
    const started = await runner.runCommand({
      command:
        process.platform === "win32"
          ? "ping -n 2 127.0.0.1 >nul & echo READY-TOKEN"
          : "sleep 0.2; echo READY-TOKEN",
      waitMs: 0,
    });

    const matched = await waitUntil(
      {
        condition: "output_matches",
        job_id: started.jobId,
        pattern: "READY-TOKEN",
        timeout_ms: 8_000,
      },
      { runner, root },
    );
    assert.equal(matched.status, "satisfied");

    const exited = await waitUntil(
      { condition: "job_exits", job_id: started.jobId, timeout_ms: 8_000 },
      { runner, root },
    );
    assert.equal(exited.status, "satisfied");
  } finally {
    await runner.dispose();
  }
});

test("wait_until file_size_stable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pastepatch-wait-file-"));
  tempDirectories.push(root);
  const filePath = path.join(root, "out.bin");
  await writeFile(filePath, "abc", "utf8");

  const result = await waitUntil(
    { condition: "file_size_stable", path: "out.bin", settle_ms: 150, timeout_ms: 5_000 },
    { root },
  );
  assert.equal(result.status, "satisfied");
  assert.equal(result.bytes, 3);
});
