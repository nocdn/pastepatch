import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { listChildPids, listDescendantPids, readProcessSnapshot } from "./process-tree.js";

const MAX_NAME_MATCHES = 12;
const MAX_TREE_DEPTH = 24;
const MAX_CHILDREN_SHOWN = 40;

/**
 * Strict app / process name: letters, digits, spaces, and a few punctuation marks.
 * Rejects quotes and control characters so names can be passed to osascript.
 */
export function assertProcessName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("name is required.");
  }
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,80}$/.test(trimmed)) {
    throw new Error(
      `Invalid name "${name}". Use an exact process or app name (letters, digits, spaces). No quotes or wildcards.`,
    );
  }
  return trimmed;
}

export function readParentPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    return null;
  }
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(n)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const parent = Number((result.stdout || "").trim());
  if (!Number.isInteger(parent) || parent <= 0 || parent === n) {
    return null;
  }
  return parent;
}

export function listAncestorPids(pid, { limit = MAX_TREE_DEPTH } = {}) {
  const chain = [];
  const seen = new Set();
  let current = Number(pid);
  while (current && current > 1 && !seen.has(current) && chain.length < limit) {
    seen.add(current);
    const parent = readParentPid(current);
    if (!parent || parent === current) {
      break;
    }
    chain.push(parent);
    current = parent;
  }
  return chain.reverse();
}

/**
 * Find pids whose comm, basename, or containing .app bundle matches `name` exactly
 * (case-insensitive). Not a substring search on the full command line.
 */
