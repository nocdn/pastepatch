#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
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
import process from "node:process";

async function main() {
  const packageInfo = await readPackageInfo();
  const logger = createLogger();

  try {
    const args = parseArgs(process.argv.slice(2), packageInfo);

    if (args.help) {
      process.stdout.write(helpText(packageInfo));
      return;
    }

    if (args.version) {
      process.stdout.write(`${packageInfo.version}\n`);
      return;
    }

    if (args.log) {
      await runLog();
      return;
    }

    if (args.undo) {
      await runUndo(logger);
      return;
    }

    if (args.init) {
      await runInit(args, packageInfo, logger);
      return;
    }

    if (args.edit) {
      await runEdit(args, logger);
      return;
    }

    throw new Error(`Choose --init, --edit, --undo, or --log. Run ${commandName(packageInfo)} --help for usage.`);
  } catch (error) {
    await logger(`ERROR ${error.stack || error.message}`);
    process.stderr.write(`Error: ${error.message}\n`);
    process.stderr.write(`Log: ${logPath()}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv, packageInfo) {
  const args = {
    help: false,
    version: false,
    init: false,
    edit: false,
    undo: false,
    log: false,
    path: ".",
    stdout: false,
    noClipboard: false,
    dryRun: false,
    yes: false,
    task: "",
    include: [],
    exclude: [],
    ingestArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }

    if (arg === "-v" || arg === "--version") {
      args.version = true;
      continue;
    }

    if (arg === "--init") {
      args.init = true;
      continue;
    }

    if (arg === "--edit") {
      args.edit = true;
      continue;
    }

    if (arg === "--undo") {
      args.undo = true;
      continue;
    }

    if (arg === "--log" || arg === "--last-log") {
      args.log = true;
      continue;
    }

    if (arg === "--stdout") {
      args.stdout = true;
      continue;
    }

    if (arg === "--no-clipboard") {
      args.noClipboard = true;
      continue;
    }

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "-y" || arg === "--yes") {
      args.yes = true;
      continue;
    }

    if (arg === "--path") {
      args.path = readOptionValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "-m" || arg === "--message" || arg === "--task") {
      args.task = readOptionValue(argv, (index += 1), arg);
      continue;
    }

    if (arg === "-i" || arg === "--include") {
      args.include.push(readOptionValue(argv, (index += 1), arg));
      continue;
    }

    if (arg === "-e" || arg === "--exclude") {
      args.exclude.push(readOptionValue(argv, (index += 1), arg));
      continue;
    }

    if (arg === "--") {
      args.ingestArgs.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown option "${arg}". Run ${commandName(packageInfo)} --help for usage.`,
      );
    }

    args.path = arg;
  }

  const modes = [args.init, args.edit, args.undo, args.log].filter(Boolean).length;
  if (modes > 1) {
    throw new Error("Choose only one mode: --init, --edit, --undo, or --log.");
  }

  return args;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function runInit(args, packageInfo, logger) {
  const root = path.resolve(args.path);
  await logger(`INIT root=${root}`);

  const task = args.task || (await readInitialTask());
  await logger(`INIT taskBytes=${Buffer.byteLength(task)}`);

  const digest = await runIngest(root, args, logger);
  const prompt = buildPrompt(packageInfo, root, digest, task);

  if (args.stdout || args.noClipboard) {
    process.stdout.write(prompt);
    if (!prompt.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }

  if (!args.noClipboard) {
    await copyToClipboard(prompt, logger);
    process.stderr.write("ChatGPT coding prompt copied to clipboard. Paste it into ChatGPT.\n");
  }

  await logger(`INIT complete promptBytes=${Buffer.byteLength(prompt)}`);
}

async function readInitialTask() {
  if (!process.stdin.isTTY) {
    return "";
  }

  process.stderr.write(
    "What do you want ChatGPT to implement in the first turn? Paste/type instructions, then press Enter on an empty line.\n",
  );

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const lines = [];

  try {
    for (;;) {
      const line = await rl.question("");
      if (line === "") {
        break;
      }
      lines.push(line);
    }
  } catch (error) {
    if (error.code !== "ERR_USE_AFTER_CLOSE") {
      throw error;
    }
  } finally {
    rl.close();
  }

  return lines.join("\n").trim();
}

async function runIngest(root, args, logger) {
  const ingestArgs = ["@nocdn/ingest", root, "--stdout"];

  for (const pattern of args.include) {
    ingestArgs.push("--include", pattern);
  }

  for (const pattern of args.exclude) {
    ingestArgs.push("--exclude", pattern);
  }

  ingestArgs.push(...args.ingestArgs);
  await logger(`INGEST bunx ${ingestArgs.map(shellQuote).join(" ")}`);

  try {
    return await runCommand("bunx", ingestArgs, { cwd: root });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await logger("INGEST bunx not found; falling back to npx -y @nocdn/ingest");
    return await runCommand("npx", ["-y", ...ingestArgs], { cwd: root });
  }
}

function buildPrompt(packageInfo, root, digest, task) {
  return `You are helping me code in ChatGPT, but you do not have live filesystem tools.

The codebase digest below is the current source of truth for this project at:
${root}

My requested change for your first response is:

${task || "No specific first-turn task was provided. Ask me what to change before producing a tool plan."}

We will keep using this same ChatGPT conversation for follow-up coding tasks. After you output a tool plan, I will apply it locally with the CLI and then report whether it succeeded. For follow-ups, use the original digest plus the tool plans that were applied as your working model of the repo. If uncertain, ask me to regenerate and paste a fresh --init digest.

When you propose code changes, put the JSON tool plan first, in one fenced json code block. If you want to say anything else—what changed, which files changed, disclaimers, answers to my questions, testing notes, or any other explanation—put that prose after the code block, outside the code block. Never put prose before the JSON code block.

The JSON must be either an array of tool calls or an object with a "tools" array. Each tool call must be an object with a "tool" field.

Available tools that my local ${packageInfo.name} CLI can execute:

1. create_file
   Creates or overwrites a UTF-8 text file.
   Required fields: "path", "content"

2. replace_in_file
   Replaces text inside a UTF-8 text file. Prefer this for edits to existing files.
   Required fields: "path", "old", "new"
   Optional fields: "replaceAll" (boolean, default false)
   Rules: "old" must be an exact string from the digest. If replaceAll is false, "old" must occur exactly once.

3. delete_file
   Deletes an existing file or empty/non-empty directory.
   Required fields: "path"

4. move_file
   Renames or moves a file/directory.
   Required fields: "from", "to"

5. append_to_file
   Appends UTF-8 text to a file, creating parent directories if needed.
   Required fields: "path", "content"

Example output:

\`\`\`json
[
  {
    "tool": "replace_in_file",
    "path": "README.md",
    "old": "old exact text",
    "new": "new exact text"
  },
  {
    "tool": "create_file",
    "path": "src/example.js",
    "content": "export const ok = true;\\n"
  }
]
\`\`\`

Important instructions:
- Use relative paths only.
- Never use "." as a path.
- Never use paths containing ".." or absolute paths.
- Do not target symbolic links.
- Keep edits small and targeted.
- If you need to change an existing file, use replace_in_file with a large enough exact old string to be unique.
- Do not invent read/list/shell tools. You only have the tools above.
- Put the JSON tool plan first. Any explanation or answer must come after the code block, outside the code block.

CODEBASE DIGEST START

${digest}

CODEBASE DIGEST END
`;
}

async function runEdit(args, logger) {
  const root = process.cwd();
  const input = await readToolPlanInput();
  const calls = parseToolCalls(input);

  if (calls.length === 0) {
    throw new Error("No tool calls found in pasted input.");
  }

  process.stderr.write(`Parsed ${calls.length} tool call${calls.length === 1 ? "" : "s"}.\n`);
  for (const [index, call] of calls.entries()) {
    process.stderr.write(`${index + 1}. ${describeCall(call)}\n`);
  }

  await preflightToolCalls(calls, root);

  if (args.dryRun) {
    process.stderr.write(`Dry run complete; no files changed.\nLog: ${logPath()}\n`);
    await logger("EDIT dry-run complete");
    return;
  }

  if (!args.yes && process.stdin.isTTY) {
    const confirmed = await confirm("Apply these changes? [y/N] ");
    if (!confirmed) {
      process.stderr.write("Aborted.\n");
      await logger("EDIT aborted by user");
      return;
    }
  }

  const history = await createHistoryEntry(calls, root);
  await logger(`HISTORY saved ${history.path}`);

  for (const [index, call] of calls.entries()) {
    await logger(`TOOL ${index + 1}/${calls.length} ${JSON.stringify(redactLargeFields(call))}`);
    await executeToolCall(call, root);
  }

  process.stderr.write(`Changes applied.\nUndo with: pastepatch --undo\nLog: ${logPath()}\n`);
  await logger("EDIT complete dryRun=false");
}

async function runUndo(logger) {
  const entry = await readLatestUndoableHistoryEntry();

  if (!entry) {
    throw new Error("No pastepatch history entry to undo.");
  }

  const root = path.resolve(entry.cwd || process.cwd());

  for (const snapshot of entry.snapshots) {
    await assertRemovableCurrentPathSafe(snapshot.path, root);
    await rm(safePath(snapshot.path, root), { recursive: true, force: true });
  }

  for (const snapshot of entry.snapshots) {
    if (snapshot.type !== "missing") {
      await restoreSnapshot(snapshot, root);
    }
  }

  entry.undoneAt = new Date().toISOString();
  await writeFile(entry.historyPath, JSON.stringify(stripHistoryPath(entry), null, 2), "utf8");
  await logger(`UNDO ${entry.id}`);
  process.stderr.write(
    `Undid ${entry.calls.length} tool call${entry.calls.length === 1 ? "" : "s"} from ${entry.createdAt}.\nLog: ${logPath()}\n`,
  );
}

async function runLog() {
  try {
    process.stdout.write(await readFile(logPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      process.stdout.write(`No pastepatch log found at ${logPath()}\n`);
      return;
    }
    throw error;
  }
}

async function createHistoryEntry(calls, root = process.cwd()) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const historyDirectory = await historyDir();
  const historyPath = path.join(historyDirectory, `${id}.json`);
  const affectedPaths = [...new Set(calls.flatMap(affectedPathsForCall))];
  const snapshots = [];

  for (const relativePath of affectedPaths) {
    snapshots.push(await snapshotPath(relativePath, root));
  }

  const entry = {
    id,
    version: 1,
    createdAt: new Date().toISOString(),
    cwd: root,
    calls: calls.map(redactLargeFields),
    snapshots,
  };

  await mkdir(historyDirectory, { recursive: true });
  await writeFile(historyPath, JSON.stringify(entry, null, 2), "utf8");
  return { ...entry, path: historyPath };
}

function affectedPathsForCall(call) {
  if (call.tool === "move_file") {
    return [call.from, call.to].filter(Boolean).map(normalizeRelativePath);
  }

  if (call.path) {
    return [normalizeRelativePath(call.path)];
  }

  return [];
}

async function snapshotPath(relativePath, root = process.cwd()) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const absolutePath = safePath(normalizedPath, root);

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

async function restoreSnapshot(snapshot, root = process.cwd()) {
  if (snapshot.type === "file") {
    const target = safePath(snapshot.path, root);
    await assertParentPathSafe(target, root);
    await mkdir(path.dirname(target), { recursive: true });
    await assertDirectoryPathSafe(path.dirname(target), root);
    await writeFile(target, Buffer.from(snapshot.content, "base64"));
    return;
  }

  if (snapshot.type === "directory") {
    const directory = safePath(snapshot.path, root);
    await assertParentPathSafe(directory, root);
    await mkdir(directory, { recursive: true });
    await assertDirectoryPathSafe(directory, root);
    for (const entry of snapshot.entries) {
      if (entry.type === "directory") {
        const entryDirectory = safePath(entry.path, root);
        await assertParentPathSafe(entryDirectory, root);
        await mkdir(entryDirectory, { recursive: true });
        await assertDirectoryPathSafe(entryDirectory, root);
        continue;
      }

      const target = safePath(entry.path, root);
      await assertParentPathSafe(target, root);
      await mkdir(path.dirname(target), { recursive: true });
      await assertDirectoryPathSafe(path.dirname(target), root);
      await writeFile(target, Buffer.from(entry.content, "base64"));
    }
  }
}

async function readLatestUndoableHistoryEntry() {
  const directory = await historyDir();

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

function stripHistoryPath(entry) {
  const { historyPath, ...rest } = entry;
  return rest;
}

async function historyDir() {
  const gitDirectory = await findGitDirectory(process.cwd());
  if (gitDirectory) {
    return path.join(gitDirectory, "pastepatch", "history");
  }

  return path.join(process.cwd(), ".pastepatch", "history");
}

async function findGitDirectory(startDirectory) {
  let directory = startDirectory;

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

async function readToolPlanInput() {
  if (!process.stdin.isTTY) {
    return await readStream(process.stdin);
  }

  process.stderr.write("Reading ChatGPT JSON tool plan from clipboard...\n");
  const input = await readClipboard();

  if (!input.trim()) {
    throw new Error("Clipboard is empty. Copy ChatGPT's JSON tool plan, then run --edit again.");
  }

  return input;
}

async function readClipboard() {
  const commands = clipboardReadCommands();
  const errors = [];

  for (const [command, args] of commands) {
    try {
      return await runCommand(command, args);
    } catch (error) {
      errors.push(`${command}: ${error.message}`);
    }
  }

  throw new Error(
    `Could not read from the system clipboard. You can still pipe input with: pbpaste | pastepatch --edit. ${errors.join(" ")}`,
  );
}

function clipboardReadCommands() {
  if (process.platform === "darwin") {
    return [["pbpaste", []]];
  }

  if (process.platform === "win32") {
    return [["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"]]];
  }

  return [
    ["wl-paste", []],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ];
}

function parseToolCalls(input) {
  const candidates = extractJsonCandidates(input);
  const errors = [];

  for (const candidate of candidates) {
    try {
      return normalizeToolPlan(JSON.parse(candidate));
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(
    `Clipboard/input does not contain a valid JSON tool plan. Copy ChatGPT's fenced json code block using the code block copy button, then run --edit again. ${errors.join(" ")}`.trim(),
  );
}

function extractJsonCandidates(input) {
  const candidates = [];
  const fencePattern = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let match;

  while ((match = fencePattern.exec(input)) !== null) {
    candidates.push(match[1].trim());
  }

  const trimmed = input.trim();
  if (trimmed) {
    candidates.push(trimmed);
  }

  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray !== -1 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1));
  }

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject !== -1 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }

  return [...new Set(candidates)];
}

