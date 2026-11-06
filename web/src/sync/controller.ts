// Sync tier controller (design 6, 4.3-4.4, 12; no React): pair this browser, unlock MEGA for this session, read the
// latest verified snapshot, queue chat prompts and collect replies. MEGA needs a password per session; the own server does not. The MEGA password reaches only the login call;
// nothing decrypted is persisted. Polls every 30 s while unlocked, online and not paused (desktop live over Host API).
import { parsePair, type Pair } from "./enroll.ts";
import { SyncCryptoError } from "./envelope.ts";
import { prepareClaim, putClaim, readAck, readFirstWrap, readReply, readSnapshot, sendRequest, type BlobCache, type Enrolling } from "./device.ts";
import { indexedDbKeyStore, memoryKeyStore, type KeyStore, type LinkedDevice } from "./keystore.ts";
import type { Snapshot } from "./kinds.ts";
import { openMegaStore, type OpenedStore } from "./mega-store.ts";
import { openHttpsStore, WEB_HOST_RE } from "./https-store.ts";
import { takePairLink } from "./pair-fragment.ts";

export const POLL_MS = 30_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
export const PAIR_POLL_MS = 2_000;
export const ACK_WAIT_MS = 150_000;
export const WRAP_WAIT_MS = 300_000;
export const MAX_PENDING = 5;
export const MAX_ANSWERED = 50;
export const PENDING_DROP_MS = 8 * 86_400_000;

export type SyncPhase = "none" | "pairing" | "locked" | "ready" | "removed";
export type PairStep = "login" | "claiming" | "sas" | null;
export interface QueuedPrompt { requestId: string; issuedAt: number; text: string | null }
export interface Answered extends QueuedPrompt { ok: boolean; reply: string | null; code: string | null }
export interface SyncState {
  phase: SyncPhase; pairStep: PairStep; sas: string | null; busy: boolean; error: string | null; notice: string | null;
  online: boolean; email: string; login: boolean; snapshot: Snapshot | null; stale: boolean; checkedAt: number | null;
  pending: QueuedPrompt[]; answered: Answered[];
}
export interface SyncDeps {
  keystore: KeyStore;
  openStore: (c: { st: string; email: string; password: string }) => Promise<OpenedStore>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  confirm: (message: string) => boolean;
  online: () => boolean;
  onNetwork: (fn: (online: boolean) => void) => () => void;
  takePairLink: () => string | null;
}

export const FORGET_SYNC_CONFIRM = "Forget offline sync in this browser? You will need a new pairing link from the desktop.";
export const NOT_REMEMBERED = "This browser cannot keep the sync link (private window or blocked site data). You will need a new pairing link next time.";
export const TEXT: Record<string, string> = {
  SYNC_AUTH_FAILED: "MEGA refused the email or password.",
  SYNC_MFA_REQUIRED: "This MEGA account has two-factor login on. Use the dedicated LLM-IDE sync account, which has it off.",
  SYNC_RATE_LIMITED: "The sync storage asked us to slow down. Trying again later.",
  SYNC_QUOTA: "The MEGA account is over its storage or transfer quota.",
  SYNC_UNREACHABLE: "The sync storage is not reachable. Check the network.",
  SYNC_SESSION_EXPIRED: "The MEGA session ended. Enter the password again.",
  SYNC_BAD_EMAIL: "Enter the sync account's email address.",
  SYNC_BAD_PASSWORD: "Enter the sync account's password.",
  SYNC_MISSING: "The sync folder for this browser was not found.",
  bad_pair: "This is not a valid LLM-IDE pairing link.",
  unsupported_store: "This link is for a storage this browser cannot open yet.",
  bad_desktop_key: "This pairing link does not match the desktop key in storage. Show a new code on the desktop.",
  ack_mismatch: "Someone else answered this code. Cancel on the desktop and start again.",
  pair_timeout: "The code expired. Show a new one on the desktop.",
  bad_name: "The browser name is 1 to 64 characters.",
  bad_text: "A prompt is 1 to 4,000 characters.",
};
const codeOf = (e: unknown): string => (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "");
export function textOf(e: unknown): string {
  const code = codeOf(e);
  if (TEXT[code]) return TEXT[code];
  if (e instanceof SyncCryptoError) return `Storage returned data that failed verification (${code}). Nothing from it was used.`;
  if (code.startsWith("SYNC_")) return `Sync storage operation failed (${code}).`;
  return "Something went wrong.";
}
export function folderOf(st: string): string {
  const m = /^mega:([A-Za-z0-9_.-]{1,64})$/.exec(st);
  if (!m || m[1] === "." || m[1] === "..") throw new SyncCryptoError("unsupported_store");
  return m[1];
}

export const needsLogin = (st: string) => !st.startsWith("sftp:");
export function hostOf(st: string): string {
  const host = st.startsWith("sftp:") ? st.slice(5) : "";
  if (!WEB_HOST_RE.test(host)) throw new SyncCryptoError("unsupported_store");
  return host;
}
const checkStore = (st: string) => (needsLogin(st) ? folderOf(st) : hostOf(st));

