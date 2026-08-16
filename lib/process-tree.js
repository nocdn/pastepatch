import { spawnSync } from "node:child_process";
import process from "node:process";

export const SESSION_ENV_KEY = "PASTEPATCH_SESSION";
export const JOB_ENV_KEY = "PASTEPATCH_JOB";

/**
 * True if a pid is currently alive (or exists but we cannot signal it).
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    return false;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

export function assertSafePid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) {
    throw new Error(`Refusing to signal pid ${pid} (must be an integer > 1).`);
  }
  return n;
}

/**
 * Snapshot used to refuse kills after PID reuse.
 * lstart is read with LC_ALL=C so the string is comparable later.
 */
export function readProcessSnapshot(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "tasklist",
      ["/FI", `PID eq ${n}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    const out = (result.stdout || "").trim();
    if (!out || /No tasks/i.test(out)) {
      return null;
    }
    return { pid: n, lstart: "", command: out };
  }

  const result = spawnSync(
    "ps",
    ["-o", "pid=", "-o", "lstart=", "-o", "command=", "-p", String(n)],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    },
  );
  const line = (result.stdout || "").trim();
  if (result.status !== 0 || !line) {
    return null;
  }

  const match = line.match(
    /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
  );
  if (!match) {
    return { pid: n, lstart: "", command: line.replace(/^\s*\d+\s+/, "") };
  }
  return { pid: Number(match[1]), lstart: match[2], command: match[3] };
}

export function identityMatches(expected, live) {
  if (!live) {
    return { ok: false, reason: "process is gone" };
  }
  if (expected.pid !== live.pid) {
    return { ok: false, reason: "pid mismatch" };
  }
  if (expected.lstart && live.lstart && expected.lstart !== live.lstart) {
    return {
      ok: false,
      reason: `PID reused (started "${live.lstart}", expected "${expected.lstart}")`,
    };
  }
  return { ok: true };
}

/**
 * Direct children via pgrep -P (Unix). Empty on Windows / if pgrep is missing.
 */
export function listChildPids(pid) {
  if (process.platform === "win32") {
    return [];
  }
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    return [];
  }
  const result = spawnSync("pgrep", ["-P", String(n)], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) {
    return [];
  }
  return (result.stdout || "")
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 1);
}

export function listDescendantPids(pid) {
  const seen = new Set();
  const queue = [Number(pid)];
  while (queue.length) {
    const current = queue.shift();
    for (const child of listChildPids(current)) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

/**
 * Find PIDs whose environment contains PASTEPATCH_SESSION / PASTEPATCH_JOB.
 * Unix: `ps -axeww` (env appended to the command column).
 * Windows: not supported (empty); process-group / taskkill /T is the fallback.
 */
export function findPidsByEnvTag({ sessionId, jobId } = {}) {
  if (process.platform === "win32") {
    return [];
  }
  if (!sessionId && !jobId) {
    return [];
  }

  const result = spawnSync("ps", ["-axeww"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return [];
  }

  const needles = [];
  if (sessionId) {
    needles.push(`${SESSION_ENV_KEY}=${sessionId}`);
  }
  if (jobId) {
    needles.push(`${JOB_ENV_KEY}=${jobId}`);
  }

  const pids = [];
  for (const line of (result.stdout || "").split("\n")) {
    if (!needles.every((needle) => line.includes(needle))) {
      continue;
    }
    const match = line.trim().match(/^(\d+)\b/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

/**
 * Signal a process and, on Unix, its process group (negative pid).
 * Never signals pid <= 1.
 */
export function signalPid(pid, signal = "SIGTERM") {
  const n = assertSafePid(pid);
  if (process.platform === "win32") {
    const args = ["/PID", String(n), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    spawnSync("taskkill", args, { encoding: "utf8", windowsHide: true });
    return;
  }

  try {
    process.kill(-n, signal);
  } catch {
    try {
      process.kill(n, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Kill a pid, its process group, known descendants, and optional extra pids.
 */
export function killProcessTree(pid, { signal = "SIGTERM", extraPids = [] } = {}) {
  const n = assertSafePid(pid);
  const targets = new Set([n, ...extraPids.map(Number).filter((value) => value > 1)]);
  for (const child of listDescendantPids(n)) {
    targets.add(child);
  }

  for (const target of targets) {
    if (target === process.pid || target <= 1) {
      continue;
    }
    try {
      signalPid(target, signal);
    } catch {
      // ignore individual failures
    }
  }
}
