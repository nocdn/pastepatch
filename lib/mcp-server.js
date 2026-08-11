import { randomUUID } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  executeToolCall,
  listDirectory,
  readTextFile,
  validateToolCall,
} from "./fs-ops.js";
import { createHistoryEntry, undoLatestChange } from "./history.js";
import { findFiles, searchContent } from "./search.js";
import { buildHandoffReport, buildStartHereGuide } from "./agent-prompt.js";
import { createCommandRunner } from "./commands.js";
import { formatSkillsList, listRemoteSkills, readRemoteSkill } from "./skills.js";
import { formatBytes, viewImageFile } from "./view-image.js";

/**
 * Build an MCP server exposing pastepatch filesystem tools for a project root.
 * Follows MCP Streamable HTTP (2025-11-25) + legacy SSE for ChatGPT compatibility.
 *
 * ChatGPT developer mode supports SSE and streaming HTTP, No Auth / OAuth / Mixed.
 * readOnlyHint is set so ChatGPT treats read tools as non-write (no confirmation).
 *
 * @see https://developers.openai.com/api/docs/guides/developer-mode
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 */
export function createPastepatchMcpServer({
  root,
  version = "0.0.0",
  logger = async () => {},
  verbose = false,
  allowOutside = false,
  commandRunner = null,
  /** Called when stop_session tool runs (after response is prepared). */
  onStopSession = null,
} = {}) {
  const resolvedRoot = root;
  const pathOptions = { allowOutside: allowOutside === true };
  const runner =
    commandRunner ||
    createCommandRunner({
      root: resolvedRoot,
      allowOutside: pathOptions.allowOutside,
    });
  const sandboxNote = pathOptions.allowOutside
    ? "Sandbox is DISABLED (--allow-outside): absolute paths and paths outside the project root are allowed. Use extreme care."
    : "Sandbox is ON: only relative paths inside the project root are allowed (no absolute paths, no '..').";

  const server = new McpServer(
    {
      name: "pastepatch",
      version,
    },
    {
      instructions: [
        `You are the model in ChatGPT. pastepatch MCP tools (via a tunnel) let you read, search, edit files, and run shell commands on the user's machine under ${resolvedRoot}.`,
        "Using those tools is how you act as a coding agent for this local project — not a simulated filesystem.",
        sandboxNote,
        "At the start of a coding session call start_here, then orient with search/find_files/list_directory/read_file before edits.",
        pathOptions.allowOutside
          ? "Prefer relative paths under the project root when possible."
          : "Paths must be relative to the project root. Never use absolute paths or '..'.",
        "Prefer replace_in_file with a unique old string. Use search before guessing paths.",
        "Use view_image for screenshots, UI mocks, and other image files — do not use read_file on binary images.",
        "For shell: run_command (waits briefly then may background), get_command_output, stop_command. Some dangerous commands are blocked.",
        "list_remote_skills / read_remote_skill load Agent Skills (SKILL.md) from default remote-machine locations (home + project).",
        "stop_session shuts down the pastepatch MCP process on the remote machine (use when done or switching projects).",
        "When the user needs continuity across chats, call handoff with a full technical report.",
      ].join(" "),
      capabilities: {},
    },
  );

  const textResult = (text) => ({
    content: [{ type: "text", text }],
  });

  const errorResult = (error) => ({
    content: [{ type: "text", text: `Error: ${error.message || String(error)}` }],
    isError: true,
  });

  function previewText(value, max = 120) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text.length <= max) {
      return text;
    }
    return `${text.slice(0, max)}…`;
  }

  /** Short local time for log lines: HH:MM:SS */
  function shortTimestamp(date = new Date()) {
    return date.toTimeString().slice(0, 8);
  }

  /** Count logical lines in a text block (empty → 0). */
  function countLines(text) {
    if (typeof text !== "string" || text.length === 0) {
      return 0;
    }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (normalized === "") {
      return 0;
    }
    // "a\n" → 1 line; "a\nb" → 2; "a\nb\n" → 2
    return normalized.replace(/\n$/, "").split("\n").length;
  }

  function formatLineStats({ added = 0, removed = 0 } = {}) {
    return `+${added} / -${removed}`;
  }

  function summarizeArgs(tool, args) {
    switch (tool) {
      case "read_file":
      case "delete_file":
      case "view_image":
        return args.path;
      case "list_directory":
        return args.path || ".";
      case "create_file":
      case "append_to_file":
        return `${args.path} (${Buffer.byteLength(args.content || "", "utf8")} bytes)`;
      case "replace_in_file":
        return `${args.path} (old ${Buffer.byteLength(args.old || "", "utf8")} B → new ${Buffer.byteLength(args.new || "", "utf8")} B${args.replaceAll ? ", replaceAll" : ""})`;
      case "move_file":
        return `${args.from} → ${args.to}`;
      case "search":
        return `/${args.pattern}/${args.caseInsensitive ? "i" : ""} in ${args.path || "."}${args.glob ? ` glob=${args.glob}` : ""}`;
      case "find_files":
        return `${args.pattern} in ${args.path || "."}`;
      case "start_here":
        return "ChatGPT + MCP role guide";
      case "handoff":
        return "session report";
      case "run_command":
        return `${(args.command || "").slice(0, 80)}${(args.command || "").length > 80 ? "…" : ""}`;
      case "get_command_output":
        return `job ${args.job_id}${args.only_new ? " (new only)" : ""}`;
      case "stop_command":
        return `job ${args.job_id}${args.force ? " force" : ""}`;
      case "list_commands":
        return "background jobs";
      case "undo_last_change":
        return "latest change set";
      case "project_info":
        return resolvedRoot;
      case "stop_session":
        return "shut down remote MCP";
      case "list_remote_skills":
        return "agent skills on remote machine";
      case "read_remote_skill":
        return args.name || args.path || "skill";
      default:
        return JSON.stringify(args);
    }
  }

  /**
   * One line per tool call:
   *   [mcp] [HH:MM:SS] ✓ ok → tool: summary; detail1; detail2
   *   [mcp] [HH:MM:SS] ✗ failed: reason → tool: summary; detail1
   */
  async function emitToolLog({ ok, failureDetail = "", tool, summary, details = [] }) {
    const status = ok
      ? "✓ ok"
      : `✗ failed${failureDetail ? `: ${previewText(failureDetail, 200)}` : ""}`;
    const extras = details
      .map((part) => String(part ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    let line = `[mcp] [${shortTimestamp()}] ${status} → ${tool}: ${summary}`;
    if (extras.length > 0) {
      line += `; ${extras.join("; ")}`;
    }
    process.stderr.write(`${line}\n`);
    await logger(line);
  }

  /**
   * @param {string} tool
   * @param {object} args
   * @param {(note: (message: string) => void) => Promise<object>} work
   */
  async function runTool(tool, args, work) {
    const summary = summarizeArgs(tool, args || {});
    const details = [];
    const note = (message) => {
      const body = String(message ?? "")
        .replace(/^\[mcp\]\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (body) {
        details.push(body);
      }
    };

    if (verbose && tool === "replace_in_file") {
      note(`old: ${previewText(args.old)}`);
      note(`new: ${previewText(args.new)}`);
    }
    if (verbose && (tool === "create_file" || tool === "append_to_file")) {
      note(`content preview: ${previewText(args.content)}`);
    }

    try {
      const result = await work(note);
      if (result?.isError) {
        const detail = result.content?.[0]?.text || "error";
        await emitToolLog({
          ok: false,
          failureDetail: detail,
          tool,
          summary,
          details,
        });
      } else {
        await emitToolLog({ ok: true, tool, summary, details });
      }
      if (result && typeof result === "object" && "_lineStats" in result) {
        const { _lineStats, ...rest } = result;
        void _lineStats;
        return rest;
      }
      return result;
    } catch (error) {
      await emitToolLog({
        ok: false,
        failureDetail: error.message || String(error),
        tool,
        summary,
        details,
      });
      return errorResult(error);
    }
  }

  async function applyWrite(call, note = () => {}) {
    await validateToolCall(call, resolvedRoot, pathOptions);
    const history = await createHistoryEntry([call], resolvedRoot, pathOptions);
    await executeToolCall(call, resolvedRoot, pathOptions);
    note(`history ${history.id}`);
    return history;
  }

  async function existingFileLineCount(relativePath) {
    try {
      const content = await readTextFile(relativePath, resolvedRoot, pathOptions);
      return countLines(content);
    } catch {
      return null;
    }
  }

  /** Line stats for one replace block; multiply when replaceAll with known occurrence count. */
  function replaceLineStats(oldText, newText, occurrenceCount = 1) {
    const n = Math.max(1, Number(occurrenceCount) || 1);
    return {
      added: countLines(newText) * n,
      removed: countLines(oldText) * n,
    };
  }

  function countOccurrencesIn(haystack, needle) {
    if (!needle) {
      return 0;
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

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 text file relative to the project root. Use this when you need current file contents. Use this when the digest may be stale. For images (png/jpg/webp/…), use view_image instead.",
      inputSchema: {
        path: z.string().describe("Relative path to the file"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) =>
      runTool("read_file", { path: filePath }, async (note) => {
        const content = await readTextFile(filePath, resolvedRoot, pathOptions);
        note(`read ${filePath} (${Buffer.byteLength(content, "utf8")} bytes)`);
        return textResult(content);
      }),
  );

  server.registerTool(
    "view_image",
    {
      title: "View image",
      description:
        "Load an image file from the remote project at full resolution and return it as MCP image content (so you can actually see it), plus text metadata (format, dimensions, size). Use for screenshots, UI mocks, design assets, and test failure PNGs. Do not use read_file on binary images. Files larger than ~20MB are rejected.",
      inputSchema: {
        path: z.string().describe("Relative path to an image file (png, jpeg, webp, gif, …)"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) =>
      runTool("view_image", { path: filePath }, async (note) => {
        const result = await viewImageFile({
          path: filePath,
          root: resolvedRoot,
          allowOutside: pathOptions.allowOutside,
        });
        const { meta } = result;
        const imagePart = result.content.find((part) => part.type === "image");
        // Base64 string length ≈ bytes on the wire inside the MCP JSON payload
        const payloadBytes = imagePart?.data ? Buffer.byteLength(imagePart.data, "utf8") : 0;

        note(
          `${meta.width}×${meta.height}; ${meta.format}; image ${formatBytes(meta.bytes)}; ` +
            `sent ${formatBytes(payloadBytes)} base64; full resolution`,
        );
        return { content: result.content };
      }),
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description:
        "List files and subdirectories at a relative path (default: project root). Directories end with '/', symlinks with '@'.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Relative directory path. Default "." (project root).'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: dirPath = "." }) =>
      runTool("list_directory", { path: dirPath }, async (note) => {
        const listing = await listDirectory(dirPath || ".", resolvedRoot, pathOptions);
        const count = listing ? listing.split("\n").filter(Boolean).length : 0;
        note(`listed ${count} entr${count === 1 ? "y" : "ies"} in ${dirPath || "."}`);
        return textResult(listing || "(empty)");
      }),
  );

  server.registerTool(
    "create_file",
    {
      title: "Create or overwrite file",
      description:
        "Create or overwrite a UTF-8 text file at a relative path. Parent directories are created as needed. Use this when writing a new file or replacing full file contents.",
      inputSchema: {
        path: z.string().describe("Relative path for the file"),
        content: z.string().describe("Full UTF-8 file contents"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath, content }) =>
      runTool("create_file", { path: filePath, content }, async (note) => {
        const previousLines = await existingFileLineCount(filePath);
        const history = await applyWrite(
          { tool: "create_file", path: filePath, content },
          note,
        );
        const lineStats = {
          added: countLines(content),
          removed: previousLines ?? 0,
        };
        note(
          `lines ${formatLineStats(lineStats)}${previousLines === null ? " (new file)" : " (overwrite)"}`,
        );
        return {
          ...textResult(`Created/overwrote ${filePath} (history ${history.id}).`),
          _lineStats: lineStats,
        };
      }),
  );

  server.registerTool(
    "replace_in_file",
    {
      title: "Replace text in file",
      description:
        "Replace an exact string in a UTF-8 text file. By default old must match exactly once; set replaceAll true to replace every occurrence. Prefer a large unique old string.",
      inputSchema: {
        path: z.string().describe("Relative path to the file"),
        old: z.string().describe("Exact text to find"),
        new: z.string().describe("Replacement text"),
        replaceAll: z
          .boolean()
          .optional()
          .describe("If true, replace all occurrences. Default false."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: filePath, old: oldText, new: newText, replaceAll }) =>
      runTool(
        "replace_in_file",
        { path: filePath, old: oldText, new: newText, replaceAll },
        async (note) => {
          let occurrenceCount = 1;
          if (replaceAll) {
            try {
              const current = await readTextFile(filePath, resolvedRoot, pathOptions);
              occurrenceCount = Math.max(1, countOccurrencesIn(current, oldText));
            } catch {
              occurrenceCount = 1;
            }
          }
          const lineStats = replaceLineStats(oldText, newText, occurrenceCount);
          const history = await applyWrite(
            {
              tool: "replace_in_file",
              path: filePath,
              old: oldText,
              new: newText,
              replaceAll: Boolean(replaceAll),
            },
            note,
          );
          note(
            `lines ${formatLineStats(lineStats)}${replaceAll && occurrenceCount > 1 ? ` ×${occurrenceCount}` : ""}`,
          );
          return {
            ...textResult(`Replaced text in ${filePath} (history ${history.id}).`),
            _lineStats: lineStats,
          };
        },
      ),
  );

  server.registerTool(
    "append_to_file",
    {
      title: "Append to file",
      description: "Append UTF-8 text to a file (creates the file if missing).",
      inputSchema: {
        path: z.string().describe("Relative path to the file"),
        content: z.string().describe("Text to append"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: filePath, content }) =>
      runTool("append_to_file", { path: filePath, content }, async (note) => {
        const history = await applyWrite(
          { tool: "append_to_file", path: filePath, content },
          note,
        );
        const lineStats = { added: countLines(content), removed: 0 };
        note(`lines ${formatLineStats(lineStats)}`);
        return {
          ...textResult(`Appended to ${filePath} (history ${history.id}).`),
          _lineStats: lineStats,
        };
      }),
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete file or directory",
      description:
        "Delete an existing file or directory relative to the project root. Fails if the path does not exist. Destructive — prefer only when necessary.",
      inputSchema: {
        path: z.string().describe("Relative path to delete"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) =>
      runTool("delete_file", { path: filePath }, async (note) => {
        const previousLines = await existingFileLineCount(filePath);
        const history = await applyWrite({ tool: "delete_file", path: filePath }, note);
        const lineStats = {
          added: 0,
          removed: previousLines ?? 0,
        };
        note(`lines ${formatLineStats(lineStats)}`);
        return {
          ...textResult(`Deleted ${filePath} (history ${history.id}).`),
          _lineStats: lineStats,
        };
      }),
  );

  server.registerTool(
    "move_file",
    {
      title: "Move or rename file",
      description: "Rename or move a file or directory within the project root.",
      inputSchema: {
        from: z.string().describe("Relative source path"),
        to: z.string().describe("Relative destination path"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ from, to }) =>
      runTool("move_file", { from, to }, async (note) => {
        const history = await applyWrite({ tool: "move_file", from, to }, note);
        return textResult(`Moved ${from} -> ${to} (history ${history.id}).`);
      }),
  );

  server.registerTool(
    "undo_last_change",
    {
      title: "Undo last change",
      description:
        "Undo the most recent pastepatch change set for this project (from MCP tools or pastepatch --edit).",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () =>
      runTool("undo_last_change", {}, async () => {
        const entry = await undoLatestChange(resolvedRoot, pathOptions);
        return textResult(`Undid change set ${entry.id} from ${entry.createdAt}.`);
      }),
  );

  server.registerTool(
    "project_info",
    {
      title: "Project info",
      description: "Return the absolute project root this MCP server is bound to.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool("project_info", {}, async () => textResult(JSON.stringify({ root: resolvedRoot }, null, 2))),
  );

  server.registerTool(
    "start_here",
    {
      title: "Start here",
      description:
        "Read this first in a coding session. Explains that you are the model in ChatGPT using pastepatch MCP tools over a tunnel to edit a real local project, plus project root, tool guide, and editing rules. Call at the beginning of work or when unsure how to behave.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool("start_here", {}, async () =>
        textResult(
          buildStartHereGuide({
            root: resolvedRoot,
            version,
            allowOutside: pathOptions.allowOutside,
          }),
        ),
      ),
  );

  server.registerTool(
    "search",
    {
      title: "Search file contents",
      description:
        "Search file contents under the project (ripgrep if installed, else grep). Returns path:line:text matches. Use this to find symbols, strings, and call sites before editing.",
      inputSchema: {
        pattern: z.string().describe("Regex (rg) or basic pattern (grep fallback)"),
        path: z
          .string()
          .optional()
          .describe('Relative directory or file to search within. Default "."'),
        glob: z.string().optional().describe('Optional glob filter, e.g. "*.js" or "*.{ts,tsx}"'),
        caseInsensitive: z.boolean().optional().describe("Case-insensitive search. Default false."),
        maxResults: z.number().optional().describe("Max matches to return (default 50, max 200)."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ pattern, path: searchPath, glob, caseInsensitive, maxResults }) =>
      runTool(
        "search",
        { pattern, path: searchPath, glob, caseInsensitive, maxResults },
        async (note) => {
          const result = await searchContent({
            root: resolvedRoot,
            pattern,
            path: searchPath,
            glob,
            caseInsensitive: Boolean(caseInsensitive),
            maxResults,
            allowOutside: pathOptions.allowOutside,
          });
          const suffix = result.truncated
            ? `\n\n(truncated at max results; engine=${result.engine})`
            : `\n\n(engine=${result.engine})`;
          note(`search engine=${result.engine}${result.truncated ? " truncated" : ""}`);
          return textResult(`${result.output}${suffix}`);
        },
      ),
  );

  server.registerTool(
    "find_files",
    {
      title: "Find files by name",
      description:
        "Find files by name/glob under the project (fd if installed, else find). Prefer this over guessing paths.",
      inputSchema: {
        pattern: z
          .string()
          .describe("Filename glob or substring (e.g. *.tsx, package.json, config)"),
        path: z
          .string()
          .optional()
          .describe('Relative directory to search within. Default "."'),
        maxResults: z.number().optional().describe("Max paths to return (default 50, max 200)."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ pattern, path: searchPath, maxResults }) =>
      runTool("find_files", { pattern, path: searchPath, maxResults }, async (note) => {
        const result = await findFiles({
          root: resolvedRoot,
          pattern,
          path: searchPath,
          maxResults,
          allowOutside: pathOptions.allowOutside,
        });
        const suffix = result.truncated
          ? `\n\n(truncated; engine=${result.engine})`
          : `\n\n(engine=${result.engine})`;
        note(`find_files engine=${result.engine}${result.truncated ? " truncated" : ""}`);
        return textResult(`${result.output}${suffix}`);
      }),
  );

  server.registerTool(
    "handoff",
    {
      title: "Handoff report",
      description:
        "Generate a detailed technical handoff report for continuing work in another chat. Fill every section thoroughly from the conversation: achievements, files, changes/why, user guidance, things to remember, importance-ranked notes, open questions, next steps. Returns the entire report inside one markdown code block for easy copy-paste.",
      inputSchema: {
        achieved: z
          .string()
          .describe("What was accomplished in this thread (concrete outcomes)."),
        files: z
          .string()
          .describe("Files and directories touched or important to the work (relative paths)."),
        changes: z
          .string()
          .describe("What changed and why, per file or logical change, technical detail."),
        user_guidance: z
          .string()
          .describe("Instructions, preferences, and constraints the user stated."),
        remember: z
          .string()
          .describe("Facts the next session must remember (stack, APIs, decisions, gotchas)."),
        important: z
          .string()
          .describe(
            "Important notes scaled by importance (e.g. P0/P1/P2 or Critical/High/Medium bullets).",
          ),
        open_questions: z
          .string()
          .optional()
          .describe("Unresolved questions, risks, or blockers."),
        next_steps: z
          .string()
          .optional()
          .describe("Recommended next actions for the following thread."),
        extra: z.string().optional().describe("Any additional technical context."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({
      achieved,
      files,
      changes,
      user_guidance: userGuidance,
      remember,
      important,
      open_questions: openQuestions,
      next_steps: nextSteps,
      extra,
    }) =>
      runTool("handoff", { achieved, files }, async (note) => {
        const report = buildHandoffReport({
          root: resolvedRoot,
          achieved,
          files,
          changes,
          userGuidance,
          remember,
          important,
          openQuestions,
          nextSteps,
          extra,
        });
        note(`handoff report ${Buffer.byteLength(report, "utf8")} bytes`);
        return textResult(report);
      }),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run shell command",
      description:
        "Run a shell command in the project (cwd defaults to project root). Waits up to wait_ms (default 30000); if still running, keeps it in the background and returns output so far plus a job_id. Use get_command_output to poll and stop_command to kill. Output is capped (default ~32k chars, tail kept). Dangerous commands are blocked by a blacklist.",
      inputSchema: {
        command: z.string().describe("Shell command to run (zsh on macOS/Linux, cmd on Windows)"),
        cwd: z
          .string()
          .optional()
          .describe('Working directory relative to project root. Default "."'),
        wait_ms: z
          .number()
          .optional()
          .describe("Ms to wait for exit before backgrounding (default 30000, max 120000). 0 = background immediately."),
        max_output_chars: z
          .number()
          .optional()
          .describe("Max characters of output to return (default 32000, max 100000)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ command, cwd, wait_ms: waitMs, max_output_chars: maxOutputChars }) =>
      runTool("run_command", { command, cwd, wait_ms: waitMs }, async (note) => {
        const result = await runner.runCommand({
          command,
          cwd,
          waitMs,
          maxOutputChars,
        });
        note(`status=${result.status} job=${result.jobId} exit=${result.exitCode ?? "-"}`);
        return textResult(result.text);
      }),
  );

  server.registerTool(
    "get_command_output",
    {
      title: "Get command output",
      description:
        "Fetch output from a background (or finished) job started by run_command. Pass job_id from run_command. Set only_new true to receive only output since the last get_command_output call.",
      inputSchema: {
        job_id: z.string().describe("Job id returned by run_command"),
        only_new: z
          .boolean()
          .optional()
          .describe("If true, only return output appended since last poll. Default false."),
        max_output_chars: z.number().optional().describe("Max characters to return (tail)."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id: jobId, only_new: onlyNew, max_output_chars: maxOutputChars }) =>
      runTool("get_command_output", { job_id: jobId, only_new: onlyNew }, async (note) => {
        const result = runner.getCommandOutput({
          jobId,
          onlyNew: Boolean(onlyNew),
          maxOutputChars,
        });
        note(`status=${result.status}`);
        return textResult(result.text);
      }),
  );

  server.registerTool(
    "stop_command",
    {
      title: "Stop command",
      description:
        "Stop a background job started by run_command (SIGTERM, or SIGKILL if force true). Returns final/partial output.",
      inputSchema: {
        job_id: z.string().describe("Job id returned by run_command"),
        force: z
          .boolean()
          .optional()
          .describe("If true, send SIGKILL immediately. Default false (SIGTERM)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id: jobId, force }) =>
      runTool("stop_command", { job_id: jobId, force }, async (note) => {
        const result = await runner.stopCommand({ jobId, force: Boolean(force) });
        note(`status=${result.status}`);
        return textResult(`${result.message}\n\n${result.text || ""}`.trim());
      }),
  );

  server.registerTool(
    "list_commands",
    {
      title: "List commands",
      description: "List background/finished shell jobs started by run_command in this MCP process.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool("list_commands", {}, async () => {
        const list = runner.listCommands();
        if (list.length === 0) {
          return textResult("(no jobs)");
        }
        return textResult(
          list
            .map(
              (j) =>
                `${j.jobId}  ${j.status.padEnd(7)}  exit=${j.exitCode ?? "-"}  ${j.command}`,
            )
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "list_remote_skills",
    {
      title: "List remote skills",
      description:
        "List Agent Skills (SKILL.md) installed on the remote machine in default coding-agent locations (project + home: .agents/skills, .claude/skills, .cursor/skills, .grok/skills, ~/.agents/skills, etc.). Deduplicated by path and name. Then use read_remote_skill with a skill name to load full instructions.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool("list_remote_skills", {}, async (note) => {
        const skills = await listRemoteSkills({ projectRoot: resolvedRoot });
        note(`found ${skills.length} skill${skills.length === 1 ? "" : "s"}`);
        return textResult(formatSkillsList(skills));
      }),
  );

  server.registerTool(
    "read_remote_skill",
    {
      title: "Read remote skill",
      description:
        "Read the full SKILL.md for a skill on the remote machine. Pass the skill name from list_remote_skills (preferred), or an absolute path to a skill directory / SKILL.md. Bypasses the project path sandbox so home-installed skills can be read.",
      inputSchema: {
        name: z
          .string()
          .describe("Skill name (from list_remote_skills) or path to skill dir / SKILL.md"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ name }) =>
      runTool("read_remote_skill", { name }, async (note) => {
        const skill = await readRemoteSkill(name, { projectRoot: resolvedRoot });
        note(`${skill.name} (${Buffer.byteLength(skill.content, "utf8")} bytes)`);
        const header = [
          `# Skill: ${skill.name}`,
          `path: ${skill.path}`,
          skill.description ? `description: ${skill.description}` : null,
          "",
          "---",
          "",
        ]
          .filter((line) => line !== null)
          .join("\n");
        return textResult(`${header}${skill.content}`);
      }),
  );

  server.registerTool(
    "stop_session",
    {
      title: "Stop session",
      description:
        "Shut down the pastepatch MCP server and Cloudflare tunnel on the remote machine. Use when the user is done coding, wants to free the single MCP slot, or will start pastepatch against a different project. Tools disconnect shortly after this returns; the user must run pastepatch --mcp again to reconnect.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool("stop_session", {}, async (note) => {
        note("scheduling remote-machine shutdown");
        if (typeof onStopSession === "function") {
          // Let the MCP response flush before tearing down HTTP/tunnel.
          setTimeout(() => {
            void Promise.resolve()
              .then(() => onStopSession())
              .catch((error) => {
                process.stderr.write(
                  `[mcp] stop_session shutdown error: ${error.message || error}\n`,
                );
              });
          }, 300);
        }
        return textResult(
          "Stopping pastepatch MCP on the remote machine. The tunnel and tools will go offline in a moment. Start again with: pastepatch --mcp",
        );
      }),
  );

  return server;
}

/**
 * Start HTTP MCP server on localhost (Streamable HTTP + legacy SSE).
 * Binds to 127.0.0.1 only — expose publicly via Cloudflare Tunnel.
 */
export async function startMcpHttpServer({
  root,
  port = 8787,
  host = "127.0.0.1",
  version = "0.0.0",
  logger = async () => {},
  authToken = null,
  /** Extra Host header values (e.g. public tunnel hostname). Cloudflare may forward the public Host. */
  allowedHosts = [],
  verbose = false,
  allowOutside = false,
  /** Invoked by the stop_session tool (process-level shutdown). */
  onStopSession = null,
} = {}) {
  const hosts = [
    host,
    "localhost",
    "127.0.0.1",
    ...allowedHosts.map((value) => String(value).replace(/^https?:\/\//, "").split("/")[0]).filter(Boolean),
  ];
  // createMcpExpressApp only auto-enables host checks for localhost binds; pass allowedHosts always.
  const app = createMcpExpressApp({ host, allowedHosts: [...new Set(hosts)] });

  // Shared command runner across MCP sessions in this process
  const commandRunner = createCommandRunner({
    root: path.resolve(root),
    allowOutside: allowOutside === true,
  });

  // Per-session transports (stateful Streamable HTTP + legacy SSE)
  /** @type {Record<string, StreamableHTTPServerTransport | SSEServerTransport>} */
  const transports = {};

  if (authToken) {
    app.use((req, res, next) => {
      if (req.path === "/healthz") {
        next();
        return;
      }
      const header = req.headers.authorization || "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
      const queryToken = typeof req.query.token === "string" ? req.query.token : "";
      if (bearer === authToken || queryToken === authToken) {
        next();
        return;
      }
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
    });
  }

  // HTTP request log — verbose only (ChatGPT polls / cancels streams often)
  if (verbose) {
    app.use((req, res, next) => {
      if (req.path === "/healthz") {
        next();
        return;
      }
      const started = Date.now();
      const method = req.method;
      const pathName = req.path;
      res.on("finish", () => {
        const session = req.headers["mcp-session-id"] || "-";
        const line = `[http] ${method} ${pathName} → ${res.statusCode} (${Date.now() - started}ms) session=${session}`;
        process.stderr.write(`${line}\n`);
        void logger(line);
      });
      next();
    });
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, root, mcp: "/mcp", sse: "/sse" });
  });

  // ---- Streamable HTTP (MCP 2025-11-25) ----
  app.all("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport;

      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (!(existing instanceof StreamableHTTPServerTransport)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: Session exists but uses a different transport protocol",
            },
            id: null,
          });
          return;
        }
        transport = existing;
      } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            if (verbose) {
              process.stderr.write(`[mcp] session initialized ${sid}\n`);
            }
            void logger(`MCP session initialized ${sid}`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
            if (verbose) {
              process.stderr.write(`[mcp] session closed ${sid}\n`);
            }
            void logger(`MCP session closed ${sid}`);
          }
        };
        const server = createPastepatchMcpServer({
          root,
          version,
          logger,
          verbose,
          allowOutside,
          commandRunner,
          onStopSession,
        });
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await logger(`MCP /mcp error: ${error.stack || error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // ---- Legacy HTTP+SSE (2024-11-05) for older ChatGPT clients ----
  app.get("/sse", async (req, res) => {
    try {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => {
        delete transports[transport.sessionId];
      });
      const server = createPastepatchMcpServer({
        root,
        version,
        logger,
        verbose,
        allowOutside,
        commandRunner,
        onStopSession,
      });
      await server.connect(transport);
      await logger(`MCP SSE session ${transport.sessionId}`);
    } catch (error) {
      await logger(`MCP /sse error: ${error.stack || error.message}`);
      if (!res.headersSent) {
        res.status(500).end("Internal server error");
      }
    }
  });

  app.post("/messages", async (req, res) => {
    try {
      const sessionId = req.query.sessionId;
      const existing = transports[sessionId];
      if (!(existing instanceof SSEServerTransport)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid SSE session",
          },
          id: null,
        });
        return;
      }
      await existing.handlePostMessage(req, res, req.body);
    } catch (error) {
      await logger(`MCP /messages error: ${error.stack || error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(server);
    });
  });

  return {
    app,
    httpServer,
    port,
    host,
    commandRunner,
    async close() {
      await commandRunner.dispose();
      for (const transport of Object.values(transports)) {
        try {
          await transport.close?.();
        } catch {
          // ignore
        }
      }
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
