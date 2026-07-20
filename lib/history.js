import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  assertDirectoryPathSafe,
  assertParentPathSafe,
  assertRemovableCurrentPathSafe,
  normalizeRelativePath,
  resolveToolPath,
} from "./fs-ops.js";

export async function createHistoryEntry(calls, root = process.cwd(), options = {}) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const historyDirectory = await historyDir(root);
  const historyPath = path.join(historyDirectory, `${id}.json`);
  const affectedPaths = [...new Set(calls.flatMap((call) => affectedPathsForCall(call, root, options)))];
  const snapshots = [];

  for (const relativePath of affectedPaths) {
    snapshots.push(await snapshotPath(relativePath, root, options));
  }

  const entry = {
    id,
    version: 1,
    createdAt: new Date().toISOString(),
    cwd: path.resolve(root),
    callsDigest: toolPlanDigest(calls),
    calls: calls.map(redactLargeFields),
    snapshots,
  };

  await mkdir(historyDirectory, { recursive: true });
  await writeFile(historyPath, JSON.stringify(entry, null, 2), "utf8");
  return { ...entry, path: historyPath };
}

export function affectedPathsForCall(call, root = process.cwd(), options = {}) {
  if (call.tool === "move_file") {
    return [call.from, call.to].filter(Boolean).map((p) => normalizeRelativePath(p, root, options));
  }

  if (call.path) {
    return [normalizeRelativePath(call.path, root, options)];
  }

  return [];
}

export async function snapshotPath(relativePath, root = process.cwd(), options = {}) {
  const absolutePath = resolveToolPath(relativePath, root, options);
  const normalizedPath = normalizeRelativePath(relativePath, root, options);

  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`${normalizedPath}: symbolic links are not supported.`);
    }

    if (stats.isDirectory()) {
      return {
        path: normalizedPath,
        type: "directory",
        entries: await snapshotDirectory(absolutePath, normalizedPath),
      };
    }

    return {
      path: normalizedPath,
      type: "file",
      content: (await readFile(absolutePath)).toString("base64"),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { path: normalizedPath, type: "missing" };
    }
    throw error;
  }
}

async function snapshotDirectory(absoluteDirectory, relativeDirectory) {
  const entries = [];
  const directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });

  for (const entry of directoryEntries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(absoluteDirectory, entry.name);

    if (entry.isDirectory()) {
      entries.push({
        path: normalizeRelativePath(relativePath),
        type: "directory",
      });
      entries.push(...(await snapshotDirectory(absolutePath, relativePath)));
      continue;
    }

    if (entry.isSymbolicLink()) {
      throw new Error(`${normalizeRelativePath(relativePath)}: symbolic links are not supported.`);
    }

    entries.push({
      path: normalizeRelativePath(relativePath),
      type: "file",
      content: (await readFile(absolutePath)).toString("base64"),
    });
  }

  return entries;
}

function resolveHistoryPath(storedPath, root, options = {}) {
  if (options.allowOutside || path.isAbsolute(storedPath)) {
    return resolveToolPath(storedPath, root, { allowOutside: true });
  }
  return resolveToolPath(storedPath, root, options);
}

export async function restoreSnapshot(snapshot, root = process.cwd(), options = {}) {
  if (snapshot.type === "file") {
    const target = resolveHistoryPath(snapshot.path, root, options);
    await assertParentPathSafe(target, root, options);
    await mkdir(path.dirname(target), { recursive: true });
    await assertDirectoryPathSafe(path.dirname(target), root, options);
    await writeFile(target, Buffer.from(snapshot.content, "base64"));
    return;
  }

  if (snapshot.type === "directory") {
    const directory = resolveHistoryPath(snapshot.path, root, options);
    await assertParentPathSafe(directory, root, options);
    await mkdir(directory, { recursive: true });
    await assertDirectoryPathSafe(directory, root, options);
    for (const entry of snapshot.entries) {
      if (entry.type === "directory") {
        const entryDirectory = resolveHistoryPath(entry.path, root, options);
        await assertParentPathSafe(entryDirectory, root, options);
        await mkdir(entryDirectory, { recursive: true });
        await assertDirectoryPathSafe(entryDirectory, root, options);
        continue;
      }

      const target = resolveHistoryPath(entry.path, root, options);
      await assertParentPathSafe(target, root, options);
      await mkdir(path.dirname(target), { recursive: true });
      await assertDirectoryPathSafe(path.dirname(target), root, options);
      await writeFile(target, Buffer.from(entry.content, "base64"));
    }
  }
}

