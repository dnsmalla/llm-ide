// The frozen-prototype Monte patch must cover every Monaco file that assigns `toString` on a namespace
// object; if Monaco adds another one, the editor would fail again under Tauri's freezePrototype. These tests
// read the real installed files, so an upgrade that adds an assignment fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { baseName, needsPatch, patchMonacoSource } from "./monaco-freeze-patch.ts";

const ESM = resolve(import.meta.dirname, "../node_modules/monaco-editor/esm");
const FILES = [
  ["vs/base/common/keyCodes.js", "KeyCodeUtils"],
  ["vs/base/common/severity.js", "Severity"],
  ["vs/platform/markers/common/markers.js", "MarkerSeverity"],
  ["vs/platform/instantiation/common/instantiation.js", "id"],
  ["vs/editor/contrib/inlineCompletions/browser/model/InlineSuggestAlternativeAction.js", "InlineSuggestAlternativeAction"],
];

test("every known Monaco namespace toString assignment is rewritten to defineProperty", () => {
  for (const [rel, ns] of FILES) {
    const file = baseName(rel);
    assert.ok(needsPatch(`monaco-editor/esm/${rel}`), `${rel} is patched`);
    const src = readFileSync(join(ESM, rel), "utf8");
    assert.match(src, new RegExp(`${ns}\\.toString = `), `${rel} still has the assignment (Monaco changed?)`);
    const out = patchMonacoSource(src, file);
    assert.ok(!new RegExp(`${ns}\\.toString = `).test(out), `${ns}.toString assignment replaced`);
    assert.match(out, new RegExp(`Object\\.defineProperty\\(${ns}, "toString", \\{ value:`));
    assert.equal(patchMonacoSource(out, file), out, "idempotent");
  }
});

test("files outside the list, and non-Monaco ids, are untouched", () => {
  const src = "var x = {}; x.toString = function () {};";
  assert.equal(patchMonacoSource(src, "other.js"), src);
  assert.equal(needsPatch("some-lib/esm/keyCodes.js"), false);
  assert.equal(needsPatch("monaco-editor/esm/vs/base/common/keyCodes.js"), true);
  assert.equal(needsPatch("monaco-editor/esm/vs/base/common/dom.js"), false);
});

test("a prototype assignment is never rewritten", () => {
  const src = "OutputLine.prototype.toString = function () { return 1; };";
  assert.equal(patchMonacoSource(src, "beautify-css.js"), src, "not a patched file");
  // Even if it were one, only bare `<ns>.toString` matches; `.prototype.toString` does not.
  assert.equal(patchMonacoSource(src, "keyCodes.js"), src);
});
