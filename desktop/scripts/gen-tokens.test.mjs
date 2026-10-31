import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./gen-tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const platform = resolve(here, "../../mac/Sources/LlmIdeMac/Core/Platform");
const themeSrc = readFileSync(resolve(platform, "Theme.swift"), "utf8");
const tokensSrc = readFileSync(resolve(platform, "ThemeTokens.swift"), "utf8");

test("renders the real sources: three themes, category hues, scales", () => {
  const css = render(themeSrc, tokensSrc);
  for (const id of ["dark", "light", "midnight"]) assert.match(css, new RegExp(`data-theme="${id}"`));
  assert.match(css, /--body: rgb\(18, 20, 28\);/); // dark body .rgb(0.07, 0.08, 0.11)
  assert.match(css, /--border: rgba\(255, 255, 255, 0.14\);/);
  assert.match(css, /--category-purple: rgb\(179, 143, 242\);/);
  assert.match(css, /--space-xxl: 32px;/);
  assert.match(css, /--font-empty-title-size: 12px;/); // textStyle .callout
});

test("a missing palette is a hard error", () => {
  assert.throws(() => render(themeSrc, tokensSrc.replace("static let dark = Palette(", "static let dark = Other(")), /no "static let dark = Palette\("/);
});

test("--check passes on the committed tokens.css", () => {
  execFileSync("node", [resolve(here, "gen-tokens.mjs"), "--check"], { stdio: "pipe" });
});

test("CRLF sources (a Windows checkout) render the same CSS", () => {
  assert.equal(render(themeSrc.replace(/\n/g, "\r\n"), tokensSrc.replace(/\n/g, "\r\n")), render(themeSrc, tokensSrc));
});
