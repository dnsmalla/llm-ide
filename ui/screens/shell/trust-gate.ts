// Decides whether credentials (login password, refresh token, bearer token, the token published to the host) may
// go to the current core. Only a core the host SPAWNED itself is trusted; an adopted or still-unverified server on
// 127.0.0.1 could be any local process, so the user must confirm it explicitly. The confirmation is in memory only,
// bound to this core instance (url + restart count + pid), and never persisted: a different or restarted core asks again.
//
// Outside the desktop app (no host bridge: `vite dev`, tests) there is nothing to verify; that dev mode is explicit.
import type { CoreStatus } from "./host";

export interface TrustView {
  allowed: boolean;
  /** The user can be asked (a core is up but not spawned by us). */
  needsConfirm: boolean;
  url: string | null;
}

export interface TrustGate {
  /** May credentials be sent to the current core right now? */
  allowed(): boolean;
  view(): TrustView;
  /** The user confirmed THIS core instance in the modal. */
  confirm(): void;
  subscribe(listener: () => void): () => void;
}

export interface TrustGateOptions {
  getStatus: () => CoreStatus | null;
  /** False in a plain browser / tests: dev mode, credentials allowed. */
  isHost: () => boolean;
  subscribeStatus?: (l: () => void) => () => void;
}

const keyOf = (s: CoreStatus): string => `${s.url}#${s.restarts}#${s.pid ?? "?"}#${s.trust}`;

export function createTrustGate(o: TrustGateOptions): TrustGate {
  let confirmed: string | null = null;
  const listeners = new Set<() => void>();
  const fire = () => {
    for (const l of [...listeners]) l();
  };
  let cached: TrustView = { allowed: false, needsConfirm: false, url: null };
  const compute = (): TrustView => {
    if (!o.isHost()) return { allowed: true, needsConfirm: false, url: null };
    const s = o.getStatus();
    if (!s || s.state !== "ready" || !s.url) return { allowed: false, needsConfirm: false, url: s?.url || null };
    if (s.trust === "spawned") return { allowed: true, needsConfirm: false, url: s.url };
    if (confirmed === keyOf(s)) return { allowed: true, needsConfirm: false, url: s.url };
    return { allowed: false, needsConfirm: true, url: s.url };
  };
  const view = (): TrustView => {
    const n = compute();
    if (n.allowed !== cached.allowed || n.needsConfirm !== cached.needsConfirm || n.url !== cached.url) cached = n;
    return cached;
  };
  o.subscribeStatus?.(fire);
  return {
    allowed: () => view().allowed,
    view,
    confirm() {
      const s = o.getStatus();
      if (!o.isHost() || !s || s.state !== "ready" || s.trust === "spawned") return;
      confirmed = keyOf(s);
      fire();
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
