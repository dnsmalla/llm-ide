import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT } from "./helpers.mjs";

test("the gallery bundles (type-checked by `npm run type-check`)", async () => {
  const { buildGallery } = await import(join(KIT, "scripts/build-gallery.mjs"));
  const out = await buildGallery(mkdtempSync(join(tmpdir(), "kit-gallery-")));
  for (const f of ["index.html", "gallery.js", "gallery.css"]) assert.ok(existsSync(join(out, f)), f);
  const css = readFileSync(join(out, "gallery.css"), "utf8");
  for (const id of ["dark", "light", "midnight"]) assert.match(css, new RegExp(`data-theme=("?)${id}\\1`), id);
});
