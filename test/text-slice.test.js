import assert from "node:assert/strict";
import test from "node:test";
import { formatSlicedText, hasTextSliceQuery, sliceTextLines } from "../lib/text-slice.js";

const sample = ["alpha", "keep-one", "skip", "keep-two", "omega"].join("\n") + "\n";

test("sliceTextLines offset and limit are 1-based", () => {
  const sliced = sliceTextLines(sample, { lineOffset: 2, lineLimit: 2 });
  assert.equal(sliced.totalLines, 5);
  assert.equal(sliced.text, "keep-one\nskip");
  assert.equal(sliced.lineCount, 2);
});

test("sliceTextLines grep filters and can add context", () => {
  const grepped = sliceTextLines(sample, { grep: "keep-" });
  assert.equal(grepped.grepHits, 2);
  assert.match(grepped.text, /keep-one/);
  assert.match(grepped.text, /keep-two/);
  assert.doesNotMatch(grepped.text, /^skip$/m);

  const withContext = sliceTextLines(sample, { grep: "skip", grepContext: 1 });
  assert.match(withContext.text, /keep-one/);
  assert.match(withContext.text, /skip/);
  assert.match(withContext.text, /keep-two/);
});

test("hasTextSliceQuery detects any slice field", () => {
  assert.equal(hasTextSliceQuery({}), false);
  assert.equal(hasTextSliceQuery({ grep: "x" }), true);
  assert.equal(hasTextSliceQuery({ lineOffset: 3 }), true);
  assert.equal(hasTextSliceQuery({ lineLimit: 1 }), true);
});

test("formatSlicedText includes path and counts", () => {
  const sliced = sliceTextLines(sample, { lineOffset: 1, lineLimit: 1 });
  const text = formatSlicedText({ path: "src/app.js", sliced, query: { lineOffset: 1, lineLimit: 1 } });
  assert.match(text, /path=src\/app\.js/);
  assert.match(text, /total_lines=5/);
  assert.match(text, /returned_lines=1/);
  assert.match(text, /alpha/);
});
