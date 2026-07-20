import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a tool path under the project root.
 * Default (sandboxed): relative only, no "..", no absolute paths, must stay inside root.
 * With allowOutside: absolute paths and ".." are allowed (dangerous — MCP --allow-outside).
 */
export function resolveToolPath(userPath, root = process.cwd(), options = {}) {
  const allowOutside = options.allowOutside === true;

  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new Error("Path must be a non-empty string.");
  }
  if (userPath.includes("\0")) {
    throw new Error("Path must not contain null bytes.");
  }

  if (!allowOutside) {
    return safePath(userPath, root);
  }

  if (
    path.isAbsolute(userPath) ||
    path.posix.isAbsolute(userPath) ||
    path.win32.isAbsolute(userPath) ||
    /^[A-Za-z]:/.test(userPath)
  ) {
    return path.resolve(userPath);
  }

  return path.resolve(root, userPath);
}

export function isPathInsideRoot(absolutePath, root) {
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, path.resolve(absolutePath));
  return relative === "" || !pathEscapesRoot(relative);
}

export async function validateToolCall(call, root = process.cwd(), options = {}) {
  switch (call.tool) {
    case "create_file":
      requireString(call.path, "path", call.tool);
      requireString(call.content, "content", call.tool);
      await assertWritableFileTarget(call.path, root, options);
      return;

    case "append_to_file":
      requireString(call.path, "path", call.tool);
      requireString(call.content, "content", call.tool);
      await assertWritableFileTarget(call.path, root, options);
      return;

    case "replace_in_file":
    case "amend_file":
    case "amend":
      requireString(call.path, "path", call.tool);
      requireString(call.old, "old", call.tool);
      requireString(call.new, "new", call.tool);
      await assertReadableFileTarget(call.path, root, options);
      await validateReplacement(call.path, call.old, Boolean(call.replaceAll), root, options);
      return;

    case "delete_file":
      requireString(call.path, "path", call.tool);
      await assertDeletableTarget(call.path, root, options);
      return;

    case "move_file":
      requireString(call.from, "from", call.tool);
      requireString(call.to, "to", call.tool);
      await assertMovableSource(call.from, root, options);
      await assertWritableMoveTarget(call.to, root, options);
      return;

    default:
      throw new Error(`Unknown tool "${call.tool}".`);
  }
}

export async function executeToolCall(call, root = process.cwd(), options = {}) {
  switch (call.tool) {
    case "create_file":
      requireString(call.path, "path", call.tool);
      requireString(call.content, "content", call.tool);
      await writeTextFile(call.path, call.content, root, options);
      return;

    case "append_to_file":
      requireString(call.path, "path", call.tool);
      requireString(call.content, "content", call.tool);
      await appendTextFile(call.path, call.content, root, options);
      return;

    case "replace_in_file":
    case "amend_file":
    case "amend":
      requireString(call.path, "path", call.tool);
      requireString(call.old, "old", call.tool);
      requireString(call.new, "new", call.tool);
      await replaceInFile(call.path, call.old, call.new, Boolean(call.replaceAll), root, options);
      return;

    case "delete_file":
      requireString(call.path, "path", call.tool);
      await assertDeletableTarget(call.path, root, options);
      await rm(resolveToolPath(call.path, root, options), { recursive: true, force: false });
      return;

    case "move_file":
      requireString(call.from, "from", call.tool);
      requireString(call.to, "to", call.tool);
      await assertMovableSource(call.from, root, options);
      await assertWritableMoveTarget(call.to, root, options);
      await mkdir(path.dirname(resolveToolPath(call.to, root, options)), { recursive: true });
      await assertDirectoryPathSafe(path.dirname(resolveToolPath(call.to, root, options)), root, options);
      await rename(resolveToolPath(call.from, root, options), resolveToolPath(call.to, root, options));
      return;

    default:
      throw new Error(`Unknown tool "${call.tool}".`);
  }
}

export async function readTextFile(relativePath, root = process.cwd(), options = {}) {
  await assertReadableFileTarget(relativePath, root, options);
  const target = resolveToolPath(relativePath, root, options);
  return readFile(target, "utf8");
}

export async function listDirectory(relativePath = ".", root = process.cwd(), options = {}) {
  const absolute =
    relativePath === "." || relativePath === ""
      ? path.resolve(root)
      : resolveToolPath(relativePath, root, options);

  if (relativePath !== "." && relativePath !== "") {
    const stats = await assertExistingTarget(relativePath, root, options);
    if (!stats.isDirectory()) {
      throw new Error(`${relativePath}: target must be a directory.`);
    }
  } else {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`project root: symbolic links are not supported.`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`project root: target must be a directory.`);
    }
  }

  const entries = await readdir(absolute, { withFileTypes: true });
  const lines = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      lines.push(`${entry.name}@`);
      continue;
    }
    if (entry.isDirectory()) {
      lines.push(`${entry.name}/`);
      continue;
    }
    lines.push(entry.name);
  }

  return lines.join("\n");
}

