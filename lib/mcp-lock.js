import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pastepatchConfigDir } from "./tunnel.js";

/**
 * Single-instance lock for pastepatch --mcp.
 * Stored at ~/.pastepatch/mcp.lock so a second MCP process exits instead of
 * competing for the same Cloudflare tunnel / ChatGPT connection.
 */

export function mcpLockPath() {
  return path.join(pastepatchConfigDir(), "mcp.lock");
}

/**
 * @returns {Promise<{ pid: number, port?: number, root?: string, hostname?: string, startedAt?: string } | null>}
 */
export async function readMcpLock(lockPath = mcpLockPath()) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data.pid !== "number") {
      return null;
    }
    return data;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    // Corrupt lock — treat as absent
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we cannot signal it
    if (error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * If another live pastepatch --mcp holds the lock, throw a clear Error.
 * Stale locks (dead PID) are ignored.
 *
 * @returns {Promise<{ pid: number, port?: number, root?: string, hostname?: string, startedAt?: string } | null>}
 */
export async function findLiveMcpLock(lockPath = mcpLockPath()) {
  const existing = await readMcpLock(lockPath);
  if (!existing) {
    return null;
  }
  if (existing.pid === process.pid) {
    return existing;
  }
  if (!isProcessAlive(existing.pid)) {
    return null;
  }
  return existing;
}

/**
 * Format the "already running" user-facing error.
 */
export function formatMcpAlreadyRunningError(lock, { packageName = "pastepatch" } = {}) {
  const lines = [
    `Another pastepatch MCP session is already running on this machine (pid ${lock.pid}).`,
  ];
  if (lock.root) {
    lines.push(`  Editing:  ${lock.root}`);
  }
  if (lock.port) {
    lines.push(`  Local:    http://127.0.0.1:${lock.port}/mcp`);
  }
  if (lock.hostname) {
    lines.push(`  Public:   https://${lock.hostname}/mcp`);
  }
  if (lock.startedAt) {
    lines.push(`  Started:  ${lock.startedAt}`);
  }
  lines.push("");
  lines.push(
    "Only one MCP instance should run at a time — a second process can steal the",
  );
  lines.push(
    "Cloudflare tunnel and drop or scramble the ChatGPT connection.",
  );
  lines.push("");
  lines.push("Stop the other session first:");
  lines.push("  • In the other terminal: Ctrl+C");
  lines.push(
    "  • From ChatGPT (if still connected): call the stop_session tool",
  );
  lines.push(`  • Or: kill ${lock.pid}`);
  lines.push("");
  lines.push(`Then start again with: ${packageName} --mcp`);
  return lines.join("\n");
}

/**
 * Acquire the MCP lock for this process. Throws if another live instance holds it.
 */
export async function acquireMcpLock(
  {
    pid = process.pid,
    port,
    root,
    hostname = "",
    packageName = "pastepatch",
    lockPath = mcpLockPath(),
  } = {},
) {
  const live = await findLiveMcpLock(lockPath);
  if (live && live.pid !== pid) {
    const error = new Error(formatMcpAlreadyRunningError(live, { packageName }));
    error.code = "PASTEPATCH_MCP_ALREADY_RUNNING";
    error.lock = live;
    throw error;
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  const payload = {
    pid,
    port: port ?? null,
    root: root || null,
    hostname: hostname || null,
    startedAt: new Date().toISOString(),
  };
  await writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/**
 * Release the lock if it still belongs to this process (or force).
 */
export async function releaseMcpLock({
  pid = process.pid,
  force = false,
  lockPath = mcpLockPath(),
} = {}) {
  const existing = await readMcpLock(lockPath);
  if (!existing) {
    return false;
  }
  if (!force && existing.pid !== pid) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
