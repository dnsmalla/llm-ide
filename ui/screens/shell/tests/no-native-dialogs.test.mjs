// The desktop webview (WKWebView through wry) implements no JavaScript dialog panels: window.prompt returns null,
// window.confirm false and window.alert nothing. A screen that relies on one silently does nothing on macOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const screens = new URL("../../", import.meta.url).pathname;

test("no screen calls window.prompt, window.confirm or window.alert", () => {
  const hits = [];
  for (const entry of readdirSync(screens, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    if (/[\\/]tests[\\/]/.test(file)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/\bwindow\.(prompt|confirm|alert)\s*\(/.test(line)) hits.push(`${file.slice(screens.length)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
