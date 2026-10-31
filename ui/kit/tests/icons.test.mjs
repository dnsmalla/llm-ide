import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { KIT } from "./helpers.mjs";

test("vendored Lucide glyphs are current for the pinned lucide-static", () => {
  const out = execFileSync("node", [join(KIT, "scripts/vendor-icons.mjs"), "--check"], { encoding: "utf8" });
  assert.match(out, /icons: ok/);
});
