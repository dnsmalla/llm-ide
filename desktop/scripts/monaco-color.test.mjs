import { test } from "node:test";
import assert from "node:assert/strict";
import { toMonacoColor } from "../src/editor/colors.ts";

test("hex, rgb comma, rgb space, percentage channels and alpha all map to Monaco hex", () => {
  assert.equal(toMonacoColor("#ABCDEF"), "#abcdef");
  assert.equal(toMonacoColor("#abcdef80"), "#abcdef80");
  assert.equal(toMonacoColor("rgb(18, 20, 28)"), "#12141c");
  assert.equal(toMonacoColor("rgb(18 20 28)"), "#12141c");
  // The generated tokens are written with percentage channels (tokens.generated.css).
  assert.equal(toMonacoColor("rgb(7% 8% 11%)"), "#12141c");
  assert.equal(toMonacoColor("rgb(100% 0% 50%)"), "#ff0080");
  assert.equal(toMonacoColor("rgb(100% 100% 100% / 14%)"), "#ffffff24");
  assert.equal(toMonacoColor("rgba(0, 0, 0, 0.5)"), "#00000080");
  assert.equal(toMonacoColor("rgb(300 5 0)"), "#ff0500");
});

test("things that are not plain colours are rejected, not guessed", () => {
  for (const bad of ["", "red", "var(--x)", "color-mix(in srgb, red 10%, blue)", "#fff", "rgb(1 2)", "hsl(0 0% 0%)"]) assert.equal(toMonacoColor(bad), null, bad);
});
