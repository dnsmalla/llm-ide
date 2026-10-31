import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { isOpenableLink } = await load("terminal/text.ts");

test("terminal links: only plain http(s) URLs open (OSC 8 can carry any scheme)", () => {
  assert.equal(isOpenableLink("https://example.com/a?b=1"), true);
  assert.equal(isOpenableLink("http://localhost:3000"), true);
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ssh://h", "vscode://x", "https://u:p@evil.com", "https://a b", "https://a\u0000b.com", "//x.com", "not a url", ""]) {
    assert.equal(isOpenableLink(bad), false, bad);
  }
});
