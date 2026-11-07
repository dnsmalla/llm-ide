// Web Push on this browser (Host API v1 capability `push`): subscribe with the desktop's VAPID key and register the
// subscription with the desktop, which pushes only a kind and a count while it runs. The worker (public/sw-push.js)
// shows the words. No React here.
import type { HostLink } from "../host-api/connection.ts";

export interface SubLike {
  readonly endpoint: string;
  readonly options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}
export interface PushEnv {
  permission(): NotificationPermission | "unsupported";
  requestPermission(): Promise<NotificationPermission>;
  subscription(): Promise<SubLike | null>;
  subscribe(key: Uint8Array): Promise<SubLike>;
}
export type PushState = { kind: "unavailable" | "off" | "on" | "blocked" | "busy"; error: string | null };

export function b64uBytes(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
export function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}
const unpad = (s: string | undefined) => (s ?? "").replace(/=+$/, "");

/** The real browser; "unsupported" where there is no Push API (e.g. Safari outside a home-screen web app). */
export function browserPushEnv(): PushEnv {
  const ok = typeof Notification !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in globalThis;
  const reg = () => navigator.serviceWorker.ready;
  return {
    permission: () => (ok ? Notification.permission : "unsupported"),
    requestPermission: () => Notification.requestPermission(),
    subscription: async () => (ok ? (await reg()).pushManager.getSubscription() : null),
    subscribe: async (key) => (await reg()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.buffer as ArrayBuffer }),
  };
}

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Push notifications could not be set up.");

export function createPushController(link: HostLink, env: PushEnv = browserPushEnv()) {
  let state: PushState = { kind: "unavailable", error: null };
  const subs = new Set<() => void>();
  const set = (s: PushState) => { state = s; for (const fn of subs) fn(); };
  const served = () => link.capabilities.has("push") && env.permission() !== "unsupported";

  async function refresh(): Promise<void> {
    if (!served()) return set({ kind: "unavailable", error: null });
    if (env.permission() === "denied") return set({ kind: "blocked", error: null });
    try {
      const [cfg, sub] = await Promise.all([link.send("push.config", {}).done, env.subscription()]);
      const on = cfg.registered === "webpush" && !!sub && sameKey(sub.options?.applicationServerKey, b64uBytes(cfg.webPushKey));
      set({ kind: on ? "on" : "off", error: null });
    } catch (e) { set({ kind: "off", error: messageOf(e) }); }
  }

  async function enable(): Promise<void> {
    if (!served()) return;
    set({ kind: "busy", error: null });
    try {
      if ((await env.requestPermission()) !== "granted") return set({ kind: "blocked", error: null });
      const cfg = await link.send("push.config", {}).done;
      const key = b64uBytes(cfg.webPushKey);
      let sub = await env.subscription();
      if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; } // the desktop's key changed
      sub ??= await env.subscribe(key);
      const j = sub.toJSON();
      await link.send("push.register", { kind: "webpush", endpoint: j.endpoint ?? sub.endpoint, p256dh: unpad(j.keys?.p256dh), auth: unpad(j.keys?.auth) }).done;
      set({ kind: "on", error: null });
    } catch (e) { set({ kind: "off", error: messageOf(e) }); }
  }

  async function disable(): Promise<void> {
    set({ kind: "busy", error: null });
    try { await link.send("push.unregister", {}).done; } catch { /* the desktop also forgets it with the device */ }
    try { await (await env.subscription())?.unsubscribe(); } catch { /* already gone */ }
    set({ kind: "off", error: null });
  }

  return { getState: () => state, subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; }, refresh, enable, disable };
}
