import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafePid,
  identityMatches,
  isPidAlive,
} from "../lib/process-tree.js";

test("assertSafePid refuses pid <= 1", () => {
  assert.throws(() => assertSafePid(1), /Refusing/);
  assert.throws(() => assertSafePid(0), /Refusing/);
  assert.throws(() => assertSafePid(-5), /Refusing/);
  assert.equal(assertSafePid(process.pid), process.pid);
});

test("isPidAlive sees this process", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999_999_991), false);
});

test("identityMatches detects start-time reuse", () => {
  const expected = { pid: 42, lstart: "Sat Aug 16 01:02:03 2026" };
  assert.equal(identityMatches(expected, null).ok, false);
  assert.equal(identityMatches(expected, { pid: 42, lstart: expected.lstart }).ok, true);
  const reused = identityMatches(expected, { pid: 42, lstart: "Sun Aug 17 01:02:03 2026" });
  assert.equal(reused.ok, false);
  assert.match(reused.reason, /reused/i);
});
