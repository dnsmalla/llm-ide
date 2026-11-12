import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHostUrl, initialHostUrl, hostUrlHint, DEFAULT_HOST_URL } from "../src/host-api/url.ts";
import { tokenStoreFor, lastHostUrl } from "../src/host-api/storage.ts";

test("loopback ws and any wss are accepted and normalised", () => {
  assert.deepEqual(checkHostUrl(" ws://127.0.0.1:3016/host-api/v1 ", "http:"), { ok: true, url: "ws://127.0.0.1:3016/host-api/v1" });
  for (const u of ["ws://localhost:3017/host-api/v1", "ws://[::1]:3016/host-api/v1", "wss://desk.example:3016/host-api/v1"]) {
    assert.equal(checkHostUrl(u, "http:").ok, true, u);
  }
});

test("a hub's https or /app/ URL normalises to the Host API websocket", () => {
  assert.deepEqual(checkHostUrl(" https://hub.example.com ", "https:"), { ok: true, url: "wss://hub.example.com/host-api/v1" });
  assert.deepEqual(checkHostUrl("https://hub.example.com/app/", "https:"), { ok: true, url: "wss://hub.example.com/host-api/v1" });
  assert.deepEqual(checkHostUrl("wss://hub.example.com", "https:"), { ok: true, url: "wss://hub.example.com/host-api/v1" });
  assert.deepEqual(checkHostUrl("http://127.0.0.1:3016", "http:"), { ok: true, url: "ws://127.0.0.1:3016/host-api/v1" });
});

test("everything else is refused with a reason", () => {
  const bad = {
    "ws://192.168.1.20:3016/host-api/v1": /wss:\/\//,
    "http://evil.example.com/host-api/v1": /only to this computer/,
    "ws://127.0.0.1:3016/other": /\/host-api\/v1/,
    "ws://u:p@127.0.0.1:3016/host-api/v1": /user, query or fragment/,
    "ws://127.0.0.1:3016/host-api/v1?t=1": /user, query or fragment/,
    "not a url": /Enter a hub address/,
    "ws://127.0.0.1.evil.com:3016/host-api/v1": /only to this computer/,
    "ws://127.0.0.1:3016/host-api/v1?x=1": /user, query or fragment/,
    "ws://127.0.0.1:3016/host-api/v1#f": /user, query or fragment/,
    "ws://127.0.0.1:3016/host-api/v1/": /\/host-api\/v1/,
  };
  for (const [u, re] of Object.entries(bad)) {
    const r = checkHostUrl(u, "http:");
    assert.equal(r.ok, false, u);
    assert.match(r.reason, re, u);
  }
  assert.match(checkHostUrl("ws://127.0.0.1:3016/host-api/v1", "https:").reason, /served over https/);
});

test("the initial URL prefers the last one, then the build variable, then the default", () => {
  assert.equal(initialHostUrl(undefined, null), DEFAULT_HOST_URL);
  assert.equal(initialHostUrl("wss://h.example:3016/host-api/v1", null), "wss://h.example:3016/host-api/v1");
  assert.equal(initialHostUrl("wss://h.example:3016/host-api/v1", "ws://127.0.0.1:3017/host-api/v1"), "ws://127.0.0.1:3017/host-api/v1");
  assert.equal(initialHostUrl("garbage", "also garbage"), DEFAULT_HOST_URL);
});

test("on an https page the default is empty and the hint names wss://", () => {
  assert.equal(initialHostUrl(undefined, null, "https:"), "");
  assert.equal(initialHostUrl(undefined, "ws://127.0.0.1:3017/host-api/v1", "https:"), "");
  assert.equal(initialHostUrl("wss://h.example:3016/host-api/v1", null, "https:"), "wss://h.example:3016/host-api/v1");
  assert.match(hostUrlHint("https:"), /wss:\/\//);
  assert.doesNotMatch(hostUrlHint("https:"), /127\.0\.0\.1/);
});

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

test("tokens are per host URL and bounded", () => {
  const s = memory();
  const a = tokenStoreFor("ws://127.0.0.1:3016/host-api/v1", s);
  const b = tokenStoreFor("ws://127.0.0.1:3017/host-api/v1", s);
  a.set("a".repeat(40));
  assert.equal(a.get(), "a".repeat(40));
  assert.equal(b.get(), null);
  s.setItem("llmide.hostApi.v1.token:ws://127.0.0.1:3017/host-api/v1", "short");
  assert.equal(b.get(), null, "a malformed stored value is ignored");
  a.set(null);
  assert.equal(s.m.size, 1);
});

test("a throwing or missing storage keeps the token in memory for this page", () => {
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  for (const st of [throwing, null]) {
    const t = tokenStoreFor("ws://127.0.0.1:3016/host-api/v1", st);
    t.set("m".repeat(40));
    assert.equal(t.get(), "m".repeat(40));
    t.set(null);
    assert.equal(t.get(), null);
  }
  const last = lastHostUrl(memory());
  last.set("ws://127.0.0.1:3016/host-api/v1");
  assert.equal(last.get(), "ws://127.0.0.1:3016/host-api/v1");
});
