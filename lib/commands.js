import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 32_000;
const HARD_MAX_OUTPUT_CHARS = 100_000;
const HARD_MAX_WAIT_MS = 120_000;
const MAX_JOBS = 20;

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
 */
export function createCommandRunner({
  root,
  allowOutside = false,
  defaultWaitMs = DEFAULT_WAIT_MS,
  defaultMaxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
} = {}) {
  /** @type {Map<string, Job>} */
  const jobs = new Map();

  /**
   * @typedef {object} Job
   * @property {string} id
   * @property {string} command
   * @property {string} cwd
   * @property {import('node:child_process').ChildProcess} child
   * @property {string} stdout
   * @property {string} stderr
   * @property {boolean} done
   * @property {number|null} exitCode
   * @property {string|null} signal
   * @property {string|null} error
   * @property {number} startedAt
   * @property {number} endedAt
   * @property {number} readCursor combined output cursor for incremental reads
   * @property {number} maxOutputChars
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

  function clampWait(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) {
      return defaultWaitMs;
    }
    return Math.min(Math.floor(n), HARD_MAX_WAIT_MS);
  }

  function clampMaxOutput(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 1_000) {
      return defaultMaxOutputChars;
    }
    return Math.min(Math.floor(v), HARD_MAX_OUTPUT_CHARS);
  }

  function appendCapped(job, stream, chunk) {
    job[stream] += chunk;
    // Cap each stream buffer (keep the tail so recent logs remain)
    const max = job.maxOutputChars;
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

  /**
   * Format result for the model with truncation notice.
   */
  function formatResult(job, { fromCursor = 0, maxOutputChars } = {}) {
    const max = maxOutputChars ?? job.maxOutputChars;
    let text = combinedOutput(job);
    const fullLength = text.length;
    let truncatedHead = false;

    if (fromCursor > 0 && fromCursor < text.length) {
      text = text.slice(fromCursor);
    } else if (fromCursor >= text.length && fromCursor > 0) {
      text = "";
    }

    if (text.length > max) {
      text = text.slice(-max);
      truncatedHead = true;
    }

    const notices = [];
    if (truncatedHead || job.stdoutTruncated || job.stderrTruncated) {
      notices.push(
        `[output truncated to last ~${max} characters of available logs; full stream may be longer]`,
      );
    }
    if (job.done) {
      notices.push(
        `[process exited code=${job.exitCode ?? "null"}${job.signal ? ` signal=${job.signal}` : ""}${job.error ? ` error=${job.error}` : ""}]`,
      );
    } else {
      notices.push(
        `[still running job_id=${job.id} — use get_command_output to fetch more, or stop_command to kill it]`,
      );
    }

    const body = text.length ? text : "(no output yet)";
    return {
      jobId: job.id,
      status: job.done ? "exited" : "running",
      exitCode: job.exitCode,
      signal: job.signal,
      command: job.command,
      cwd: job.cwd,
      startedAt: new Date(job.startedAt).toISOString(),
      endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
      outputChars: fullLength,
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

  /**
   * Run a shell command. Waits up to waitMs; if still running, keeps it in background.
   */
  function runCommand({
    command,
    cwd: cwdArg = ".",
    waitMs = defaultWaitMs,
    maxOutputChars = defaultMaxOutputChars,
  } = {}) {
    assertCommandAllowed(command);
    const cwd = resolveCwd(cwdArg);
    const wait = clampWait(waitMs);
    const maxOut = clampMaxOutput(maxOutputChars);

    pruneJobs();

    const id = randomUUID().slice(0, 8);
    const { shell, shellArgs } = resolveShellInvocation(command);

    const child = spawn(shell, shellArgs, {
      cwd,
      env: {
        ...process.env,
        // Prefer non-interactive tools
        CI: process.env.CI || "1",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    /** @type {Job} */
    const job = {
      id,
      command,
      cwd,
      child,
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
      maxOutputChars: maxOut,
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
            `[use get_command_output with job_id="${job.id}" for more output, or stop_command to kill it]\n\n` +
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

  /**
   * Fetch output for a job. onlyNew=true returns text since last get_command_output.
   */
  function getCommandOutput({
    jobId,
    onlyNew = false,
    maxOutputChars = defaultMaxOutputChars,
  } = {}) {
    const job = getJob(jobId);
    const maxOut = clampMaxOutput(maxOutputChars);
    const fromCursor = onlyNew ? job.readCursor : 0;
    const result = formatResult(job, { fromCursor, maxOutputChars: maxOut });
    // Advance cursor to current combined length
    job.readCursor = combinedOutput(job).length;
    return result;
  }

  function stopCommand({ jobId, force = false } = {}) {
    const job = getJob(jobId);
    if (job.done) {
      return {
        jobId: job.id,
        status: "exited",
        message: `Job already exited (code=${job.exitCode ?? "null"}).`,
        ...formatResult(job),
      };
    }

    const signal = force ? "SIGKILL" : "SIGTERM";
    try {
      job.child.kill(signal);
    } catch (error) {
      throw new Error(`Failed to signal job ${jobId}: ${error.message}`);
    }

    // Escalate to SIGKILL if still alive after a short grace period
    return new Promise((resolve) => {
      const finish = () => {
        resolve({
          jobId: job.id,
          status: job.done ? "exited" : "stopping",
          message: force
            ? `Sent SIGKILL to job ${job.id}.`
            : `Sent SIGTERM to job ${job.id}. Call get_command_output to confirm exit.`,
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
            job.child.kill("SIGKILL");
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

  function listCommands() {
    return [...jobs.values()].map((job) => ({
      jobId: job.id,
      status: job.done ? "exited" : "running",
      command: job.command,
      cwd: job.cwd,
      exitCode: job.exitCode,
      startedAt: new Date(job.startedAt).toISOString(),
      endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
    }));
  }

  async function dispose() {
    for (const job of jobs.values()) {
      if (!job.done) {
        try {
          job.child.kill("SIGKILL");
        } catch {
          // ignore
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