export async function writeTextFile(relativePath, content, root = process.cwd(), options = {}) {
  await assertWritableFileTarget(relativePath, root, options);
  const target = resolveToolPath(relativePath, root, options);
  await assertParentPathSafe(target, root, options);
  await mkdir(path.dirname(target), { recursive: true });
  await assertDirectoryPathSafe(path.dirname(target), root, options);
  await writeFile(target, content, "utf8");
}

export async function appendTextFile(relativePath, content, root = process.cwd(), options = {}) {
  await assertWritableFileTarget(relativePath, root, options);
  const target = resolveToolPath(relativePath, root, options);
  await assertParentPathSafe(target, root, options);
  await mkdir(path.dirname(target), { recursive: true });
  await assertDirectoryPathSafe(path.dirname(target), root, options);
  await appendFile(target, content, "utf8");
}

export async function replaceInFile(relativePath, oldText, newText, replaceAll, root = process.cwd(), options = {}) {
  await assertReadableFileTarget(relativePath, root, options);
  const target = resolveToolPath(relativePath, root, options);
  const current = await readFile(target, "utf8");
  const count = countOccurrences(current, oldText);

  if (count === 0) {
    throw new Error(`${relativePath}: old string was not found.`);
  }

  if (!replaceAll && count !== 1) {
    throw new Error(
      `${relativePath}: old string occurs ${count} times. Use a more specific old string or set replaceAll true.`,
    );
  }

  const updated = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
  await writeFile(target, updated, "utf8");
}

export async function validateReplacement(relativePath, oldText, replaceAll, root = process.cwd(), options = {}) {
  const target = resolveToolPath(relativePath, root, options);
  const current = await readFile(target, "utf8");
  const count = countOccurrences(current, oldText);

  if (count === 0) {
    throw new Error(`${relativePath}: old string was not found.`);
  }

  if (!replaceAll && count !== 1) {
    throw new Error(
      `${relativePath}: old string occurs ${count} times. Use a more specific old string or set replaceAll true.`,
    );
  }
}

export async function assertWritableFileTarget(relativePath, root = process.cwd(), options = {}) {
  const target = resolveToolPath(relativePath, root, options);
  await assertParentPathSafe(target, root, options);

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`${relativePath}: symbolic links are not supported.`);
    }

    if (!stats.isFile()) {
      throw new Error(`${relativePath}: target must be a file.`);
    }

    await assertRealPathInsideRoot(target, root, options);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function assertReadableFileTarget(relativePath, root = process.cwd(), options = {}) {
  const target = resolveToolPath(relativePath, root, options);
  const stats = await assertExistingTarget(relativePath, root, options);

  if (!stats.isFile()) {
    throw new Error(`${relativePath}: target must be a file.`);
  }

  await assertRealPathInsideRoot(target, root, options);
}

export async function assertDeletableTarget(relativePath, root = process.cwd(), options = {}) {
  const target = resolveToolPath(relativePath, root, options);
  const stats = await assertExistingTarget(relativePath, root, options);

  if (stats.isDirectory()) {
    await assertDirectoryTreeHasNoSymlinks(target);
  }
}

