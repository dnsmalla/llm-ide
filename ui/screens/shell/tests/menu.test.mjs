import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHELL } from "./helpers.mjs";

const m = await import(join(SHELL, "menu-model.ts"));

test("native menu commands map only to section navigation", () => {
  assert.deepEqual(m.menuAction("menu_chat"), { type: "goto-section", section: "chat" });
  assert.deepEqual(m.menuAction("menu_help"), { type: "goto-section", section: "welcome", anchor: "guide" });
  assert.equal(m.menuAction("menu_unknown"), null);
});

test("Rust menu mirrors the Mac command groups without inventing Mac-only actions", () => {
  const src = readFileSync(join(SHELL, "../../../desktop/src-tauri/src/menu.rs"), "utf8");
  for (const label of ["LLM-IDE", "File", "Edit", "View", "Window", "Help", "New Window", "Close All", "Zoom", "Quick Switch Project…", "LLM Chat…", "Main Window", "LLM-IDE Help"]) {
    assert.ok(src.includes(label), label);
  }
  assert.ok(!src.includes('"Start Recording"') && !src.includes('"Check for Updates…"'));
});
