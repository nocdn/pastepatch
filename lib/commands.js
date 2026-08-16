import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  JOB_ENV_KEY,
  SESSION_ENV_KEY,
  assertSafePid,
  findPidsByEnvTag,
  identityMatches,
  isPidAlive,
  killProcessTree,
  readProcessSnapshot,
} from "./process-tree.js";
import { sliceTextLines } from "./text-slice.js";

const DEFAULT_WAIT_MS = 30_000;
/** Default chars returned to the model (tail). Keep small to avoid context bloat. */
export const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
/** Suggested larger return size when the model needs more than the default tail. */
export const EXTENDED_MAX_OUTPUT_CHARS = 32_000;
/** Max chars retained per stream in memory and max returnable in one call ("full"). */
export const HARD_MAX_OUTPUT_CHARS = 100_000;
const HARD_MAX_WAIT_MS = 120_000;
const MAX_JOBS = 20;
const RESERVED_ENV = new Set([SESSION_ENV_KEY, JOB_ENV_KEY]);

/** Patterns that must never run (matched against the full command string). */
export const BLOCKED_COMMAND_PATTERNS = [
  // recursive rm of filesystem roots / home
  { name: "rm -rf /", re: /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-rf|-fr)\s+(?:\/(?:\s|$|\*)|~(?:\/|\s|$)|\$HOME(?:\/|\s|$))/i },
  { name: "mkfs", re: /\bmkfs(?:\.\w+)?\b/i },
  { name: "dd to disk", re: /\bdd\b[\s\S]*\bof=\/dev\//i },
  { name: "write disk device", re: />\s*\/dev\/(?:sd|nvme|disk|rdisk)/i },
  { name: "curl|sh", re: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:ba)?sh\b/i },
  { name: "shutdown/reboot", re: /\b(?:shutdown|reboot|halt|poweroff|init\s+0)\b/i },
  { name: "fork bomb", re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/ },
  { name: "chmod 777 /", re: /\bchmod\s+(?:-R\s+)?777\s+\/(?:\s|$)/i },
  { name: "chown /", re: /\bchown\s+(?:-R\s+)?\S+\s+\/(?:\s|$)/i },
  { name: "diskutil erase", re: /\bdiskutil\s+erase/i },
  { name: "format c:", re: /\bformat\s+[a-z]:/i },
  { name: "iptables flush", re: /\biptables\s+-F\b/i },
  { name: "kill init", re: /\bkill\s+(?:-9\s+)?1\b/ },
  { name: "launchctl reboot", re: /\blaunchctl\s+(?:reboot|bootout\s+system)/i },
];

/**
 * In-memory job registry for background / long-running commands.
 * One registry per MCP server process (bound to a project root).
 *
 * Session env/cwd persist across discrete run_command calls (the PTY substitute).
 * Jobs are spawned in a new process group and tagged with PASTEPATCH_SESSION /
 * PASTEPATCH_JOB so descendants can be found and killed.
 */
