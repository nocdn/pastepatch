import assert from "node:assert/strict";
import test from "node:test";
import {
  ansi,
  colorizeDetail,
  formatToolLogLine,
  paint,
  shouldUseColor,
} from "../lib/log-color.js";

test("shouldUseColor respects flags, TTY, and color env", () => {
  const prevNo = process.env.NO_COLOR;
  const prevForce = process.env.FORCE_COLOR;
  try {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;

    // --no-color wins over --color
    assert.equal(shouldUseColor({ noColor: true, forceColor: true, stream: { isTTY: true } }), false);
    // --color forces on without TTY
    assert.equal(shouldUseColor({ forceColor: true, stream: { isTTY: false } }), true);
    // auto: TTY only
    assert.equal(shouldUseColor({ stream: { isTTY: false } }), false);
    assert.equal(shouldUseColor({ stream: { isTTY: true } }), true);

    process.env.FORCE_COLOR = "1";
    assert.equal(shouldUseColor({ stream: { isTTY: false } }), true);

    process.env.NO_COLOR = "1";
    // NO_COLOR wins over FORCE_COLOR and --color
    assert.equal(shouldUseColor({ forceColor: true, stream: { isTTY: true } }), false);
  } finally {
    if (prevNo === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prevNo;
    }
    if (prevForce === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = prevForce;
    }
  }
});

test("formatToolLogLine plain text matches prior shape", () => {
  const { plain, display } = formatToolLogLine({
    ok: true,
    tool: "search",
    summary: "/foo/ in .",
    details: ["search engine=rg", "lines +3 / -1"],
    timestamp: "12:00:00",
    color: false,
  });
  assert.equal(
    plain,
    "[mcp] [12:00:00] ✓ ok → search: /foo/ in .; search engine=rg; lines +3 / -1",
  );
  assert.equal(display, plain);
});

test("formatToolLogLine colors status and line stats; tool name stays default", () => {
  const { plain, display } = formatToolLogLine({
    ok: true,
    tool: "replace_in_file",
    summary: "src/a.js",
    details: ["lines +7 / -2"],
    timestamp: "12:00:00",
    color: true,
  });

  assert.equal(
    plain,
    "[mcp] [12:00:00] ✓ ok → replace_in_file: src/a.js; lines +7 / -2",
  );
  assert.match(display, new RegExp(`\\x1b\\[32m✓ ok\\x1b\\[0m`));
  assert.match(display, new RegExp(`\\x1b\\[2m\\[${"12:00:00"}\\]\\x1b\\[0m`));
  // Tool name and arrow are uncolored (default foreground).
  assert.match(display, / → replace_in_file: /);
  assert.doesNotMatch(display, /\x1b\[36mreplace_in_file/);
  assert.doesNotMatch(display, /\x1b\[34m→/);
  // Summary + details are dim (same as timestamp).
  assert.match(display, /\x1b\[2msrc\/a\.js; lines /);
  assert.match(display, new RegExp(`\\x1b\\[32m\\+7\\x1b\\[0m`));
  assert.match(display, new RegExp(`\\x1b\\[31m-2\\x1b\\[0m`));
  // Strip ANSI → same as plain
  const stripped = display.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(stripped, plain);
});

test("failed lines use red status", () => {
  const { plain, display } = formatToolLogLine({
    ok: false,
    failureDetail: "path does not exist",
    tool: "read_file",
    summary: "missing.txt",
    timestamp: "01:02:03",
    color: true,
  });
  assert.match(plain, /✗ failed: path does not exist/);
  assert.match(display, new RegExp(`\\x1b\\[31m✗ failed: path does not exist\\x1b\\[0m`));
});

test("colorizeDetail only rewrites lines +N / -M fragments", () => {
  assert.equal(colorizeDetail("status=ok", true), "status=ok");
  const colored = colorizeDetail("lines +1 / -0 (new file)", true);
  assert.match(colored, /\x1b\[32m\+1\x1b\[0m/);
  assert.match(colored, /\x1b\[31m-0\x1b\[0m/);
  assert.ok(colored.includes("(new file)"));
});

test("paint is a no-op when color disabled", () => {
  assert.equal(paint(false, ansi.green, "ok"), "ok");
  assert.equal(paint(true, ansi.green, "ok"), `${ansi.green}ok${ansi.reset}`);
});
