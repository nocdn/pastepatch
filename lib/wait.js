import { stat } from "node:fs/promises";
import net from "node:net";
import { resolveToolPath } from "./fs-ops.js";
import { httpRequest } from "./http-request.js";
import { isPidAlive } from "./process-tree.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 200;
const HARD_MAX_INTERVAL_MS = 5_000;

export const WAIT_CONDITIONS = [
  "port_open",
  "http_status",
  "job_exits",
  "process_exits",
  "file_size_stable",
  "output_matches",
];

export function clampWaitTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(n), HARD_MAX_TIMEOUT_MS);
}

function clampInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 50) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.min(Math.floor(n), HARD_MAX_INTERVAL_MS);
}

/**
 * Block until a condition is true or timeout.
 * MCP-shaped alternative to sleep + ps + tail.
 *
 * @param {object} input
 * @param {object} deps
 * @param {import('./commands.js').CommandRunner} [deps.runner]
 * @param {string} deps.root
 * @param {boolean} [deps.allowOutside]
 */
export async function waitUntil(input = {}, { runner, root, allowOutside = false } = {}) {
  const condition = input.condition;
  if (!WAIT_CONDITIONS.includes(condition)) {
    throw new Error(
      `condition must be one of: ${WAIT_CONDITIONS.join(", ")}. Got: ${condition ?? "(missing)"}`,
    );
  }

  const timeoutMs = clampWaitTimeout(input.timeout_ms ?? input.timeoutMs);
  const intervalMs = clampInterval(input.interval_ms ?? input.intervalMs);
  const started = Date.now();
  let last = { ok: false, detail: "not checked yet" };

  while (true) {
    last = await checkCondition(condition, input, { runner, root, allowOutside });
    if (last.ok) {
      return {
        ...last,
        status: "satisfied",
        condition,
        elapsedMs: Date.now() - started,
        httpStatus: last.httpStatus ?? last.status,
      };
    }
    if (Date.now() - started >= timeoutMs) {
      return {
        status: "timeout",
        condition,
        elapsedMs: Date.now() - started,
        timeoutMs,
        last,
      };
    }
    await sleep(intervalMs);
  }
}

export function formatWaitResult(result) {
  const head =
    result.status === "satisfied"
      ? `[wait_until ${result.condition} satisfied elapsed_ms=${result.elapsedMs}]`
      : `[wait_until ${result.condition} timeout after ${result.elapsedMs}ms (limit ${result.timeoutMs}ms)]`;
  const detail = result.detail || result.last?.detail || "";
  const extra = result.snippet || result.last?.snippet || "";
  return extra ? `${head}\n${detail}\n\n${extra}` : `${head}\n${detail}`;
}

async function checkCondition(condition, input, deps) {
  switch (condition) {
    case "port_open":
      return checkPortOpen(input);
    case "http_status":
      return checkHttpStatus(input);
    case "job_exits":
      return checkJobExits(input, deps.runner);
    case "process_exits":
      return checkProcessExits(input);
    case "file_size_stable":
      return checkFileSizeStable(input, deps);
    case "output_matches":
      return checkOutputMatches(input, deps.runner);
    default:
      return { ok: false, detail: `unknown condition ${condition}` };
  }
}

async function checkPortOpen(input) {
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port_open requires port (integer 1-65535).");
  }
  const host = String(input.host || "127.0.0.1");
  const { ok, error } = await tryConnect(host, port);
  return {
    ok,
    detail: ok ? `${host}:${port} is open` : `${host}:${port} not open (${error || "refused"})`,
    host,
    port,
  };
}

async function checkHttpStatus(input) {
  const url = input.url;
  if (!url) {
    throw new Error("http_status requires url.");
  }
  const expect = Number(input.expect_status ?? input.expectStatus ?? 200);
  try {
    const result = await httpRequest({
      method: input.method || "GET",
      url,
      timeoutMs: 5_000,
      allowPublic: Boolean(input.allow_public ?? input.allowPublic),
      maxBodyChars: 2_000,
    });
    const ok = result.status === expect;
    return {
      ok,
      detail: ok
        ? `${url} returned ${result.status}`
        : `${url} returned ${result.status}, expected ${expect}`,
      httpStatus: result.status,
      url: result.url,
    };
  } catch (error) {
    return { ok: false, detail: error.message || String(error) };
  }
}

function checkJobExits(input, runner) {
  if (!runner) {
    throw new Error("job_exits requires a command runner.");
  }
  const jobId = input.job_id || input.jobId;
  const job = runner.peekJob(jobId);
  if (!job) {
    throw new Error(`Unknown job_id "${jobId}".`);
  }
  return {
    ok: job.done,
    detail: job.done
      ? `job ${job.id} exited code=${job.exitCode ?? "null"}`
      : `job ${job.id} still running`,
    jobId: job.id,
    exitCode: job.exitCode,
  };
}

function checkProcessExits(input) {
  const pid = Number(input.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("process_exits requires pid.");
  }
  const alive = isPidAlive(pid);
  return {
    ok: !alive,
    detail: alive ? `pid ${pid} still running` : `pid ${pid} is gone`,
    pid,
  };
}

async function checkFileSizeStable(input, { root, allowOutside }) {
  const relative = input.path;
  if (!relative) {
    throw new Error("file_size_stable requires path.");
  }
  const abs = resolveToolPath(relative, root, { allowOutside });
  const settleMs = Math.min(
    Math.max(Number(input.settle_ms ?? input.settleMs ?? 1_000) || 1_000, 100),
    30_000,
  );

  let first;
  try {
    first = await stat(abs);
  } catch (error) {
    return { ok: false, detail: `file not ready: ${error.message}` };
  }
  if (!first.isFile()) {
    return { ok: false, detail: `${abs} is not a regular file` };
  }

  await sleep(settleMs);

  let second;
  try {
    second = await stat(abs);
  } catch (error) {
    return { ok: false, detail: `file disappeared: ${error.message}` };
  }
  const ok = second.size === first.size && second.mtimeMs === first.mtimeMs;
  return {
    ok,
    detail: ok
      ? `${abs} stable at ${second.size} bytes`
      : `${abs} still changing (${first.size} → ${second.size} bytes)`,
    path: abs,
    bytes: second.size,
  };
}

function checkOutputMatches(input, runner) {
  if (!runner) {
    throw new Error("output_matches requires a command runner.");
  }
  const jobId = input.job_id || input.jobId;
  const pattern = input.pattern;
  if (!pattern) {
    throw new Error("output_matches requires pattern.");
  }
  let regex;
  try {
    regex = new RegExp(pattern, input.caseInsensitive || input.case_insensitive ? "i" : "");
  } catch (error) {
    throw new Error(`Invalid output_matches pattern: ${error.message}`);
  }
  const stream = input.stream || "both";
  const text = runner.readJobStream(jobId, stream);
  const match = text.match(regex);
  if (!match) {
    return {
      ok: false,
      detail: `job ${jobId} ${stream} has no match for /${pattern}/`,
      jobId,
    };
  }
  const idx = match.index ?? 0;
  const start = Math.max(0, idx - 80);
  const snippet = text.slice(start, idx + match[0].length + 80);
  return {
    ok: true,
    detail: `job ${jobId} matched /${pattern}/`,
    jobId,
    snippet,
  };
}

function tryConnect(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok, error) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(400);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => finish(false, error.message));
    socket.connect(port, host);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
