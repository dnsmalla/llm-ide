// Real core (bench-fake engine, no model), Host API dev listener, this page's origin allowlisted: the web client's
// protocol layer pairs, runs a chat turn, reads history, reconnects with its stored token and forgets the host.
// Binds local ports: run unsandboxed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { startCore } from "../../../ui/screens/shell/tests/e2e/core-server.mjs";
import { busHostProof, BUS_PROOF_HEADER } from "../../../extension/core/host-approval.mjs";
import { HostConnection } from "../../src/host-api/connection.ts";
import { createChatController } from "../../src/chat/controller.ts";

const ORIGIN = "http://127.0.0.1:5180";
const KEY = randomBytes(32).toString("hex");
const skip = typeof WebSocket !== "function" ? "no global WebSocket in this Node" : process.env.LLMIDE_E2E === "0" ? "LLMIDE_E2E=0" : false;
let core, accessToken;

before(async () => {
  if (skip) return;
  core = await startCore({ env: {
    LLMIDE_HOST_API_DEV: "1",
    LLMIDE_HOST_API_WEB_ORIGINS: `${ORIGIN},https://evil.example`,
    LLMIDE_HOST_APPROVAL_KEY: KEY,
  } });
  const r = await fetch(`${core.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: core.email, password: core.password }) });
  assert.equal(r.status, 200);
  accessToken = (await r.json()).accessToken;
});
after(() => core?.stop());

async function mintPin() {
  const r = await fetch(`${core.base}/host-api/pin`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", [BUS_PROOF_HEADER]: busHostProof({ LLMIDE_HOST_APPROVAL_KEY: KEY }) },
    body: "{}",
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}

const upgradeStatus = (port, origin) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: "/host-api/v1", headers: {
    Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    ...(origin ? { Origin: origin } : {}),
  } });
  req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
  req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
  req.on("error", reject);
  req.end();
});

const memoryTokens = () => { let t = null; return { get: () => t, set: (v) => { t = v; } }; };
// A browser sends its Origin itself; Node's WebSocket (undici) takes it through the non-standard `headers` init.
const asBrowser = (url) => new WebSocket(url, { headers: { origin: ORIGIN } });
const client = (url, tokens) => new HostConnection({ url, clientName: "LLM-IDE Web e2e", clientVersion: "0.0.0", tokens, createSocket: asBrowser });
async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
}

test("the listener accepts the allowlisted web origin and a native client, and refuses the rest", { skip }, async () => {
  const { port } = await mintPin();
  assert.equal(await upgradeStatus(port, ORIGIN), 101);
  assert.equal(await upgradeStatus(port, null), 101, "native clients send no Origin");
  assert.equal(await upgradeStatus(port, "http://127.0.0.1:5181"), 403, "an unlisted port");
  assert.equal(await upgradeStatus(port, "https://evil.example"), 403, "a listed non-loopback origin is dropped by the core");
});

test("pair, run a chat turn, read history, reconnect with the token, forget the host", { skip }, async (t) => {
  const { pin, port } = await mintPin();
  const url = `ws://127.0.0.1:${port}/host-api/v1`;
  const tokens = memoryTokens();
  const conn = client(url, tokens);
  assert.equal(await conn.connect(pin), "ready");
  assert.equal(conn.hello.hostKind, "desktop");
  assert.deepEqual(conn.hello.apiVersions, [1]);
  assert.ok(conn.capabilities.has("chat"));
  const token = tokens.get();
  assert.ok(token && token.length >= 16);

  await assert.rejects(client(url, memoryTokens()).connect(pin), (e) => e.code === "auth_failed" && e.retryable === false, "the PIN is one-use");
  await new Promise((r) => setTimeout(r, 1200)); // the wrong-PIN attempt costs this peer a 1 s throttle delay

  const chat = createChatController(conn);
  await chat.resync();
  await chat.send("hi");
  await waitFor(() => chat.getState().turn === null);
  const reply = chat.getState().messages.at(-1);
  assert.deepEqual([reply.role, reply.status], ["assistant", "done"], JSON.stringify(reply));
  assert.match(reply.text, /^(ok )+/, "the bench-fake canned reply");

  await chat.resync();
  // The desktop gateway does not yet save the phone chat, so the snapshot is empty.
  await t.test("history returns the turn", { todo: "gateway persists the phone chat (in progress)" }, () => {
    assert.deepEqual(chat.getState().messages.slice(-2).map((m) => [m.role, m.status]), [["user", "done"], ["assistant", "done"]]);
  });
  chat.dispose();
  conn.close();

  const again = client(url, tokens);
  assert.equal(await again.connect(), "ready", "the stored token re-authenticates");
  assert.equal(await again.forget(), true);
  assert.equal(tokens.get(), null);

  const stale = client(url, { get: () => token, set() {} });
  assert.equal(await stale.connect(), "needsPin", "a revoked token is refused");
  stale.close();
});
