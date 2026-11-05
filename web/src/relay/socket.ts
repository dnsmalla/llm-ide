// A SocketLike over the relay (schema/relay/v1): HostConnection sends and receives plain Host API frames, this
// adapter seals them for the desktop and opens the desktop's replies. One relay session per instance. Never logs.
import type { SocketLike } from "../host-api/connection.ts";
import { authProof, keyConfirmPlaintext, open, RelayCryptoError, seal, sha256, unwrap, importVerifyKey } from "./crypto.ts";
import { b64u, KEY_MESSAGE_CAP, unb64u, type Envelope, type Header } from "./wire.ts";

export interface RelayDeviceKeys { token: string; signingKey: CryptoKey; ecdhKey: CryptoKey; ecdhSpki: Uint8Array; desktopSigningSpki: Uint8Array }
export interface RelaySession { epoch: number; request: CryptoKey | null; reply: CryptoKey | null; hostApiToken: string | null; sent: number }
export interface RelaySocketOptions {
  url: string; device: RelayDeviceKeys; session: RelaySession;
  createWs?: (url: string) => SocketLike; now?: () => number; onSession?: (s: RelaySession) => void;
}

const SKEW_MS = 10 * 60_000;
const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function createRelaySocket(o: RelaySocketOptions): SocketLike {
  const now = o.now ?? Date.now;
  const ws = (o.createWs ?? ((u) => new WebSocket(u) as unknown as SocketLike))(o.url);
  let ids: { userId: string; deviceId: string; desktopId: string } | null = null;
  let desktopVerify: CryptoKey | null = null;
  let openNonce: Uint8Array | null = null;
  let sid = ""; let sendSeq = 0; let recvSeq = 0;
  let state = 0; // 0 connecting, 1 open, 3 closed
  let chain = Promise.resolve();

  const self: SocketLike = {
    get readyState() { return state; },
    send(data: string) { chain = chain.then(() => sendFrame(data)).catch(fail); },
    close() { finish(); },
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };

  function finish() {
    if (state === 3) return;
    state = 3;
    try { ws.close(); } catch { /* closed */ }
    self.onclose?.();
  }
  function fail() { self.onerror?.(); finish(); }
  const raw = (obj: unknown) => ws.send(JSON.stringify(obj));
  const header = (purpose: Header["purpose"], session: string, seq: number): Header => ({
    purpose, userId: ids!.userId, desktopId: ids!.desktopId, from: ids!.deviceId, to: ids!.desktopId,
    epoch: o.session.epoch, session, seq, issuedAt: now(), tier: "",
  });
  async function up(h: Header, plaintext: Uint8Array) {
    if (!o.session.request || ++o.session.sent > KEY_MESSAGE_CAP) throw new RelayCryptoError("key_exhausted");
    raw({ t: "env", env: await seal(h, o.session.request, plaintext, o.device.signingKey) });
  }
  async function sendOpen() {
    if (!ids || !o.session.request) return;
    openNonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
    await up(header("open", "", 0), openNonce);
  }
  async function sendFrame(data: string) {
    if (state !== 1) throw new RelayCryptoError("not_open");
    await up(header("request", sid, ++sendSeq), new TextEncoder().encode(data));
  }

  async function onEnv(env: Envelope) {
    if (!ids) return;
    if (Math.abs(now() - env.issuedAt) > SKEW_MS) return; // surfaced by the caller's connection timeout
    desktopVerify ??= await importVerifyKey(o.device.desktopSigningSpki);
    const verifyKey = desktopVerify;
    if (!verifyKey) return;
    if (env.purpose === "wrap") {
      const w = await unwrap(env, { deviceId: ids.deviceId, ecdhPrivate: o.device.ecdhKey, ecdhSpki: o.device.ecdhSpki, desktopVerify: verifyKey, desktopSigningSpki: o.device.desktopSigningSpki, currentEpoch: o.session.epoch });
      Object.assign(o.session, { epoch: env.epoch, request: w.request, reply: w.reply, hostApiToken: w.hostApiToken, sent: 0 });
      o.onSession?.(o.session);
      await up(header("keyconfirm", "", 0), await keyConfirmPlaintext(w.sig));
      return;
    }
    if (!o.session.reply) return;
    const expect = { from: ids.desktopId, to: ids.deviceId, userId: ids.userId, desktopId: ids.desktopId, epoch: o.session.epoch };
    if (env.purpose === "opened" && openNonce && state === 0) {
      const echo = await open(env, o.session.reply, verifyKey, { ...expect, purpose: "opened" });
      if (b64u(echo) !== b64u(openNonce)) return;
      sid = env.session; sendSeq = 0; recvSeq = 0; openNonce = null; state = 1;
      self.onopen?.();
      return;
    }
    if (env.purpose === "reply" && state === 1 && env.session === sid && env.seq > recvSeq) {
      const pt = await open(env, o.session.reply, verifyKey, { ...expect, purpose: "reply", session: sid });
      recvSeq = env.seq;
      self.onmessage?.({ data: new TextDecoder().decode(pt) });
    }
  }

  async function onControl(m: Record<string, unknown>) {
    if (m.t === "challenge") {
      const hash = hexOf(await sha256(unb64u(o.device.token)));
      raw({ t: "auth", token: o.device.token, proof: await authProof(o.device.signingKey, String(m.nonce), "device", hash) });
    } else if (m.t === "ready") {
      ids = { userId: String(m.userId), deviceId: String(m.deviceId), desktopId: String(m.desktopId) };
    } else if (m.t === "ping") {
      raw({ t: "pong" });
    } else if (m.t === "peer" && ids && m.id === ids.desktopId) {
      if (m.online === true && state === 0) await sendOpen();
      if (m.online === false) finish();
    } else if (m.t === "env") {
      await onEnv(m.env as Envelope);
    } else if (m.t === "err" && m.code === "auth_failed") {
      fail();
    }
  }

  ws.onmessage = (e) => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(e.data)); } catch { return fail(); }
    chain = chain.then(() => onControl(m)).catch((err) => { if (!(err instanceof RelayCryptoError) || err.code === "key_exhausted") fail(); });
  };
  ws.onclose = () => finish();
  ws.onerror = () => fail();
  return self;
}
