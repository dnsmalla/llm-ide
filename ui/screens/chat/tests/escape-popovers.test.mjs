// R-005#1: Esc closes the two bottom-bar popovers that had no Esc handler, instead of reaching the window
// listener that stops a running turn (stopsOnEscape ignores a key the popover already handled/stopped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT } from "./helpers.mjs";

test("the session-memory popover closes on Esc and stops it reaching the stop listener", () => {
  const screen = readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8");
  assert.match(screen, /aria-label="Session memory"[^>]*onKeyDown=\{\(e\) => \{ if \(e\.key === "Escape"\) \{ e\.stopPropagation\(\); setMemoryOpen\(false\); \} \}\}/);
});