function defaultDeps(): SyncDeps {
  const g = globalThis as unknown as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
  return {
    keystore: indexedDbKeyStore() ?? memoryKeyStore(),
    openStore: async (c) => (needsLogin(c.st) ? openMegaStore({ email: c.email, password: c.password, folder: folderOf(c.st) }) : openHttpsStore(hostOf(c.st))),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]),
    confirm: (m) => globalThis.confirm?.(m) ?? true,
    online: () => globalThis.navigator?.onLine ?? true,
    onNetwork: (fn) => {
      const on = () => fn(true); const off = () => fn(false);
      g.addEventListener?.("online", on); g.addEventListener?.("offline", off);
      return () => { g.removeEventListener?.("online", on); g.removeEventListener?.("offline", off); };
    },
    takePairLink,
  };
}

export function createSyncController(deps: Partial<SyncDeps> = {}) {
  const d: SyncDeps = { ...defaultDeps(), ...deps };
  let state: SyncState = { phase: "none", pairStep: null, sas: null, busy: false, error: null, notice: null, online: d.online(), email: "", login: true,
    snapshot: null, stale: false, checkedAt: null, pending: [], answered: [] };
  const subs = new Set<() => void>();
  const set = (p: Partial<SyncState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };
  let device: LinkedDevice | null = null;
  let store: OpenedStore | null = null;
  let pair: Pair | null = null;
  let claim: Enrolling | null = null; // prepared for `pair`; kept across retries so a retry rewrites the same claim (4c)
  let pairRun = 0;
  let paused = false; let disposed = false; let refreshing = false;
  let timer: unknown = null; let backoff = POLL_MS;
  let offNet: (() => void) | null = null;
  const texts = new Map<string, string>();
  const cache: BlobCache = new Map();

  const pendingView = (): QueuedPrompt[] => (device?.pending ?? []).map((p) => ({ ...p, text: texts.get(p.requestId) ?? null }));
  const clearTimer = () => { if (timer !== null) d.clearTimer(timer); timer = null; };
  const schedule = () => {
    clearTimer();
    if (store && device && !paused && !disposed && state.online && state.phase === "ready") timer = d.setTimer(() => { timer = null; void refresh(); }, backoff);
  };
  const closeStore = async () => { clearTimer(); const s = store; store = null; cache.clear(); if (s) await s.close().catch(() => {}); };
  const save = async () => {
    if (!device) return;
    try { await d.keystore.save(device); } catch { d.keystore = memoryKeyStore(); await d.keystore.save(device); set({ notice: NOT_REMEMBERED }); }
  };

  async function waitFor<T>(run: number, probe: () => Promise<T | null>, ms: number): Promise<T> {
    const until = d.now() + ms;
    for (;;) {
      if (run !== pairRun || disposed) throw new SyncCryptoError("cancelled");
      const v = await probe();
      if (v !== null) return v;
      if (d.now() >= until) throw new SyncCryptoError("pair_timeout");
      await d.sleep(PAIR_POLL_MS);
    }
  }

  function acceptLink(url: string): boolean {
    try {
      const p = parsePair(url.trim());
      checkStore(p.st);
      void closeStore();
      pairRun += 1; pair = p; claim = null;
      set({ phase: "pairing", pairStep: null, sas: null, busy: false, error: null, snapshot: null, login: needsLogin(p.st),
        notice: device ? "Pairing again replaces this browser's current sync link." : null });
      return true;
    } catch (e) { set({ error: textOf(e) }); return false; }
  }

  async function pairNow(i: { email: string; password: string; name: string }) {
    const p = pair;
    if (!p || state.busy) return;
    const run = ++pairRun;
    set({ busy: true, error: null, pairStep: "login", sas: null });
    let s: OpenedStore | null = null;
    try {
      s = await d.openStore({ st: p.st, email: i.email, password: i.password });
      set({ pairStep: "claiming" });
      claim ??= await prepareClaim(s, p, { name: i.name, now: d.now() });
      const e = claim;
      await putClaim(s, e);
      pair = null; claim = null;
      const open = s;
      const sas = await waitFor(run, () => readAck(open, e), ACK_WAIT_MS);
      set({ pairStep: "sas", sas });
      const linked = await waitFor(run, () => readFirstWrap(open, e, { megaEmail: needsLogin(p.st) ? i.email : "" }), WRAP_WAIT_MS);
      await closeStore();
      device = linked; store = s; s = null; texts.clear();
      await save();
      backoff = POLL_MS;
      set({ phase: "ready", pairStep: null, sas: null, busy: false, email: i.email, snapshot: null, answered: [], pending: [] });
      await refresh();
    } catch (e) {
      if (s) await s.close().catch(() => {});
      if (run !== pairRun) return;
      set({ busy: false, pairStep: null, sas: null, error: textOf(e), phase: pair ? "pairing" : device ? "locked" : "none" });
    }
  }

  async function unlock(i: { email: string; password: string }) {
    if (!device || state.busy) return;
    set({ busy: true, error: null });
    try {
      const s = await d.openStore({ st: device.st, email: i.email, password: i.password });
      await closeStore();
      store = s;
      if (needsLogin(device.st) && device.megaEmail !== i.email) { device.megaEmail = i.email; await save(); }
      backoff = POLL_MS;
      set({ phase: "ready", busy: false, email: i.email, login: needsLogin(device.st) });
      await refresh();
    } catch (e) { set({ busy: false, error: textOf(e) }); }
  }

  async function refresh() {
    const s = store; const dev = device;
    if (!s || !dev || paused || disposed || refreshing || !state.online || state.phase !== "ready") return;
    refreshing = true; clearTimer(); set({ busy: true });
    try {
      let snap: Snapshot | null;
      try { snap = await readSnapshot(s, dev, d.now(), cache); }
      catch (e) { if (codeOf(e) !== "updating") throw e; snap = await readSnapshot(s, dev, d.now(), cache); }
      const answered: Answered[] = [];
      let problem: unknown = null;
      for (const p of [...dev.pending]) {
        const text = texts.get(p.requestId) ?? null;
        try {
          const r = await readReply(s, dev, p.requestId, d.now());
          if (r) { texts.delete(p.requestId); answered.push({ ...p, text, ok: r.ok, reply: r.ok ? r.text : null, code: r.ok ? null : r.code }); }
          else if (d.now() - p.issuedAt > PENDING_DROP_MS) {
            dev.pending = dev.pending.filter((x) => x.requestId !== p.requestId);
            answered.push({ ...p, text, ok: false, reply: null, code: "expired" });
          }
        } catch (e) { problem ??= e; }
      }
      await save();
      backoff = POLL_MS;
      const shown = snap ?? state.snapshot;
      set({ busy: false, snapshot: shown, stale: !!shown && d.now() > shown.validUntil, checkedAt: d.now(), error: problem ? textOf(problem) : null,
        notice: shown ? null : "Waiting for the desktop's first snapshot.", pending: pendingView(), answered: [...answered, ...state.answered].slice(0, MAX_ANSWERED) });
    } catch (e) {
      const code = codeOf(e);
      await save();
      if (code === "removed") { await closeStore(); set({ busy: false, phase: "removed", snapshot: null, error: null }); return; }
      if (code === "SYNC_SESSION_EXPIRED" || code === "SYNC_AUTH_FAILED") {
        await closeStore(); set({ busy: false, phase: "locked", snapshot: null, error: TEXT.SYNC_SESSION_EXPIRED }); return;
      }
      if (code.startsWith("SYNC_")) backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      set({ busy: false, error: textOf(e), checkedAt: d.now(), pending: pendingView() });
    } finally { refreshing = false; schedule(); }
  }

  async function send(text: string): Promise<boolean> {
    const s = store; const dev = device;
    if (!s || !dev || state.phase !== "ready") return false;
    if (dev.pending.length >= MAX_PENDING) { set({ error: `${MAX_PENDING} prompts are already waiting for the desktop.` }); return false; }
    try {
      const id = await sendRequest(s, dev, text, d.now());
      texts.set(id, text);
      await save();
      set({ pending: pendingView(), error: null, notice: "Queued. It runs when the desktop is back." });
      return true;
    } catch (e) { set({ error: textOf(e) }); return false; }
  }

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    async start() {
      if (offNet || disposed) return;
      offNet = d.onNetwork((on) => { set({ online: on }); if (on) void refresh(); else clearTimer(); });
      const link = d.takePairLink();
      try { device = await d.keystore.load(); } catch { device = null; d.keystore = memoryKeyStore(); set({ notice: NOT_REMEMBERED }); }
      set({ phase: device ? "locked" : "none", email: device?.megaEmail ?? "", pending: pendingView(), login: device ? needsLogin(device.st) : true });
      if (link) acceptLink(link);
      else if (device && !needsLogin(device.st)) await unlock({ email: "", password: "" });
    },
    acceptLink,
    pair: pairNow,
    cancelPairing() { pairRun += 1; pair = null; claim = null; set({ phase: device ? "locked" : "none", pairStep: null, sas: null, busy: false, error: null, login: device ? needsLogin(device.st) : true }); },
    unlock,
    refresh,
    send,
    async lock() {
      pairRun += 1; await closeStore(); texts.clear();
      set({ phase: device ? "locked" : "none", snapshot: null, answered: [], pending: pendingView(), error: null, notice: null, stale: false, busy: false, login: device ? needsLogin(device.st) : true });
    },
    async forget() {
      if (!d.confirm(FORGET_SYNC_CONFIRM)) return;
      pairRun += 1; await closeStore(); device = null; pair = null; claim = null; texts.clear();
      try { await d.keystore.clear(); } catch { /* nothing kept */ }
      set({ phase: "none", snapshot: null, answered: [], pending: [], error: null, notice: null, stale: false, email: "", busy: false, login: true });
    },
    pause() { paused = true; clearTimer(); },
    resume() { if (!paused) return; paused = false; void refresh(); },
    dispose() { disposed = true; pairRun += 1; offNet?.(); offNet = null; void closeStore(); subs.clear(); },
  };
}

export type SyncController = ReturnType<typeof createSyncController>;
