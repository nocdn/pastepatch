import os from "node:os";
import path from "node:path";
import { lstat } from "node:fs/promises";

/**
 * Resolve and validate the MCP project root.
 * Refuses home directory and filesystem root unless path was explicit.
 */
export async function resolveProjectRoot({
  pathArg = ".",
  pathExplicit = false,
  allowHome = false,
} = {}) {
  const root = path.resolve(pathArg);
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Project path does not exist: ${root}`);
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Project path is not a directory: ${root}`);
  }

  const home = path.resolve(os.homedir());
  const isHome = root === home;
  const isFsRoot = root === path.parse(root).root;

  if ((isHome || isFsRoot) && !pathExplicit && !allowHome) {
    throw new Error(
      `Refusing to bind MCP to ${isHome ? "your home directory" : "the filesystem root"} (${root}).\n` +
        `That is almost always the wrong project root.\n\n` +
        `cd into the project you want to edit, or pass an explicit path:\n` +
        `  pastepatch --mcp --path /path/to/project\n\n` +
        `If you really mean this directory, pass --path ${root} (or --allow-home).`,
    );
  }

  return root;
}

/**
 * Multi-line banner so the bound project is unmistakable in the terminal.
 */
export function formatProjectBanner({
  root,
  port,
  hostname = "",
  verbose = false,
  noTunnel = false,
  allowOutside = false,
} = {}) {
  const lines = [
    "",
    "════════════════════════════════════════════════════════════",
    "pastepatch MCP",
    `Editing:  ${root}`,
    `Local:    http://127.0.0.1:${port}/mcp`,
  ];
  if (hostname) {
    lines.push(`Public:   https://${hostname}/mcp`);
  } else if (noTunnel) {
    lines.push("Public:   (none — --no-tunnel)");
  }
  lines.push(`Verbose:  ${verbose ? "on" : "off"}`);
  if (allowOutside) {
    lines.push("Sandbox:  OFF (--allow-outside) — tools may leave this directory");
  } else {
    lines.push("Sandbox:  ON — tools cannot read/write outside this directory");
  }
  lines.push("════════════════════════════════════════════════════════════");
  lines.push("");
  return lines.join("\n");
}
