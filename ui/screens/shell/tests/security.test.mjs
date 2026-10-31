import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SHELL } from "./helpers.mjs";

const sources = readdirSync(SHELL).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => [f, readFileSync(join(SHELL, f), "utf8")]);

test("no raw HTML, eval or remote resources in the shell slice", () => {
  const bad = /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|<img|<iframe|<script|https?:\/\/(?!127\.0\.0\.1|localhost)/;
  for (const [f, s] of sources) {
    const code = s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!bad.test(code), `${f} contains a forbidden construct`);
  }
});

test("tokens never touch web storage: only theme and section id are stored", () => {
  for (const [f, s] of sources) {
    const code = s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code)) {
      assert.ok(["theme.ts", "sections.ts"].includes(f), `${f} uses web storage`);
    }
  }
  const core = readFileSync(join(SHELL, "core.ts"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|cookie/i.test(core.replace(/credentials: "omit"/, "")));
});