function normalizeToolPlan(plan) {
  const rawCalls = Array.isArray(plan) ? plan : plan.tools || plan.tool_calls || plan.calls;

  if (!Array.isArray(rawCalls)) {
    throw new Error("Tool plan must be an array or an object with a tools array.");
  }

  return rawCalls.map((call) => {
    if (!call || typeof call !== "object") {
      throw new Error("Each tool call must be an object.");
    }

    const tool = call.tool || call.name;
    const args = normalizeCallArguments(call);

    if (!tool || typeof tool !== "string") {
      throw new Error("Each tool call needs a string tool field.");
    }

    return { ...args, tool };
  });
}

function normalizeCallArguments(call) {
  if (!Object.prototype.hasOwnProperty.call(call, "arguments")) {
    return call;
  }

  if (typeof call.arguments === "string") {
    return JSON.parse(call.arguments);
  }

  if (call.arguments && typeof call.arguments === "object") {
    return call.arguments;
  }

  throw new Error("Tool call arguments must be an object or JSON object string.");
}

async function preflightToolCalls(calls, root = process.cwd()) {
  for (const [index, call] of calls.entries()) {
    try {
      await validateToolCall(call, root);
    } catch (error) {
      throw new Error(`Tool call ${index + 1} (${call.tool || "unknown"}): ${error.message}`);
    }
  }
}

