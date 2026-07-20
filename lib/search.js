import { spawn } from "node:child_process";
import path from "node:path";
import { resolveToolPath } from "./fs-ops.js";

const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 200;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Content search under project root: prefer ripgrep, fall back to grep.
 */
export async function searchContent({
  root,
  pattern,
  path: relativePath = ".",
  glob,
  caseInsensitive = false,
  maxResults = DEFAULT_MAX_RESULTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowOutside = false,
} = {}) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("search requires a non-empty pattern.");
  }

  const resolvedRoot = path.resolve(root);
  const pathOptions = { allowOutside };
  const searchRoot = resolveSearchRoot(relativePath, resolvedRoot, pathOptions);
  const limit = clampLimit(maxResults);
  const rg = await which("rg");

  if (rg) {
    const args = [
      "--line-number",
      "--with-filename",
      "--color",
      "never",
      "--no-heading",
      "--hidden",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.pastepatch/**",
      "-m",
      String(limit),
    ];
    if (caseInsensitive) {
      args.push("-i");
    }
    if (glob) {
      args.push("--glob", glob);
    }
    args.push("--", pattern, searchRoot);

    const result = await runCapture(rg, args, { cwd: resolvedRoot, timeoutMs });
    // rg exits 1 when no matches
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`rg failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return {
      engine: "rg",
      output: formatContentHits(result.stdout, resolvedRoot, limit),
      truncated: countLines(result.stdout) >= limit,
    };
  }

  const grep = await which("grep");
  if (!grep) {
    throw new Error("Neither ripgrep (rg) nor grep is available on PATH.");
  }

  const args = ["-R", "-n", "-I", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=.pastepatch"];
  if (caseInsensitive) {
    args.push("-i");
  }
  if (glob) {
    // basic shell-less: only support simple extensions via --include
    args.push(`--include=${glob}`);
  }
  args.push("--", pattern, searchRoot);

  const result = await runCapture(grep, args, { cwd: resolvedRoot, timeoutMs });
  // grep exits 1 when no matches
  if (result.code !== 0 && result.code !== 1 && result.code !== 2) {
    throw new Error(`grep failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  // grep -R may still print binary/noise on stderr with code 2; keep stdout
  return {
    engine: "grep",
    output: formatContentHits(result.stdout, resolvedRoot, limit),
    truncated: countLines(result.stdout) >= limit,
  };
}

/**
 * Filename search under project root: prefer fd, fall back to find.
 */
export async function findFiles({
  root,
  pattern,
  path: relativePath = ".",
  maxResults = DEFAULT_MAX_RESULTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowOutside = false,
} = {}) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("find_files requires a non-empty pattern (glob or substring).");
  }

  const resolvedRoot = path.resolve(root);
  const searchRoot = resolveSearchRoot(relativePath, resolvedRoot, { allowOutside });
  const limit = clampLimit(maxResults);
  const fd = (await which("fd")) || (await which("fdfind"));

  if (fd) {
    const args = [
      "--hidden",
      "--exclude",
      ".git",
      "--exclude",
      "node_modules",
      "--exclude",
      ".pastepatch",
      "--color",
      "never",
      "-a", // absolute paths for easy relativizing
      "--max-results",
      String(limit),
      pattern,
      searchRoot,
    ];
    const result = await runCapture(fd, args, { cwd: resolvedRoot, timeoutMs });
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`fd failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return {
      engine: "fd",
      output: formatPathHits(result.stdout, resolvedRoot, limit),
      truncated: countLines(result.stdout) >= limit,
    };
  }

  const findBin = await which("find");
  if (!findBin) {
    throw new Error("Neither fd nor find is available on PATH.");
  }

  // Treat pattern as a find -name glob; if no wildcard, wrap as *pattern*
  const nameGlob = /[*?[\]{}]/.test(pattern) ? pattern : `*${pattern}*`;
  const args = [
    searchRoot,
    "(",
    "-path",
    "*/.git/*",
    "-o",
    "-path",
    "*/node_modules/*",
    "-o",
    "-path",
    "*/.pastepatch/*",
    ")",
    "-prune",
    "-o",
    "-type",
    "f",
    "-name",
    nameGlob,
    "-print",
  ];

  const result = await runCapture(findBin, args, { cwd: resolvedRoot, timeoutMs });
  if (result.code !== 0) {
    throw new Error(`find failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return {
    engine: "find",
    output: formatPathHits(result.stdout, resolvedRoot, limit),
    truncated: countLines(result.stdout) >= limit,
  };
}

function resolveSearchRoot(relativePath, root, options = {}) {
  if (!relativePath || relativePath === "." || relativePath === "") {
    return root;
  }
  return resolveToolPath(relativePath, root, options);
}

function clampLimit(maxResults) {
  const n = Number(maxResults);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.min(Math.floor(n), HARD_MAX_RESULTS);
}

function countLines(text) {
  if (!text || !text.trim()) {
    return 0;
  }
  return text.trimEnd().split("\n").length;
}

function formatContentHits(stdout, root, limit) {
  const lines = (stdout || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => relativizeHitLine(line, root));

  if (lines.length === 0) {
    return "(no matches)";
  }
  return lines.join("\n");
}

function formatPathHits(stdout, root, limit) {
  const lines = (stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => relativizePath(line, root));

  if (lines.length === 0) {
    return "(no matches)";
  }
  return lines.join("\n");
}

function relativizeHitLine(line, root) {
  // path:line:content  or path:line-content
  const match = line.match(/^([^:]+):(\d+)([:-])(.*)$/);
  if (!match) {
    return relativizePath(line, root);
  }
  return `${relativizePath(match[1], root)}:${match[2]}${match[3]}${match[4]}`;
}

function relativizePath(filePath, root) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}

function which(command) {
  return new Promise((resolve) => {
    // BSD find has no --version; probe with -help / bare existence via `command -v` style spawn
    const args = command === "find" ? ["."] : ["--version"];
    // For find, use a no-op that always works: find with no args prints usage and may exit 1
    // Prefer PATH lookup via shell for portability:
    const child = spawn("sh", ["-c", `command -v ${shellQuote(command)}`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim().split("\n")[0]);
        return;
      }
      // fallback: try spawning binary
      void args;
      const probe = spawn(command, command === "find" ? [] : ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      probe.on("error", () => resolve(null));
      probe.on("close", (probeCode) => {
        // find with no args often exits 1 but exists
        if (command === "find") {
          resolve(probeCode === null ? null : command);
          return;
        }
        resolve(probeCode === 0 ? command : null);
      });
    });
  });
}

function shellQuote(value) {
  return /[^A-Za-z0-9_./:-]/.test(value) ? JSON.stringify(value) : value;
}

function runCapture(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
