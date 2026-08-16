/**
 * Shared line grep / offset / limit for read_file and get_command_output.
 * Line offsets are 1-based.
 */

export function hasTextSliceQuery({ grep, lineOffset, lineLimit } = {}) {
  if (grep) {
    return true;
  }
  if (lineOffset !== undefined && lineOffset !== null && lineOffset !== "") {
    return true;
  }
  if (lineLimit !== undefined && lineLimit !== null && lineLimit !== "") {
    return true;
  }
  return false;
}

export function countLines(text) {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") {
    return 0;
  }
  return normalized.replace(/\n$/, "").split("\n").length;
}

export function sliceTextLines(
  text,
  { grep, grepContext = 0, lineOffset, lineLimit, caseInsensitive = false } = {},
) {
  const source = typeof text === "string" ? text : "";
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let lines = normalized.length ? normalized.split("\n") : [];
  // Trailing newline produces a final empty element — keep it only if the file
  // had content after the last newline. Split on "a\n" → ["a", ""]; drop the
  // trailing empty so line counts match editor line numbers.
  if (lines.length && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  const totalLines = lines.length;
  let grepHits = null;

  if (grep) {
    let regex;
    try {
      regex = new RegExp(grep, caseInsensitive ? "i" : "");
    } catch (error) {
      throw new Error(`Invalid grep pattern: ${error.message}`);
    }
    const context = Math.min(Math.max(Number(grepContext) || 0, 0), 20);
    const keep = new Set();
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i += 1) {
          keep.add(i);
        }
      }
    });
    grepHits = keep.size;
    const picked = [];
    let last = -2;
    for (const index of [...keep].sort((a, b) => a - b)) {
      if (last >= 0 && index > last + 1) {
        picked.push("...");
      }
      picked.push(lines[index]);
      last = index;
    }
    lines = picked;
  }

  if ((lineOffset !== undefined && lineOffset !== null && lineOffset !== "") || lineLimit) {
    const start = Math.max(0, (Number(lineOffset) || 1) - 1);
    const count =
      lineLimit === undefined || lineLimit === null || lineLimit === ""
        ? undefined
        : Math.max(0, Number(lineLimit) || 0);
    lines = count === undefined ? lines.slice(start) : lines.slice(start, start + count);
  }

  return {
    text: lines.join("\n"),
    grepHits,
    lineCount: lines.length,
    totalLines,
  };
}

export function formatSlicedText({ path, sliced, query = {} } = {}) {
  const parts = [`path=${path}`, `total_lines=${sliced.totalLines}`, `returned_lines=${sliced.lineCount}`];
  if (query.grep) {
    parts.push(`grep=/${query.grep}/`);
    if (query.grepContext) {
      parts.push(`context=${query.grepContext}`);
    }
  }
  if (query.lineOffset || query.lineLimit) {
    parts.push(`line_offset=${query.lineOffset || 1}`);
    parts.push(`line_limit=${query.lineLimit ?? "-"}`);
  }
  const notices = [`[${parts.join(" ")}]`];
  if (query.grep && sliced.grepHits === 0) {
    notices.push(`[grep /${query.grep}/ matched 0 lines]`);
  }
  const body = sliced.text.length ? sliced.text : "(no lines)";
  return `${notices.join("\n")}\n\n${body}`;
}