export async function readLatestHistoryEntryForCwd(root = process.cwd()) {
  const directory = await historyDir(root);
  const resolvedRoot = path.resolve(root);

  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const historyFiles = files.filter((file) => file.endsWith(".json")).sort().reverse();

  for (const file of historyFiles) {
    const historyPath = path.join(directory, file);
    const entry = JSON.parse(await readFile(historyPath, "utf8"));
    if (path.resolve(entry.cwd || process.cwd()) === resolvedRoot) {
      return { ...entry, historyPath };
    }
  }

  return null;
}

export async function readLatestUndoableHistoryEntry(root = process.cwd()) {
  const directory = await historyDir(root);

  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const historyFiles = files.filter((file) => file.endsWith(".json")).sort().reverse();

  for (const file of historyFiles) {
    const historyPath = path.join(directory, file);
    const entry = JSON.parse(await readFile(historyPath, "utf8"));
    if (!entry.undoneAt) {
      return { ...entry, historyPath };
    }
  }

  return null;
}

export async function undoLatestChange(root = process.cwd(), options = {}) {
  const entry = await readLatestUndoableHistoryEntry(root);

  if (!entry) {
    throw new Error("No pastepatch history entry to undo.");
  }

  const entryRoot = path.resolve(entry.cwd || root);

  // History may include absolute paths from --allow-outside sessions
  const undoOptions = { allowOutside: true };
  for (const snapshot of entry.snapshots) {
    await assertRemovableCurrentPathSafe(snapshot.path, entryRoot, undoOptions);
    await rm(resolveHistoryPath(snapshot.path, entryRoot, undoOptions), { recursive: true, force: true });
  }

  for (const snapshot of entry.snapshots) {
    if (snapshot.type !== "missing") {
      await restoreSnapshot(snapshot, entryRoot, undoOptions);
    }
  }

  entry.undoneAt = new Date().toISOString();
  await writeFile(entry.historyPath, JSON.stringify(stripHistoryPath(entry), null, 2), "utf8");
  return entry;
}

export async function findDuplicateAppliedPlan(calls, root = process.cwd()) {
  const entry = await readLatestHistoryEntryForCwd(root);
  if (!entry?.callsDigest || entry.callsDigest !== toolPlanDigest(calls)) {
    return null;
  }

  return entry;
}

export function toolPlanDigest(calls) {
  return createHash("sha256").update(stableJsonStringify(calls)).digest("hex");
}

export function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

export function stripHistoryPath(entry) {
  const { historyPath, ...rest } = entry;
  return rest;
}

export function redactLargeFields(call) {
  const copy = { ...call };
  for (const field of ["content", "old", "new"]) {
    if (typeof copy[field] === "string") {
      copy[field] = `<${Buffer.byteLength(copy[field])} bytes>`;
    }
  }
  return copy;
}

export async function historyDir(root = process.cwd()) {
  const start = path.resolve(root);
  const gitDirectory = await findGitDirectory(start);
  if (gitDirectory) {
    return path.join(gitDirectory, "pastepatch", "history");
  }

  return path.join(start, ".pastepatch", "history");
}

export async function findGitDirectory(startDirectory) {
  let directory = path.resolve(startDirectory);

  for (;;) {
    const dotGit = path.join(directory, ".git");
    try {
      const stats = await lstat(dotGit);
      if (stats.isDirectory()) {
        return dotGit;
      }

      const gitFile = await readFile(dotGit, "utf8");
      const match = gitFile.match(/^gitdir: (.+)$/m);
      if (match) {
        return path.resolve(directory, match[1].trim());
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

