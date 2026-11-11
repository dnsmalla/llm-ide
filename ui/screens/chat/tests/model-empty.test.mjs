import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const { ModelPicker } = await load("../chat/Pickers.tsx");

test("with no models, the picker offers the provider key path instead of an empty menu", () => {
  const out = renderToStaticMarkup(React.createElement(ModelPicker, { groups: [], provider: null, model: null, onChange() {}, onConnectProvider() {} }));
  assert.match(out, /Connect a provider/);
  assert.match(out, /Settings → Providers/);
  const loading = renderToStaticMarkup(React.createElement(ModelPicker, { groups: [], provider: null, model: null, onChange() {}, loading: true, onConnectProvider() {} }));
  assert.doesNotMatch(loading, /Connect a provider/, "no flash while the list loads");
});