export async function assertRemovableCurrentPathSafe(relativePath, root = process.cwd(), options = {}) {
  const target = resolveToolPath(relativePath, root, options);
  await assertParentPathSafe(target, root, options);

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`${relativePath}: symbolic links are not supported.`);
    }

    if (stats.isDirectory()) {
      await assertDirectoryTreeHasNoSymlinks(target);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function assertMovableSource(relativePath, root = process.cwd(), options = {}) {
  const target = resolveToolPath(relativePath, root, options);
  const stats = await assertExistingTarget(relativePath, root, options);

  if (stats.isDirectory()) {
    await assertDirectoryTreeHasNoSymlinks(target);
  }
}

export async function assertWritableMoveTarget(relativePath, root = process.cwd(), options = {}) {
  const target = resolveToolPath(relativePath, root, options);
  await assertParentPathSafe(target, root, options);

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`${relativePath}: symbolic links are not supported.`);
    }

    if (stats.isDirectory()) {
      await assertDirectoryTreeHasNoSymlinks(target);
    }

    await assertRealPathInsideRoot(target, root, options);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function assertExistingTarget(relativePath, root = process.cwd(), options = {}) {
  const target = resolveToolPath(relativePath, root, options);
  await assertParentPathSafe(target, root, options);

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`${relativePath}: symbolic links are not supported.`);
    }
    await assertRealPathInsideRoot(target, root, options);
    return stats;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${relativePath}: path does not exist.`);
    }
    throw error;
  }
}

export async function assertParentPathSafe(absolutePath, root = process.cwd(), options = {}) {
  await assertDirectoryPathSafe(path.dirname(absolutePath), root, options);
}

export async function assertDirectoryPathSafe(absoluteDirectory, root = process.cwd(), options = {}) {
  if (options.allowOutside) {
    return;
  }

  const rootPath = path.resolve(root);
  const rootRealPath = await realpath(rootPath);
  const relativeDirectory = path.relative(rootPath, absoluteDirectory);
  const segments = relativeDirectory ? relativeDirectory.split(path.sep).filter(Boolean) : [];

  let current = rootPath;
  await assertExistingDirectoryComponentSafe(current, rootRealPath, "project root");

  for (const segment of segments) {
    current = path.join(current, segment);

    try {
      await assertExistingDirectoryComponentSafe(current, rootRealPath, displayPath(current, rootPath));
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

async function assertExistingDirectoryComponentSafe(absolutePath, rootRealPath, label) {
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`${label}: parent path contains a symbolic link.`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`${label}: parent path is not a directory.`);
  }

  const realDirectory = await realpath(absolutePath);
  assertInsideRoot(realDirectory, rootRealPath, `${label}: parent path escapes the project root.`);
}

export async function assertRealPathInsideRoot(absolutePath, root = process.cwd(), options = {}) {
  if (options.allowOutside) {
    return;
  }
  const rootRealPath = await realpath(path.resolve(root));
  const targetRealPath = await realpath(absolutePath);
  assertInsideRoot(targetRealPath, rootRealPath, `${displayPath(absolutePath, root)}: path escapes the project root.`);
}

export async function assertDirectoryTreeHasNoSymlinks(absoluteDirectory) {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${absolutePath}: symbolic links are not supported.`);
    }

    if (entry.isDirectory()) {
      await assertDirectoryTreeHasNoSymlinks(absolutePath);
    }
  }
}

export function assertInsideRoot(targetPath, rootPath, message) {
  const relative = path.relative(rootPath, targetPath);
  if (relative === "" || !pathEscapesRoot(relative)) {
    return;
  }

  throw new Error(message);
}

export function displayPath(absolutePath, root = process.cwd()) {
  const relative = path.relative(path.resolve(root), absolutePath);
  return relative || ".";
}

export function safePath(relativePath, root = process.cwd()) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("Path must be a non-empty string.");
  }

  if (relativePath.includes("\0")) {
    throw new Error("Path must not contain null bytes.");
  }

  if (
    path.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new Error(`Refusing absolute path: ${relativePath}`);
  }

  const segments = relativePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Refusing path containing "..": ${relativePath}`);
  }

  const normalizedSegments = segments.filter((segment) => segment !== "" && segment !== ".");
  if (normalizedSegments.length === 0) {
    throw new Error("Path must target a file or subdirectory, not the project root.");
  }

  const rootPath = path.resolve(root);
  const normalized = path.join(...normalizedSegments);
  const target = path.resolve(rootPath, normalized);
  const relativeToRoot = path.relative(rootPath, target);
  if (relativeToRoot === "" || pathEscapesRoot(relativeToRoot)) {
    throw new Error(`Refusing path outside the project root: ${relativePath}`);
  }

  return target;
}

export function pathEscapesRoot(relativePath) {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

export function normalizeRelativePath(relativePath, root = process.cwd(), options = {}) {
  if (options.allowOutside) {
    const absolute = resolveToolPath(relativePath, root, options);
    const rel = path.relative(path.resolve(root), absolute);
    if (rel && !pathEscapesRoot(rel) && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join(path.sep);
    }
    return absolute;
  }
  safePath(relativePath, root);
  return path.join(...relativePath.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== "."));
}

export function requireString(value, field, tool) {
  if (typeof value !== "string") {
    throw new Error(`${tool} requires a string "${field}" field.`);
  }
}

export function countOccurrences(haystack, needle) {
  if (needle === "") {
    throw new Error("old string must not be empty.");
  }

  let count = 0;
  let index = 0;

  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index === -1) {
      return count;
    }
    count += 1;
    index += needle.length;
  }
}

export function describeCall(call) {
  if (call.tool === "move_file") {
    return `${call.tool}: ${call.from} -> ${call.to}`;
  }
  return `${call.tool}: ${call.path || "(no path)"}`;
}
