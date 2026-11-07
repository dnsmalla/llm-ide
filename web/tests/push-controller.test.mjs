import { test } from "node:test";
import assert from "node:assert/strict";
import { createPushController, b64uBytes, sameKey } from "../src/push/controller.ts";

const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const OTHER = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
function fakeLink(results = {}, caps = ["host", "chat", "push"]) {
  const calls = [];
  return { capabilities: new Set(caps), calls,
    send(command, payload) { calls.push({ command, payload }); const r = typeof results[command] === "function" ? results[command]() : results[command]; return { id: `c-${calls.length}`, done: r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? {}) }; },
    onEvent: () => () => {}, onResync: () => () => {}, onState: () => () => {} };
}
function sub(key = KEY) {
  const s = { endpoint: "https://fcm.googleapis.com/fcm/send/e1", options: { applicationServerKey: b64uBytes(key).buffer }, unsubscribed: false,
    toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/e1", keys: { p256dh: `${OTHER}=`, auth: "BTBZMqHH6r4Tts7J_aSIgg==" } }),
    unsubscribe: async () => { s.unsubscribed = true; return true; } };
  return s;
}
function fakeEnv({ permission = "default", grant = "granted", existing = null } = {}) {
  const e = { perm: permission, current: existing, subscribed: [],
    permission: () => e.perm, requestPermission: async () => { e.perm = grant; return grant; },
    subscription: async () => e.current, subscribe: async (key) => { e.subscribed.push(key); e.current = sub(); return e.current; } };
  return e;
}
const CFG = { webPushKey: KEY, apns: false, registered: "none" };

test("base64url keys decode, and only an equal key matches", () => {
  assert.equal(b64uBytes(KEY).length, 65);
  assert.equal(sameKey(b64uBytes(KEY).buffer, b64uBytes(KEY)), true);
  assert.equal(sameKey(b64uBytes(OTHER).buffer, b64uBytes(KEY)), false);
  assert.equal(sameKey(null, b64uBytes(KEY)), false);
});

test("without the push capability or browser support nothing is offered or sent", async () => {
  const link = fakeLink({}, ["host", "chat"]);
  const c = createPushController(link, fakeEnv());
  await c.refresh(); await c.enable();
  assert.equal(c.getState().kind, "unavailable");
  assert.equal(link.calls.length, 0);
  const c2 = createPushController(fakeLink(), fakeEnv({ permission: "unsupported" }));
  await c2.refresh();
  assert.equal(c2.getState().kind, "unavailable");
});

test("enable asks, subscribes with the desktop key and registers unpadded keys", async () => {
  const link = fakeLink({ "push.config": CFG, "push.register": { registered: true } });
  const env = fakeEnv();
  const c = createPushController(link, env);
  await c.refresh();
  assert.equal(c.getState().kind, "off");
  await c.enable();
  assert.equal(c.getState().kind, "on");
  assert.deepEqual([...env.subscribed[0]], [...b64uBytes(KEY)]);
  assert.deepEqual(link.calls.at(-1), { command: "push.register", payload: { kind: "webpush", endpoint: "https://fcm.googleapis.com/fcm/send/e1", p256dh: OTHER, auth: "BTBZMqHH6r4Tts7J_aSIgg" } });
});

test("a refused permission is blocked; a subscription for an old desktop key is replaced", async () => {
  const c = createPushController(fakeLink({ "push.config": CFG }), fakeEnv({ grant: "denied" }));
  await c.enable();
  assert.equal(c.getState().kind, "blocked");
  const old = sub(OTHER);
  const env = fakeEnv({ existing: old });
  const c2 = createPushController(fakeLink({ "push.config": CFG, "push.register": { registered: true } }), env);
  await c2.enable();
  assert.equal(old.unsubscribed, true);
  assert.equal(env.subscribed.length, 1);
  assert.equal(c2.getState().kind, "on");
});

test("on only when the desktop has this browser's subscription for its key; disable forgets both sides", async () => {
  const env = fakeEnv({ permission: "granted", existing: sub() });
  const link = fakeLink({ "push.config": { ...CFG, registered: "webpush" }, "push.unregister": { removed: true } });
  const c = createPushController(link, env);
  await c.refresh();
  assert.equal(c.getState().kind, "on");
  await c.disable();
  assert.equal(c.getState().kind, "off");
  assert.equal(env.current.unsubscribed, true);
  assert.equal(link.calls.at(-1).command, "push.unregister");
  const failing = createPushController(fakeLink({ "push.config": new Error("The desktop is busy.") }), fakeEnv({ permission: "granted" }));
  await failing.refresh();
  assert.deepEqual(failing.getState(), { kind: "off", error: "The desktop is busy." });
});