async function validateToolCall(call, root = process.cwd()) {
  switch (call.tool) {
    case "create_file":
      requireString(call.path, "path", call.tool);
      requireString(call.content, "content", call.tool);
      await assertWritableFileTarget(call.path, root);
      return;

    case "append_to_file":
      requireString(call.path, "path", call.tool);
      requireString(call.content, "content", call.tool);
      await assertWritableFileTarget(call.path, root);
      return;

    case "replace_in_file":
    case "amend_file":
    case "amend":
      requireString(call.path, "path", call.tool);
      requireString(call.old, "old", call.tool);
      requireString(call.new, "new", call.tool);
      await assertReadableFileTarget(call.path, root);
      await validateReplacement(call.path, call.old, Boolean(call.replaceAll), root);
      return;

    case "delete_file":
      requireString(call.path, "path", call.tool);
      await assertDeletableTarget(call.path, root);
      return;

    case "move_file":
      requireString(call.from, "from", call.tool);
      requireString(call.to, "to", call.tool);
      await assertMovableSource(call.from, root);
      await assertWritableMoveTarget(call.to, root);
      return;

    default:
      throw new Error(`Unknown tool "${call.tool}".`);
  }
}

async function executeToolCall(call, root = process.cwd()) {
  switch (call.tool) {
    case "create_file":
      requireString(call.path, "path", call.tool);
      requireString(call.content, "content", call.tool);
      await writeTextFile(call.path, call.content, root);
      return;

    case "append_to_file":
      requireString(call.path, "path", call.tool);
      requireString(call.content, "content", call.tool);
      await appendTextFile(call.path, call.content, root);
      return;

    case "replace_in_file":
    case "amend_file":
    case "amend":
      requireString(call.path, "path", call.tool);
      requireString(call.old, "old", call.tool);
      requireString(call.new, "new", call.tool);
      await replaceInFile(call.path, call.old, call.new, Boolean(call.replaceAll), root);
      return;

    case "delete_file":
      requireString(call.path, "path", call.tool);
      await assertDeletableTarget(call.path, root);
      await rm(safePath(call.path, root), { recursive: true, force: false });
      return;

    case "move_file":
      requireString(call.from, "from", call.tool);
      requireString(call.to, "to", call.tool);
      await assertMovableSource(call.from, root);
      await assertWritableMoveTarget(call.to, root);
      await mkdir(path.dirname(safePath(call.to, root)), { recursive: true });
      await assertDirectoryPathSafe(path.dirname(safePath(call.to, root)), root);
      await rename(safePath(call.from, root), safePath(call.to, root));
      return;

    default:
      throw new Error(`Unknown tool "${call.tool}".`);
  }
}