export function findPidsByProcessName(name) {
  const want = assertProcessName(name).toLowerCase();
  if (process.platform === "win32") {
    return findPidsByProcessNameWin32(want);
  }

  const result = spawnSync("ps", ["-ax", "-o", "pid=", "-o", "comm=", "-o", "command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return [];
  }

  const pids = [];
  for (const line of (result.stdout || "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const comm = match[2];
    const command = match[3];
    if (!Number.isInteger(pid) || pid <= 1) {
      continue;
    }
    if (processNameMatches({ comm, command, want, name })) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

function processNameMatches({ comm, command, want, name }) {
  if (String(comm || "").toLowerCase() === want) {
    return true;
  }
  const base = path.basename(String(command || "").split(/\s+/)[0] || "").toLowerCase();
  if (base && base === want) {
    return true;
  }
  const appNeedle = `/${name}.app/`.toLowerCase();
  if (String(command || "").toLowerCase().includes(appNeedle)) {
    return true;
  }
  return false;
}

function findPidsByProcessNameWin32(want) {
  const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pids = [];
  for (const line of (result.stdout || "").split("\n")) {
    const cols = line.match(/"([^"]*)"/g);
    if (!cols || cols.length < 2) {
      continue;
    }
    const image = cols[0].replaceAll('"', "");
    const pid = Number(cols[1].replaceAll('"', ""));
    if (!Number.isInteger(pid) || pid <= 1) {
      continue;
    }
    const stem = image.replace(/\.exe$/i, "").toLowerCase();
    if (stem === want || image.toLowerCase() === want) {
      pids.push(pid);
    }
  }
  return pids;
}

/**
 * Ancestors + the process + descendants. `name` is exact comm / app match, not a fuzzy search.
 */
export function getProcessTree({ pid, name } = {}) {
  const roots = resolveTreeRoots({ pid, name });
  if (roots.length === 0) {
    throw new Error(
      pid
        ? `No process with pid ${pid}.`
        : `No process matching exact name "${name}".`,
    );
  }

  const trees = roots.slice(0, MAX_NAME_MATCHES).map((rootPid) => buildOneTree(rootPid));
  return {
    query: pid ? { pid: Number(pid) } : { name: assertProcessName(name) },
    matchCount: roots.length,
    truncated: roots.length > MAX_NAME_MATCHES,
    trees,
  };
}

export function formatProcessTree(result) {
  const header = result.query.pid
    ? `[process tree pid=${result.query.pid} matches=${result.matchCount}]`
    : `[process tree name="${result.query.name}" matches=${result.matchCount}${result.truncated ? " truncated" : ""}]`;
  const bodies = result.trees.map(formatOneTree).join("\n\n");
  return `${header}\n\n${bodies}`;
}

function resolveTreeRoots({ pid, name }) {
  if (pid !== undefined && pid !== null && pid !== "") {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("pid must be a positive integer.");
    }
    return readProcessSnapshot(n) ? [n] : [];
  }
  if (name) {
    return findPidsByProcessName(name);
  }
  throw new Error("get_process_tree requires pid or name.");
}

function buildOneTree(pid) {
  const ancestors = listAncestorPids(pid).map((ancestor) => describePid(ancestor));
  const self = describePid(pid);
  const childPids = listChildPids(pid);
  const descendants = listDescendantPids(pid);
  const children = childPids.slice(0, MAX_CHILDREN_SHOWN).map((child) => ({
    ...describePid(child),
    childCount: listChildPids(child).length,
  }));
  return {
    pid,
    ancestors,
    self,
    children,
    descendantCount: descendants.length,
    childrenTruncated: childPids.length > MAX_CHILDREN_SHOWN,
  };
}

function describePid(pid) {
  const snap = readProcessSnapshot(pid);
  return {
    pid,
    command: snap?.command || "(gone)",
    alive: Boolean(snap),
  };
}

function formatOneTree(tree) {
  const lines = [];
  let indent = 0;
  for (const ancestor of tree.ancestors) {
    lines.push(`${"  ".repeat(indent)}pid=${ancestor.pid}  ${shortCommand(ancestor.command)}`);
    indent += 1;
  }
  lines.push(`${"  ".repeat(indent)}pid=${tree.self.pid}  ${shortCommand(tree.self.command)}  [requested]`);
  indent += 1;
  for (const child of tree.children) {
    const extra = child.childCount ? `  (+${child.childCount} child${child.childCount === 1 ? "" : "ren"})` : "";
    lines.push(`${"  ".repeat(indent)}pid=${child.pid}  ${shortCommand(child.command)}${extra}`);
  }
  if (tree.childrenTruncated) {
    lines.push(`${"  ".repeat(indent)}… more children omitted`);
  }
  if (tree.descendantCount > tree.children.length) {
    lines.push(`${"  ".repeat(indent)}(${tree.descendantCount} descendants total)`);
  }
  return lines.join("\n");
}

function shortCommand(command) {
  const text = String(command || "").trim();
  if (text.length <= 160) {
    return text;
  }
  return `${text.slice(0, 157)}…`;
}

export function listRunningAppNames() {
  if (process.platform !== "darwin") {
    return [];
  }
  const result = spawnSync(
    "osascript",
    ["-e", 'tell application "System Events" to get name of every process'],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not list running apps: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return (result.stdout || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Ask a running macOS application to quit. Exact name match only (case-sensitive,
 * as shown by System Events). Does not kill processes by substring.
 */
export function quitApp(name) {
  if (process.platform !== "darwin") {
    throw new Error("quit_app is only available on macOS.");
  }
  const app = assertProcessName(name);
  const running = listRunningAppNames();
  if (!running.includes(app)) {
    const caseHit = running.filter((item) => item.toLowerCase() === app.toLowerCase());
    const hint = caseHit.length
      ? ` Exact name is case-sensitive. Did you mean: ${caseHit.join(", ")}?`
      : running.length
        ? ` Running apps include: ${running.slice(0, 20).join(", ")}${running.length > 20 ? ", …" : ""}.`
        : "";
    throw new Error(`No running application named "${app}".${hint}`);
  }

  const result = spawnSync("osascript", ["-e", `tell application "${app}" to quit`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`quit_app "${app}" failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return {
    name: app,
    message: `Sent quit to application "${app}". GUI-supervised helpers (e.g. Ollama's server) should exit with it.`,
  };
}
