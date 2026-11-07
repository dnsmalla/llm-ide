// Settings > General > Phone and web push: decoding the status, the per-device line and the APNs key form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const c = await load("notify/PushCard.tsx");
const STATUS = { served: true, apns: { configured: false, keyId: null, teamId: null }, devices: [{ deviceId: "h1-a", name: "iPhone", kind: "apns", lastResult: "ok", lastAt: 1 }] };

test("the status decodes strictly and drops malformed devices", () => {
  assert.deepEqual(c.decodePushStatus(STATUS), STATUS);
  assert.equal(c.decodePushStatus({ ...STATUS, served: "yes" }), null);
  assert.equal(c.decodePushStatus(null), null);
  const d = c.decodePushStatus({ ...STATUS, devices: [...STATUS.devices, { deviceId: "x", name: "w", kind: "sms" }, 3] });
  assert.equal(d.devices.length, 1);
});

test("each result reads in plain words, unknown codes as a failure", () => {
  assert.equal(c.resultLabel(null), "Nothing sent yet");
  assert.equal(c.resultLabel("ok"), "Last push accepted by the push service");
  assert.equal(c.resultLabel("rate_limited"), "Held back: too many pushes this hour");
  assert.equal(c.resultLabel("APNS_NOT_CONFIGURED"), "Waiting for the Apple Push key below");
  assert.equal(c.resultLabel("APNS_403_BadCertificate"), "Last push failed");
});

test("the card lists devices, asks for the key when none is saved, and never shows a saved key", () => {
  const noop = () => {};
  const empty = renderToStaticMarkup(React.createElement(c.PushBody, { status: STATUS, error: null, onSave: noop, onRemove: noop }));
  assert.match(empty, /iPhone · iPhone · Last push accepted/);
  assert.match(empty, /Apple Push key \(\.p8\)/);
  assert.match(empty, /Key ID/);
  assert.match(empty, /value="9A3YFRQ7SM"/, "the team id is prefilled but editable");
  const saved = renderToStaticMarkup(React.createElement(c.PushBody, { status: { ...STATUS, apns: { configured: true, keyId: "ABCDE12345", teamId: "9A3YFRQ7SM" } }, error: null, onSave: noop, onRemove: noop }));
  assert.match(saved, /ABCDE12345/);
  assert.match(saved, /Remove key/);
  assert.doesNotMatch(saved, /\.p8\)/);
  const off = renderToStaticMarkup(React.createElement(c.PushBody, { status: null, error: null, onSave: noop, onRemove: noop }));
  assert.match(off, /LLMIDE_HOST_API_PUSH=1/);
});
