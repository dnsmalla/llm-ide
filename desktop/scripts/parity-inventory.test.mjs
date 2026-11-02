import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractSwift, matchKind, norm } from "../../scripts/parity-inventory.mjs";

test("extractSwift finds controls, modifiers and static text, skips comments and symbol names", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-inv-"));
  const f = join(dir, "V.swift");
  writeFileSync(f, [
    'Button("Save…") { }',
    '// Button("Commented out") { }',
    'Toggle("Auto approve", isOn: $x)',
    'Text("Nothing here yet.")',
    'Image(systemName: "sidebar.left").help("Hide the sidebar")',
    'Text("Reload \\(count) of the files")',
    '.keyboardShortcut("r", modifiers: .command)',
  ].join("\n"));
  const items = extractSwift(f);
  const texts = items.map((i) => i.text);
  assert.ok(texts.includes("Save…") && texts.includes("Auto approve") && texts.includes("Hide the sidebar"));
  assert.ok(!texts.includes("Commented out"), "comments are skipped");
  assert.ok(!texts.includes("sidebar.left"), "SF symbol names are not labels");
  assert.ok(items.some((i) => i.dynamic && i.text === "of the files"), "interpolated strings keep their longest literal fragment");
  assert.ok(items.some((i) => i.shortcut), "shortcuts are listed, not matched");
});

test("matchKind separates exact labels from words inside a longer sentence, and folds ellipsis and case", () => {
  const corpus = norm('<button>Save...</button> const m = "Cancel the queued message when you press the button";');
  assert.equal(matchKind(corpus, "Save…"), "exact");
  assert.equal(matchKind(corpus, "SAVE"), "exact");
  assert.equal(matchKind(corpus, "Cancel the queued message"), "loose");
  assert.equal(matchKind(corpus, "queued"), "none", "a short word inside a sentence is not a label hit");
  assert.equal(matchKind(corpus, "Stop"), "none");
});