async function writeTextFile(relativePath, content, root = process.cwd()) {
  await assertWritableFileTarget(relativePath, root);
  const target = safePath(relativePath, root);
  await assertParentPathSafe(target, root);
  await mkdir(path.dirname(target), { recursive: true });
  await assertDirectoryPathSafe(path.dirname(target), root);
  await writeFile(target, content, "utf8");
}

async function appendTextFile(relativePath, content, root = process.cwd()) {
  await assertWritableFileTarget(relativePath, root);
  const target = safePath(relativePath, root);
  await assertParentPathSafe(target, root);
  await mkdir(path.dirname(target), { recursive: true });
  await assertDirectoryPathSafe(path.dirname(target), root);
  await appendFile(target, content, "utf8");
}

async function replaceInFile(relativePath, oldText, newText, replaceAll, root = process.cwd()) {
  await assertReadableFileTarget(relativePath, root);
  const target = safePath(relativePath, root);
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

async function validateReplacement(relativePath, oldText, replaceAll, root = process.cwd()) {
  const target = safePath(relativePath, root);
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

async function assertWritableFileTarget(relativePath, root = process.cwd()) {
  const target = safePath(relativePath, root);
  await assertParentPathSafe(target, root);

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`${relativePath}: symbolic links are not supported.`);
    }

    if (!stats.isFile()) {
      throw new Error(`${relativePath}: target must be a file.`);
    }

    await assertRealPathInsideRoot(target, root);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function assertReadableFileTarget(relativePath, root = process.cwd()) {
  const target = safePath(relativePath, root);
  const stats = await assertExistingTarget(relativePath, root);

  if (!stats.isFile()) {
    throw new Error(`${relativePath}: target must be a file.`);
  }

  await assertRealPathInsideRoot(target, root);
}

async function assertDeletableTarget(relativePath, root = process.cwd()) {
  const target = safePath(relativePath, root);
  const stats = await assertExistingTarget(relativePath, root);

  if (stats.isDirectory()) {
    await assertDirectoryTreeHasNoSymlinks(target);
  }
}

async function assertRemovableCurrentPathSafe(relativePath, root = process.cwd()) {
  const target = safePath(relativePath, root);
  await assertParentPathSafe(target, root);

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

async function assertMovableSource(relativePath, root = process.cwd()) {
  const target = safePath(relativePath, root);
  const stats = await assertExistingTarget(relativePath, root);

  if (stats.isDirectory()) {
    await assertDirectoryTreeHasNoSymlinks(target);
  }
}

async function assertWritableMoveTarget(relativePath, root = process.cwd()) {
  const target = safePath(relativePath, root);
  await assertParentPathSafe(target, root);

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`${relativePath}: symbolic links are not supported.`);
    }

    if (stats.isDirectory()) {
      await assertDirectoryTreeHasNoSymlinks(target);
    }

    await assertRealPathInsideRoot(target, root);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function assertExistingTarget(relativePath, root = process.cwd()) {
  const target = safePath(relativePath, root);
  await assertParentPathSafe(target, root);

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`${relativePath}: symbolic links are not supported.`);
    }
    await assertRealPathInsideRoot(target, root);
    return stats;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${relativePath}: path does not exist.`);
    }
    throw error;
  }
}

async function assertParentPathSafe(absolutePath, root = process.cwd()) {
  await assertDirectoryPathSafe(path.dirname(absolutePath), root);
}

async function assertDirectoryPathSafe(absoluteDirectory, root = process.cwd()) {
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

async function assertRealPathInsideRoot(absolutePath, root = process.cwd()) {
  const rootRealPath = await realpath(path.resolve(root));
  const targetRealPath = await realpath(absolutePath);
  assertInsideRoot(targetRealPath, rootRealPath, `${displayPath(absolutePath, root)}: path escapes the project root.`);
}

async function assertDirectoryTreeHasNoSymlinks(absoluteDirectory) {
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

function assertInsideRoot(targetPath, rootPath, message) {
  const relative = path.relative(rootPath, targetPath);
  if (relative === "" || !pathEscapesRoot(relative)) {
    return;
  }

  throw new Error(message);
}

function displayPath(absolutePath, root = process.cwd()) {
  const relative = path.relative(path.resolve(root), absolutePath);
  return relative || ".";
}

function safePath(relativePath, root = process.cwd()) {
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

function pathEscapesRoot(relativePath) {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function normalizeRelativePath(relativePath) {
  safePath(relativePath);
  return path.join(...relativePath.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== "."));
}

function requireString(value, field, tool) {
  if (typeof value !== "string") {
    throw new Error(`${tool} requires a string "${field}" field.`);
  }
}

function countOccurrences(haystack, needle) {
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

function describeCall(call) {
  if (call.tool === "move_file") {
    return `${call.tool}: ${call.from} -> ${call.to}`;
  }
  return `${call.tool}: ${call.path || "(no path)"}`;
}

function redactLargeFields(call) {
  const copy = { ...call };
  for (const field of ["content", "old", "new"]) {
    if (typeof copy[field] === "string") {
      copy[field] = `<${Buffer.byteLength(copy[field])} bytes>`;
    }
  }
  return copy;
}

async function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(message);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function copyToClipboard(text, logger) {
  const command = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
  const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];

  try {
    await runCommand(command, args, { input: text });
  } catch (error) {
    await logger(`CLIPBOARD failed command=${command} error=${error.message}`);
    process.stdout.write(text);
    if (!text.endsWith("\n")) {
      process.stdout.write("\n");
    }
    process.stderr.write("Could not copy to clipboard, so the prompt was printed to stdout instead.\n");
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const error = new Error(`${command} exited with code ${code}: ${stderr.trim()}`);
      error.code = code;
      reject(error);
    });

    if (options.input) {
      child.stdin.end(options.input);
    }
  });
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    let value = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      value += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(value));
  });
}

function createLogger() {
  return async (message) => {
    await mkdir(path.dirname(logPath()), { recursive: true });
    await appendFile(logPath(), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  };
}

function logPath() {
  return path.join(process.cwd(), ".pastepatch.log");
}

function shellQuote(value) {
  return /[^A-Za-z0-9_/:=.,@+-]/.test(value) ? JSON.stringify(value) : value;
}

async function readPackageInfo() {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const rawPackageJson = await readFile(packageJsonPath, "utf8");
  return JSON.parse(rawPackageJson);
}

function commandName(packageInfo) {
  if (packageInfo.bin && typeof packageInfo.bin === "object" && !Array.isArray(packageInfo.bin)) {
    const [name] = Object.keys(packageInfo.bin);
    if (name) {
      return name;
    }
  }

  return packageInfo.name;
}

function helpText(packageInfo) {
  const command = commandName(packageInfo);
  const description = packageInfo.description || "";
  return `${command} ${packageInfo.version}
