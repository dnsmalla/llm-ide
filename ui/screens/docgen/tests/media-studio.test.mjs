import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const m = await load("../docgen/MediaStudio.tsx");
const html = (el) => renderToStaticMarkup(el);

test("media studio offers a demo image and video model, with no network calls", () => {
  const out = html(React.createElement(m.MediaStudio));
  assert.match(out, /Media studio/);
  assert.match(out, /Demo provider/);
  assert.match(out, /demo-image-1|Demo Image 1/);
  assert.doesNotMatch(out, /<script|https?:\/\//);
});

test("demo media is a self-contained SVG data URL with the escaped prompt", () => {
  const image = m.demoImage("A <b>calm</b> diagram");
  assert.match(image, /^data:image\/svg\+xml/);
  assert.match(decodeURIComponent(image), /A &lt;b&gt;calm&lt;\/b&gt; diagram/);
  assert.doesNotMatch(decodeURIComponent(image), /<b>/);
  const video = m.demoVideo("loop");
  assert.match(decodeURIComponent(video), /<animate /);
  assert.match(decodeURIComponent(video), /DEMO VIDEO/);
});
