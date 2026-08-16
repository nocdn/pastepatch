import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProcessName,
  formatProcessTree,
  getProcessTree,
  quitApp,
} from "../lib/apps.js";

test("assertProcessName rejects quotes and wildcards", () => {
  assert.equal(assertProcessName("Ollama"), "Ollama");
  assert.equal(assertProcessName("Visual Studio Code"), "Visual Studio Code");
  assert.throws(() => assertProcessName('Ollama" to quit'), /Invalid name/);
  assert.throws(() => assertProcessName("foo; rm -rf"), /Invalid name/);
  assert.throws(() => assertProcessName(""), /required/);
});

test("get_process_tree walks this process", () => {
  const result = getProcessTree({ pid: process.pid });
  assert.equal(result.matchCount, 1);
  assert.equal(result.trees[0].self.pid, process.pid);
  assert.match(formatProcessTree(result), /\[requested\]/);
  assert.match(formatProcessTree(result), new RegExp(`pid=${process.pid}`));
});

test("get_process_tree rejects missing pid and unknown name", () => {
  assert.throws(() => getProcessTree({ pid: 999_999_991 }), /No process/);
  assert.throws(() => getProcessTree({ name: "DefinitelyNotAProcessNameZZZ" }), /No process matching/);
  assert.throws(() => getProcessTree({}), /pid or name/);
});

test("quit_app refuses non-macOS or missing exact name", () => {
  if (process.platform !== "darwin") {
    assert.throws(() => quitApp("Finder"), /only available on macOS/);
    return;
  }
  assert.throws(() => quitApp("DefinitelyNotAnAppZZZ"), /No running application/);
  assert.throws(() => quitApp('Bad"Name'), /Invalid name/);
});
