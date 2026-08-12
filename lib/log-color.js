/**
 * Lightweight ANSI colors for MCP tool log lines on stderr.
 * File/logger output stays plain; only the terminal display is colored.
 *
 * Respects:
 * - options.noColor / --no-color
 * - options.forceColor / --color
 * - NO_COLOR (https://no-color.org/)
 * - FORCE_COLOR=1|true|yes
 * - stderr TTY (auto when neither force nor no-color)
 */

const RESET = "\x1b[0m";

export const ansi = {
  reset: RESET,
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

/**
 * @param {{ forceColor?: boolean, noColor?: boolean, stream?: { isTTY?: boolean } }} [options]
 */
export function shouldUseColor({
  forceColor = false,
  noColor = false,
  stream = process.stderr,
} = {}) {
  if (noColor === true) {
    return false;
  }
  if (hasNoColorEnv()) {
    return false;
  }
  if (forceColor === true || hasForceColorEnv()) {
    return true;
  }
  return Boolean(stream && stream.isTTY);
}

function hasNoColorEnv() {
  // Any non-empty NO_COLOR disables color (spec).
  const value = process.env.NO_COLOR;
  return value !== undefined && value !== "";
}

function hasForceColorEnv() {
  const value = String(process.env.FORCE_COLOR || "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * @param {boolean} enabled
 * @param {string} code
 * @param {string} text
 */
export function paint(enabled, code, text) {
  if (!enabled || text == null || text === "") {
    return String(text ?? "");
  }
  return `${code}${text}${RESET}`;
}

/**
 * Color +N / -N in "lines +7 / -2" style fragments only.
 * Re-applies dim after each reset so surrounding payload stays timestamp-gray.
 * @param {string} detail
 * @param {boolean} enabled
 */
export function colorizeDetail(detail, enabled) {
  const text = String(detail ?? "");
  if (!enabled) {
    return text;
  }
  return text.replace(
    /lines \+(\d+) \/ -(\d+)/g,
    (_match, added, removed) =>
      `lines ${paint(true, ansi.green, `+${added}`)}${ansi.dim} / ${paint(true, ansi.red, `-${removed}`)}${ansi.dim}`,
  );
}

/**
 * Build plain + optional colored MCP tool log lines.
 *
 * Plain shape (unchanged for log files / tests):
 *   [mcp] [HH:MM:SS] ✓ ok → tool: summary; detail1; detail2
 *   [mcp] [HH:MM:SS] ✗ failed: reason → tool: summary; detail1
 *
 * @param {object} opts
 * @param {boolean} opts.ok
 * @param {string} [opts.failureDetail]
 * @param {string} opts.tool
 * @param {string} opts.summary
 * @param {string[]} [opts.details]
 * @param {string} opts.timestamp  HH:MM:SS
 * @param {boolean} [opts.color]
 * @returns {{ plain: string, display: string }}
 */
export function formatToolLogLine({
  ok,
  failureDetail = "",
  tool,
  summary,
  details = [],
  timestamp,
  color = false,
} = {}) {
  const extras = details
    .map((part) => String(part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const statusPlain = ok
    ? "✓ ok"
    : `✗ failed${failureDetail ? `: ${failureDetail}` : ""}`;

  let plain = `[mcp] [${timestamp}] ${statusPlain} → ${tool}: ${summary}`;
  if (extras.length > 0) {
    plain += `; ${extras.join("; ")}`;
  }

  if (!color) {
    return { plain, display: plain };
  }

  const tag = paint(true, ansi.dim, "[mcp]");
  const time = paint(true, ansi.dim, `[${timestamp}]`);
  const status = ok
    ? paint(true, ansi.green, "✓ ok")
    : paint(
        true,
        ansi.red,
        `✗ failed${failureDetail ? `: ${failureDetail}` : ""}`,
      );
  // Tool name stays default (terminal foreground). Summary + details are
  // the same dim gray as the timestamp; +N / -N keep green / red.
  const payload = extras.length > 0 ? `${summary}; ${extras.join("; ")}` : String(summary ?? "");
  const payloadDisplay = paint(true, ansi.dim, colorizeDetail(payload, true));

  const display = `${tag} ${time} ${status} → ${tool}: ${payloadDisplay}`;

  return { plain, display };
}