${description ? `\n${description}\n` : ""}
Usage:
  ${command} --init [path] [options] [-- ingest-options]
  ${command} --edit [options]
  ${command} --undo
  ${command} --log

Examples:
  ${command} --init
  ${command} --init ../my-app --exclude node_modules -- --line-numbers
  ${command} --init --stdout > chatgpt-prompt.txt
  ${command} --edit
  ${command} --edit --dry-run < chatgpt-tools.json
  ${command} --edit --yes < chatgpt-tools.json
  ${command} --undo
  ${command} --log
  ${command} --help
  ${command} --version

Options:
  --init                           Generate the initial ChatGPT coding prompt with a codebase digest.
  --edit                           Apply the ChatGPT JSON tool plan currently on the clipboard.
  --undo                           Undo the most recent applied pastepatch change set.
  --log, --last-log                Print the pastepatch log for the current directory.
  --path <path>                    Project path for --init. A positional path also works. Default: current directory.
  -m, --message, --task <text>      First-turn instructions to include in the --init prompt instead of asking interactively.
  -i, --include <pattern>          Forward an include pattern to @nocdn/ingest. Repeatable.
  -e, --exclude <pattern>          Forward an exclude pattern to @nocdn/ingest. Repeatable.
  --stdout                         Print the --init prompt to stdout. Also copies it unless --no-clipboard is set.
  --no-clipboard                   Do not copy the --init prompt; print it to stdout instead.
  --dry-run                        Validate and preview --edit tool calls without changing files.
  -y, --yes                        Apply --edit tool calls without prompting.
  -h, --help                       Show this help text.
  -v, --version                    Show the package version.

Notes:
  --init runs: bunx @nocdn/ingest <path> --stdout
  Anything after -- is forwarded directly to @nocdn/ingest.
  --edit reads from the clipboard when run interactively, or from stdin when piped.
  --edit stores undo history under .git/pastepatch/history when run inside a git repository.
  --edit writes details and errors to .pastepatch.log in the current directory.
`;
}

main();
