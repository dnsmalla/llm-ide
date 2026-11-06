import { test } from "node:test";
import assert from "node:assert/strict";
import { MacBridge, PAIR_AGAIN, refusalText } from "../../bridge/mac-bridge.ts";

// Security review bridge-3006: the Mac grants the desktop class at pairing. A phone-class record (or a refused
// pairing) is told how to fix it instead of a bare "only available on your Mac".
test("a desktop_only refusal tells the desktop app to pair again", () => {
  assert.equal(refusalText("desktop_only", "This is only available on your Mac."), PAIR_AGAIN);
  assert.match(PAIR_AGAIN, /Pair again from Settings → Mobile Bridge to allow Auto Tasks control/);
});

test("a refused desktop pairing keeps the Mac's own message", () => {
  const m = "Your Mac did not allow Auto Tasks control. Pair again from Settings → Mobile Bridge to allow Auto Tasks control.";
  assert.equal(refusalText("desktop_denied", m), m);
  assert.equal(refusalText("desktop_denied", null), PAIR_AGAIN);
});

test("other refusals pass through", () => {
  assert.equal(refusalText("tier_refused", "nope"), "nope");
  assert.equal(refusalText(null, null), "The Mac refused that request.");
});

// The bridge's storage and socket lifecycle, with a fake WebSocket and localStorage.
type FakeSocket = {
  readyState: number; sent: string[];
  onopen: null | (() => void); onmessage: null | ((e: { data: string }) => void);
  onclose: null | (() => void); onerror: null | (() => void);
  send(d: string): void; close(): void;
};
const sockets: FakeSocket[] = [];
function fakeSocket(): FakeSocket {
  const ws: FakeSocket = {
    readyState: 1, sent: [] as string[],
    onopen: null as null | (() => void), onmessage: null as null | ((e: { data: string }) => void),
    onclose: null as null | (() => void), onerror: null as null | (() => void),
    send(d: string) { ws.sent.push(d); }, close() { ws.readyState = 3; },
  };
  sockets.push(ws);
  return ws;
}
function installBrowser(): Map<string, string> {
  const store = new Map<string, string>();
  sockets.length = 0;
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    window: { setInterval: () => 1, clearInterval: () => {} },
    WebSocket: Object.assign(function FakeWebSocket() { return fakeSocket(); }, { OPEN: 1, CONNECTING: 0 }),
  });
  return store;
}

test("the pairing token stays in memory; localStorage holds only the device id", () => {
  const store = installBrowser();
  const b = new MacBridge();
  b.connect("1234");
  const ws = sockets[0];
  ws.onopen?.();
  ws.onmessage?.({ data: JSON.stringify({ type: "connected", token: "tok-secret", deviceName: "Mac" }) });
  assert.equal(b.paired, true);
  const raw = store.get("llmide.macBridge") ?? "";
  assert.equal(JSON.parse(raw).token, undefined);
  assert.ok(JSON.parse(raw).deviceId);
  assert.ok(!raw.includes("tok-secret"));
});

test("a replaced socket closing does not clear the current socket", () => {
  installBrowser();
  const b = new MacBridge();
  b.connect("1234");
  const old = sockets[0];
  b.disconnect();
  b.connect("1234");
  const current = sockets[1];
  old.onclose?.();
  assert.equal(b["ws"], current);
});