export function createCommandRunner({
  root,
  allowOutside = false,
  defaultWaitMs = DEFAULT_WAIT_MS,
  defaultMaxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
} = {}) {
  /** @type {Map<string, Job>} */
  const jobs = new Map();
  const session = {
    id: randomUUID().slice(0, 8),
    /** @type {string|null} absolute cwd override; null = project root */
    cwd: null,
    /** @type {Record<string, string>} */
    env: {},
    /** @type {{ path: string, bin: string }|null} */
    venv: null,
  };

  /**
   * @typedef {object} Job
   * @property {string} id
   * @property {string} command
   * @property {string} cwd
   * @property {import('node:child_process').ChildProcess} child
   * @property {number|null} pid
   * @property {number|null} pgid
   * @property {string} lstart
   * @property {string} stdout
   * @property {string} stderr
   * @property {boolean} done
   * @property {number|null} exitCode
   * @property {string|null} signal
   * @property {string|null} error
   * @property {number} startedAt
   * @property {number} endedAt
   * @property {number} readCursor combined output cursor for incremental reads
   * @property {number} stdoutCursor
   * @property {number} stderrCursor
   * @property {number} returnMaxChars default return cap for this job's run_command call
   * @property {number} bufferMaxChars per-stream retention cap (always hard max)
   */

  function assertCommandAllowed(command) {
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("command must be a non-empty string.");
    }
    if (command.length > 8_000) {
      throw new Error("command is too long (max 8000 characters).");
    }
    for (const rule of BLOCKED_COMMAND_PATTERNS) {
      if (rule.re.test(command)) {
        throw new Error(
          `Command blocked by safety blacklist (${rule.name}). Refusing to run:\n  ${command.slice(0, 200)}`,
        );
      }
    }
  }

  function resolveCwd(cwdRelative) {
    const base = path.resolve(root);
    if (!cwdRelative || cwdRelative === "." || cwdRelative === "") {
      return base;
    }
    if (path.isAbsolute(cwdRelative) || cwdRelative.includes("..")) {
      if (!allowOutside) {
        throw new Error(
          `cwd must be a relative path under the project root (no absolute paths or ".."). Got: ${cwdRelative}`,
        );
      }
      return path.isAbsolute(cwdRelative)
        ? path.resolve(cwdRelative)
        : path.resolve(base, cwdRelative);
    }
    const resolved = path.resolve(base, cwdRelative);
    const rel = path.relative(base, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`cwd escapes the project root: ${cwdRelative}`);
    }
    return resolved;
  }

  function resolveJobCwd(cwdArg) {
    if (cwdArg && cwdArg !== "." && cwdArg !== "") {
      return resolveCwd(cwdArg);
    }
    return session.cwd || resolveCwd(".");
  }

  function clampWait(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) {
      return defaultWaitMs;
    }
    return Math.min(Math.floor(n), HARD_MAX_WAIT_MS);
  }

  /**
   * Clamp return size for the model.
   * - omitted / invalid → default (8k)
   * - 0 or negative → full retained buffer (hard max)
   * - otherwise clamp to [1, HARD_MAX]
   */
  function clampMaxOutput(n) {
    if (n === undefined || n === null || n === "") {
      return defaultMaxOutputChars;
    }
    const v = Number(n);
    if (!Number.isFinite(v)) {
      return defaultMaxOutputChars;
    }
    if (v <= 0) {
      return HARD_MAX_OUTPUT_CHARS;
    }
    return Math.min(Math.max(Math.floor(v), 1), HARD_MAX_OUTPUT_CHARS);
  }

  function appendCapped(job, stream, chunk) {
    job[stream] += chunk;
    // Cap each stream buffer (keep the tail). Retention is always the hard max so
    // get_command_output can later return 32k / full even when the first reply was 8k.
    const max = job.bufferMaxChars;
    if (job[stream].length > max * 2) {
      job[stream] = job[stream].slice(-max);
      job[`${stream}Truncated`] = true;
    }
  }

  function combinedOutput(job) {
    const parts = [];
    if (job.stdout) {
      parts.push(job.stdout);
    }
    if (job.stderr) {
      parts.push(job.stderr ? (job.stdout ? `\n--- stderr ---\n${job.stderr}` : job.stderr) : "");
    }
    return parts.join("");
  }

  function selectStreamText(job, stream = "both") {
    if (stream === "stdout") {
      return job.stdout;
    }
    if (stream === "stderr") {
      return job.stderr;
    }
    return combinedOutput(job);
  }

  function applyOutputQuery(text, query) {
    return sliceTextLines(text, query);
  }

  function elapsedMs(job) {
    return (job.endedAt || Date.now()) - job.startedAt;
  }

  /**
   * Format result for the model with truncation notice and how to fetch more.
   */
  function formatResult(job, { fromCursor = 0, maxOutputChars, stream = "both", query } = {}) {
    const max = maxOutputChars ?? job.returnMaxChars ?? defaultMaxOutputChars;
    let text = selectStreamText(job, stream);
    const retainedChars = text.length;
    let truncatedHead = false;
    let queryNote = "";

    if (fromCursor > 0 && fromCursor < text.length) {
      text = text.slice(fromCursor);
    } else if (fromCursor >= text.length && fromCursor > 0) {
      text = "";
    }

    if (query && (query.grep || query.lineOffset || query.lineLimit)) {
      const applied = applyOutputQuery(text, query);
      text = applied.text;
      if (query.grep) {
        queryNote =
          applied.grepHits === 0
            ? `[grep /${query.grep}/ matched 0 lines in this ${stream} slice]`
            : `[grep /${query.grep}/ matched ${applied.grepHits} line(s)` +
              `${query.grepContext ? ` context=${query.grepContext}` : ""}]`;
      }
    }

    const availableInSlice = text.length;
    if (text.length > max) {
      text = text.slice(-max);
      truncatedHead = true;
    }

    const notices = [
      `[job_id=${job.id} pid=${job.pid ?? "?"} pgid=${job.pgid ?? "?"} status=${job.done ? "exited" : "running"}` +
        ` exit=${job.exitCode ?? "null"} signal=${job.signal ?? "none"} elapsed_ms=${elapsedMs(job)}` +
        ` stream=${stream}]`,
      `[stdout_chars=${job.stdout.length} stderr_chars=${job.stderr.length}` +
        ` truncated_return=${truncatedHead} truncated_buffer=${Boolean(job.stdoutTruncated || job.stderrTruncated)}]`,
    ];
    if (queryNote) {
      notices.push(queryNote);
    }
    if (truncatedHead || job.stdoutTruncated || job.stderrTruncated) {
      const bufferNote = job.stdoutTruncated || job.stderrTruncated
        ? ` stream buffer was also capped at ~${job.bufferMaxChars} chars/stream (older output discarded)`
        : "";
      notices.push(
        `[output truncated: showing last ${text.length} of ${availableInSlice} chars in this response` +
          ` (${retainedChars} chars retained for job_id=${job.id})${bufferNote}.` +
          ` Default is intentionally short (~${defaultMaxOutputChars}) to save context.` +
          ` To read more without re-running: get_command_output with job_id="${job.id}"` +
          ` and max_output_chars=${EXTENDED_MAX_OUTPUT_CHARS} (extended) or max_output_chars=0 (full retained buffer, up to ${HARD_MAX_OUTPUT_CHARS}).` +
          ` Optional: stream=stdout|stderr, grep, line_offset, line_limit.]`,
      );
    }
    if (job.done) {
      notices.push(
        `[process exited code=${job.exitCode ?? "null"}${job.signal ? ` signal=${job.signal}` : ""}${job.error ? ` error=${job.error}` : ""} job_id=${job.id}]`,
      );
    } else {
      notices.push(
        `[still running job_id=${job.id} — use get_command_output to fetch more, or stop_command to kill it]`,
      );
    }

    const emptyLabel =
      stream === "stdout" ? "(no stdout yet)" : stream === "stderr" ? "(no stderr yet)" : "(no output yet)";
    const body = text.length ? text : emptyLabel;
    return {
      jobId: job.id,
      sessionId: session.id,
      pid: job.pid,
      pgid: job.pgid,
      status: job.done ? "exited" : "running",
      exitCode: job.exitCode,
      signal: job.signal,
      command: job.command,
      cwd: job.cwd,
      startedAt: new Date(job.startedAt).toISOString(),
      endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
      elapsedMs: elapsedMs(job),
      stdoutChars: job.stdout.length,
      stderrChars: job.stderr.length,
      outputChars: retainedChars,
      returnedChars: text.length,
      maxOutputChars: max,
      truncated: truncatedHead,
      text: `${notices.join("\n")}\n\n${body}`,
    };
  }

  function pruneJobs() {
    if (jobs.size <= MAX_JOBS) {
      return;
    }
    const finished = [...jobs.values()]
      .filter((j) => j.done)
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    while (jobs.size > MAX_JOBS && finished.length) {
      const old = finished.shift();
      jobs.delete(old.id);
    }
  }

  function buildSpawnEnv(jobId) {
    const env = {
      ...process.env,
      ...session.env,
      CI: process.env.CI || "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      [SESSION_ENV_KEY]: session.id,
      [JOB_ENV_KEY]: jobId,
    };

    const pathParts = [];
    if (session.venv?.bin) {
      pathParts.push(session.venv.bin);
    }
    const overlayPath = Object.prototype.hasOwnProperty.call(session.env, "PATH")
      ? session.env.PATH
      : process.env.PATH || "";
    if (overlayPath) {
      pathParts.push(overlayPath);
    }
    if (pathParts.length) {
      env.PATH = pathParts.join(path.delimiter);
    }
    if (session.venv?.path) {
      env.VIRTUAL_ENV = session.venv.path;
      delete env.PYTHONHOME;
    }
    return env;
  }

  /**
   * Run a shell command. Waits up to waitMs; if still running, keeps it in background.
   */
  function runCommand({
    command,
    cwd: cwdArg = ".",
    waitMs = defaultWaitMs,
    maxOutputChars,
  } = {}) {
    assertCommandAllowed(command);
    const cwd = resolveJobCwd(cwdArg);
    const wait = clampWait(waitMs);
    // Return size for this reply (default 8k). Buffer always keeps up to hard max.
    const maxOut = clampMaxOutput(maxOutputChars);

    pruneJobs();

    const id = randomUUID().slice(0, 8);
    const { shell, shellArgs } = resolveShellInvocation(command);

    const child = spawn(shell, shellArgs, {
      cwd,
      env: buildSpawnEnv(id),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const pid = child.pid ?? null;
    const snapshot = pid ? readProcessSnapshot(pid) : null;

    /** @type {Job} */
    const job = {
      id,
      command,
      cwd,
      child,
      pid,
      pgid: pid,
      lstart: snapshot?.lstart || "",
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      done: false,
      exitCode: null,
      signal: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
      readCursor: 0,
      stdoutCursor: 0,
      stderrCursor: 0,
      returnMaxChars: maxOut,
      bufferMaxChars: HARD_MAX_OUTPUT_CHARS,
    };
    jobs.set(id, job);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => appendCapped(job, "stdout", chunk));
    child.stderr?.on("data", (chunk) => appendCapped(job, "stderr", chunk));

    child.on("error", (error) => {
      job.error = error.message;
      job.done = true;
      job.endedAt = Date.now();
    });

    child.on("close", (code, signal) => {
      job.exitCode = code;
      job.signal = signal;
      job.done = true;
      job.endedAt = Date.now();
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (background) => {
        if (settled) {
          return;
        }
        settled = true;
        const result = formatResult(job, { maxOutputChars: maxOut });
        if (background && !job.done) {
          result.status = "running";
          result.text =
            `[command still running after ${wait}ms; kept in background as job_id=${job.id}]\n` +
            `[use get_command_output with job_id="${job.id}" for more output (max_output_chars=${EXTENDED_MAX_OUTPUT_CHARS} or 0=full), or stop_command to kill it]\n\n` +
            result.text.replace(/^\[still running[^\]]*\]\n*/m, "");
        }
        resolve(result);
      };

      const onDone = () => finish(false);
      child.once("close", onDone);
      child.once("error", onDone);

      if (wait === 0) {
        // Immediate background
        setTimeout(() => finish(true), 0);
        return;
      }

      setTimeout(() => {
        if (!job.done) {
          child.removeListener("close", onDone);
          child.removeListener("error", onDone);
          finish(true);
        }
      }, wait);
    });
  }

  function getJob(jobId) {
    if (!jobId || typeof jobId !== "string") {
      throw new Error("job_id is required.");
    }
    const job = jobs.get(jobId);
    if (!job) {
      throw new Error(
        `Unknown job_id "${jobId}". It may have finished long ago and been pruned, or never existed.`,
      );
    }
    return job;
  }

  function peekJob(jobId) {
    if (!jobId || typeof jobId !== "string") {
      return null;
    }
    return jobs.get(jobId) || null;
  }

  function readJobStream(jobId, stream = "both") {
    return selectStreamText(getJob(jobId), stream);
  }

  /**
   * Fetch output for a job (running or finished). Prefer this over re-running
   * when the first reply was truncated — raise maxOutputChars or pass 0 for full.
   * onlyNew=true returns text since last get_command_output for the same stream.
   */
  function getCommandOutput({
    jobId,
    onlyNew = false,
    maxOutputChars,
    stream = "both",
    grep,
    grepContext,
    lineOffset,
    lineLimit,
    caseInsensitive,
  } = {}) {
    const job = getJob(jobId);
    const streamName = stream === "stdout" || stream === "stderr" ? stream : "both";
    const maxOut = clampMaxOutput(maxOutputChars);
    const cursorKey =
      streamName === "stdout" ? "stdoutCursor" : streamName === "stderr" ? "stderrCursor" : "readCursor";
    const full = selectStreamText(job, streamName);
    const fromCursor = onlyNew ? job[cursorKey] : 0;
    const result = formatResult(job, {
      fromCursor,
      maxOutputChars: maxOut,
      stream: streamName,
      query: { grep, grepContext, lineOffset, lineLimit, caseInsensitive },
    });
    job[cursorKey] = full.length;
    return result;
  }

  function assertJobIdentity(job) {
    if (!job.pid) {
      return { ok: false, reason: "job has no pid" };
    }
    if (!isPidAlive(job.pid)) {
      return { ok: false, reason: "process is gone" };
    }
    const live = readProcessSnapshot(job.pid);
    return identityMatches({ pid: job.pid, lstart: job.lstart }, live);
  }

  function collectJobLeftovers(job) {
    return findPidsByEnvTag({ sessionId: session.id, jobId: job.id }).filter(
      (pid) => pid !== job.pid && pid !== process.pid,
    );
  }

  function signalJobTree(job, signal) {
    const extra = collectJobLeftovers(job);
    if (job.pid) {
      killProcessTree(job.pid, { signal, extraPids: extra });
    } else {
      for (const pid of extra) {
        try {
          killProcessTree(pid, { signal });
        } catch {
          // ignore
        }
      }
    }
    try {
      job.child.kill(signal);
    } catch {
      // ignore — group kill often already reaped the child
    }
  }

  function stopCommand({ jobId, force = false, recursive = true } = {}) {
    const job = getJob(jobId);
    if (job.done) {
      return {
        jobId: job.id,
        status: "exited",
        message: `Job already exited (code=${job.exitCode ?? "null"}).`,
        ...formatResult(job),
      };
    }

    if (job.pid) {
      const ident = assertJobIdentity(job);
      if (!ident.ok && ident.reason && /reused/i.test(ident.reason)) {
        throw new Error(
          `Refusing to kill job ${job.id}: ${ident.reason}. Process identity does not match what pastepatch launched.`,
        );
      }
    }

    const signal = force ? "SIGKILL" : "SIGTERM";
    try {
      if (recursive) {
        signalJobTree(job, signal);
      } else {
        job.child.kill(signal);
      }
    } catch (error) {
      throw new Error(`Failed to signal job ${jobId}: ${error.message}`);
    }

    return new Promise((resolve) => {
      const finish = () => {
        resolve({
          jobId: job.id,
          status: job.done ? "exited" : "stopping",
          pid: job.pid,
          pgid: job.pgid,
          message: force
            ? `Sent SIGKILL to job ${job.id} (process group + session-tagged descendants).`
            : `Sent SIGTERM to job ${job.id} (process group + session-tagged descendants). Call get_command_output to confirm exit.`,
          text: formatResult(job).text,
        });
      };
      if (job.done) {
        finish();
        return;
      }
      const timer = setTimeout(() => {
        if (!job.done) {
          try {
            if (recursive) {
              signalJobTree(job, "SIGKILL");
            } else {
              job.child.kill("SIGKILL");
            }
          } catch {
            // ignore
          }
        }
        setTimeout(finish, 100);
      }, force ? 100 : 400);
      job.child.once("close", () => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  function findOwnedByPid(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 1) {
      return null;
    }
    for (const job of jobs.values()) {
      if (job.pid === n || job.pgid === n) {
        return { kind: "job", job, pid: n };
      }
    }
    const tagged = findPidsByEnvTag({ sessionId: session.id });
    if (!tagged.includes(n)) {
      return null;
    }
    const owner = [...jobs.values()].find((item) =>
      findPidsByEnvTag({ sessionId: session.id, jobId: item.id }).includes(n),
    );
    return { kind: "tagged", job: owner || null, pid: n };
  }

  function terminateProcess({ jobId, pid, force = false, recursive = true } = {}) {
    if (jobId) {
      return stopCommand({ jobId, force, recursive });
    }
    const n = Number(pid);
    if (!Number.isInteger(n)) {
      throw new Error("terminate_process requires job_id or pid.");
    }
    assertSafePid(n);
    const owned = findOwnedByPid(n);
    if (!owned) {
      throw new Error(
        `PID ${n} is not owned by this pastepatch session (${session.id}). ` +
          `Refusing to kill a process we did not launch. Use job_id from run_command, or stop_all_session_processes.`,
      );
    }
    if (owned.job && owned.job.pid === n) {
      return stopCommand({ jobId: owned.job.id, force, recursive });
    }
    if (owned.job?.lstart) {
      const live = readProcessSnapshot(n);
      const ident = identityMatches({ pid: n, lstart: owned.job.lstart }, live);
      // descendants have a different lstart — only refuse if THIS pid was the job leader and mismatched
      if (owned.kind === "job" && !ident.ok && /reused/i.test(ident.reason || "")) {
        throw new Error(`Refusing to kill pid ${n}: ${ident.reason}`);
      }
    }
    const signal = force ? "SIGKILL" : "SIGTERM";
    if (recursive) {
      killProcessTree(n, { signal });
    } else {
      try {
        process.kill(n, signal);
      } catch (error) {
        throw new Error(`Failed to signal pid ${n}: ${error.message}`);
      }
    }
    return {
      jobId: owned.job?.id || null,
      pid: n,
      status: isPidAlive(n) ? "stopping" : "exited",
      message: `Signaled session-owned pid ${n} (${signal}${recursive ? ", recursive" : ""}).`,
      text: owned.job ? formatResult(owned.job).text : `pid ${n} signaled`,
    };
  }

  async function stopAllSessionProcesses({ force = false } = {}) {
    const stopped = [];
    for (const job of jobs.values()) {
      if (!job.done) {
        stopped.push(await stopCommand({ jobId: job.id, force, recursive: true }));
      }
    }
    const leftovers = findPidsByEnvTag({ sessionId: session.id }).filter(
      (pid) => pid !== process.pid && isPidAlive(pid),
    );
    const extra = [];
    for (const pid of leftovers) {
      try {
        killProcessTree(pid, { signal: force ? "SIGKILL" : "SIGTERM" });
        extra.push(pid);
      } catch {
        // ignore
      }
    }
    return {
      sessionId: session.id,
      stoppedJobs: stopped.map((item) => item.jobId),
      extraPids: extra,
      message:
        `Stopped ${stopped.length} job(s) in session ${session.id}` +
        (extra.length ? ` and signaled ${extra.length} leftover pid(s)` : "") +
        ".",
    };
  }

  function listCommands() {
    return [...jobs.values()].map((job) => ({
      jobId: job.id,
      status: job.done ? "exited" : "running",
      command: job.command,
      cwd: job.cwd,
      pid: job.pid,
      pgid: job.pgid,
      exitCode: job.exitCode,
      elapsedMs: elapsedMs(job),
      startedAt: new Date(job.startedAt).toISOString(),
      endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
    }));
  }

  function expandUserPath(userPath) {
    const raw = String(userPath || "").trim();
    if (!raw) {
      throw new Error("path is required.");
    }
    if (raw === "~") {
      return os.homedir();
    }
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
      return path.join(os.homedir(), raw.slice(2));
    }
    return raw;
  }

  function resolveVenv(userPath) {
    const resolved = path.resolve(expandUserPath(userPath));
    const binName = process.platform === "win32" ? "Scripts" : "bin";
    const bin = path.join(resolved, binName);
    const markers =
      process.platform === "win32"
        ? ["python.exe", "pythonw.exe", "activate.bat", "Activate.ps1"]
        : ["python", "python3", "activate"];
    if (!existsSync(bin) || !markers.some((name) => existsSync(path.join(bin, name)))) {
      throw new Error(
        `Not a virtualenv: ${resolved} (expected ${binName}/python or ${binName}/activate).`,
      );
    }
    return { path: resolved, bin };
  }

  function assertEnvName(name) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    if (RESERVED_ENV.has(name)) {
      throw new Error(`${name} is reserved by pastepatch.`);
    }
    return name;
  }

  function getSession() {
    const leftoverPids = findPidsByEnvTag({ sessionId: session.id }).filter((pid) => {
      if (pid === process.pid) {
        return false;
      }
      return ![...jobs.values()].some((job) => job.pid === pid);
    });
    return {
      sessionId: session.id,
      cwd: session.cwd || path.resolve(root),
      cwdIsDefault: !session.cwd,
      env: { ...session.env },
      venv: session.venv?.path || null,
      jobs: listCommands(),
      leftoverPids,
    };
  }

  function formatSession(snapshot = getSession()) {
    const envLines = Object.keys(snapshot.env).length
      ? Object.entries(snapshot.env)
          .map(([key, value]) => `  ${key}=${value}`)
          .join("\n")
      : "  (none)";
    const jobLines = snapshot.jobs.length
      ? snapshot.jobs
          .map(
            (job) =>
              `  ${job.jobId}  ${job.status.padEnd(7)}  pid=${job.pid ?? "-"}  ${job.command}`,
          )
          .join("\n")
      : "  (none)";
    return [
      `session_id=${snapshot.sessionId}`,
      `cwd=${snapshot.cwd}${snapshot.cwdIsDefault ? " (project root)" : ""}`,
      `venv=${snapshot.venv || "(none)"}`,
      `env overlay:`,
      envLines,
      `jobs:`,
      jobLines,
      snapshot.leftoverPids.length
        ? `leftover session pids: ${snapshot.leftoverPids.join(", ")}`
        : "leftover session pids: (none)",
    ].join("\n");
  }

  function setSession({
    cwd,
    env,
    unsetEnv,
    venv,
    deactivateVenv = false,
  } = {}) {
    if (cwd !== undefined && cwd !== null) {
      if (cwd === "" || cwd === ".") {
        session.cwd = null;
      } else {
        session.cwd = resolveCwd(cwd);
      }
    }

    if (env && typeof env === "object" && !Array.isArray(env)) {
      for (const [name, value] of Object.entries(env)) {
        assertEnvName(name);
        if (value === undefined || value === null) {
          delete session.env[name];
        } else {
          session.env[name] = String(value);
        }
      }
    }

    const unsetList = Array.isArray(unsetEnv) ? unsetEnv : unsetEnv ? [unsetEnv] : [];
    for (const name of unsetList) {
      assertEnvName(name);
      delete session.env[name];
    }

    if (deactivateVenv) {
      session.venv = null;
    }
    if (venv) {
      session.venv = resolveVenv(venv);
    }

    return getSession();
  }

  async function dispose() {
    try {
      await stopAllSessionProcesses({ force: true });
    } catch {
      for (const job of jobs.values()) {
        if (!job.done) {
          try {
            signalJobTree(job, "SIGKILL");
          } catch {
            // ignore
          }
        }
      }
    }
    jobs.clear();
  }

  return {
    runCommand,
    getCommandOutput,
    stopCommand,
    listCommands,
    dispose,
    assertCommandAllowed,
    getSession,
    setSession,
    formatSession,
    stopAllSessionProcesses,
    terminateProcess,
    peekJob,
    readJobStream,
    get sessionId() {
      return session.id;
    },
  };
}

export function isCommandBlocked(command) {
  try {
    for (const rule of BLOCKED_COMMAND_PATTERNS) {
      if (rule.re.test(command)) {
        return rule.name;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pick a portable shell. GitHub Actions Ubuntu images have bash/sh but often no zsh.
 */
export function resolveShellInvocation(command) {
  if (process.platform === "win32") {
    return { shell: "cmd.exe", shellArgs: ["/d", "/s", "/c", command] };
  }

  const candidates = [
    process.env.PASTEPATCH_SHELL,
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/sh",
    "/usr/bin/sh",
  ].filter(Boolean);

  for (const candidate of candidates) {
    // env SHELL may be a path that exists, or a bare name — try path existence first
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) {
        return { shell: candidate, shellArgs: ["-c", command] };
      }
      continue;
    }
    // bare name like "bash" — let spawn resolve via PATH
    return { shell: candidate, shellArgs: ["-c", command] };
  }

  // Last resort: rely on PATH
  return { shell: "sh", shellArgs: ["-c", command] };
}
