import assert from "node:assert/strict";
import test from "node:test";
import { h, html, loadUi } from "./helpers.mjs";

const UI = await loadUi();
const FP = "sha256:" + "A".repeat(43);
const link = (q) => `llmide://pair?${q}`;
const base = `pin=123456&h1port=3016&h1fp=${FP}&api=1`;

test("valid multi-address link: order kept, urls built", () => {
  const o = UI.parsePairingLink(link(`ip=192.168.1.5&ip=100.64.1.2&ip=mac.local&${base}`));
  assert.deepEqual(o, { addresses: ["192.168.1.5", "100.64.1.2", "mac.local"], pin: "123456", port: 3016, fingerprint: FP });
  assert.deepEqual(UI.candidateUrls(o), ["wss://192.168.1.5:3016/host-api/v1", "wss://100.64.1.2:3016/host-api/v1", "wss://mac.local:3016/host-api/v1"]);
});

test("invalid entries are dropped, duplicates removed, capped at four", () => {
  const o = UI.parsePairingLink(link(`ip=8.8.8.8&ip=10.0.0.1&ip=10.0.0.1&ip=192.168.1.1/x&ip=172.32.0.1&ip=10.0.0.2&ip=10.0.0.3&ip=10.0.0.4&ip=10.0.0.5&${base}`));
  assert.deepEqual(o.addresses, ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]);
  assert.equal(UI.parsePairingLink(link(`ip=8.8.8.8&ip=a/b.com&ip=-x.com&${base}`)), null);
});

test("IPv6: private literals only, bracketed in the url", () => {
  const o = UI.parsePairingLink(link(`ip=fd12::1&ip=2001:db8::1&ip=fe80::1%25en0&${base}`));
  assert.deepEqual(o.addresses, ["fd12::1", "fe80::1%en0"]); // 2001:db8::1 is public: refused
  assert.equal(UI.parsePairingLink(link(`ip=fd::1&${base}`)), null); // short first group, refused like iOS
  assert.equal(UI.candidateUrls(o)[1], "wss://[fe80::1%25en0]:3016/host-api/v1");
});

test("bad pin, port, fingerprint, scheme are rejected", () => {
  const ip = "ip=192.168.1.5";
  for (const q of [`${ip}&pin=12345&h1port=3016&h1fp=${FP}`, `${ip}&pin=12345a&h1port=3016&h1fp=${FP}`, `${ip}&h1port=3016&h1fp=${FP}`,
    `${ip}&pin=123456&h1port=0&h1fp=${FP}`, `${ip}&pin=123456&h1port=65536&h1fp=${FP}`, `${ip}&pin=123456&h1port=abc&h1fp=${FP}`, `${ip}&pin=123456&h1fp=${FP}`,
    `${ip}&pin=123456&h1port=3016`, `${ip}&pin=123456&h1port=3016&h1fp=sha256:short`, `${ip}&pin=123456&h1port=3016&h1fp=md5:${"A".repeat(43)}`]) {
    assert.equal(UI.parsePairingLink(link(q)), null, q);
  }
  assert.equal(UI.parsePairingLink(`https://pair?ip=192.168.1.5&${base}`), null);
  assert.equal(UI.parsePairingLink(`llmidex://pair?ip=192.168.1.5&${base}`), null);
  assert.equal(UI.parsePairingLink("hello"), null);
});

test("a public hub name is accepted only with a valid fingerprint (always present here)", () => {
  assert.deepEqual(UI.parsePairingLink(link(`ip=Hub.Example.com&${base}`)).addresses, ["hub.example.com"]);
  assert.equal(UI.parsePairingLink(link(`ip=8.8.8.8&${base}`)), null);
});

test("scan sheet: unsupported state offers paste and no photo or camera", () => {
  const out = html(h(UI.ScanView, { mode: "unavailable", notice: "x", problem: null, canDecodePhoto: false, onPhoto() {}, onPaste() {} }));
  assert.match(out, /Paste the pairing link/);
  assert.doesNotMatch(out, /type="file"|<video/);
  const cam = html(h(UI.ScanView, { mode: "scanning", notice: null, problem: null, canDecodePhoto: true, onPhoto() {}, onPaste() {} }));
  assert.match(cam, /<video/);
  assert.match(cam, /capture="environment"/);
});
