// Bypass approval, client side. The desktop host shows a native Cancel-first dialog (`bypass_confirm_signed`) and
// returns a single-use 60 s token; the core refuses a Bypass turn without it (403 HOST_APPROVAL_REQUIRED) and keeps a
// 30 minute per-user+chat grant once a valid token was accepted. This module holds the token in MEMORY ONLY (a closure
// field: never storage, a log line, the DOM, a URL or a snapshot), hands it out exactly once, and tracks the grant so
// later messages do not prompt again. Nothing here retries a Bypass turn.
export const GRANT_TTL_MS = 30 * 60 * 1000;
export const APPROVAL_HEADER = "x-llmide-host-approval";
export const BYPASS_NEEDS_APPROVAL_NOTICE = "Bypass needs your approval again. The chat is back on Ask.";

/** Asks the host for a token bound to `chatId` (format v2, purpose `bypass:<chatId>`); null when the user declined. */
export type SignedConfirm = (chatId: string, summary: string) => Promise<string | null>;

export interface BypassGate {
  /** Native confirmation for this chat. "approved" means a token is now held for the next turn; a decline changes nothing. */
  request(chatId: string, summary: string): Promise<"approved" | "declined">;
  /**
   * What a turn of this chat may carry. A requested Bypass becomes: the one-time header (token taken and dropped), plain
   * Bypass while the grant is live, otherwise Ask. `allowToken: false` (queued messages) never takes a waiting token.
   * Any other mode ends the chat's grant (the core does the same).
   */
  prepare(chatId: string, requested: string | null | undefined, opts?: { allowToken?: boolean }): { permissionMode: string | null; headers?: Record<string, string> };
  /** True while Bypass is approved for the chat: a token waits for the next turn, or the grant has not run out. */
  live(chatId: string): boolean;
  /** The core refused a Bypass turn: the grant is over. */
  rejected(chatId: string): void;
  end(chatId: string): void;
  endAll(): void;
  /** Milliseconds until the chat's grant is believed to end (null when none), so the UI can re-render at that time. */
  msLeft(chatId: string): number | null;
  subscribe(listener: () => void): () => void;
}

interface Entry { token: string | null; until: number | null }

// The host's token shape (v2, chat-bound); anything else, v1 included, is dropped unseen (a compromised host reply must
// not reach a header).
const TOKEN = /^v2\.\d{1,16}\.[0-9a-f]{32}\.[0-9a-f]{64}$/;

export function createBypassGate(o: { confirmSigned: SignedConfirm; now?: () => number }): BypassGate {
  const now = o.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const fire = () => { for (const l of [...listeners]) l(); };
  const liveEntry = (id: string): Entry | null => {
    const e = entries.get(id);
    if (!e) return null;
    if (e.token) return e;
    if (e.until !== null && now() < e.until) return e;
    entries.delete(id);
    return null;
  };
  return {
    async request(chatId, summary) {
      if (liveEntry(chatId)) return "approved"; // already approved: no second dialog
      let token: string | null = null;
      try { token = await o.confirmSigned(chatId, summary); } catch { token = null; }
      if (typeof token !== "string" || !TOKEN.test(token)) return "declined";
      entries.set(chatId, { token, until: null });
      fire();
      return "approved";
    },
    prepare(chatId, requested, opts) {
      if (requested !== "bypass") {
        if (entries.delete(chatId)) fire();
        return { permissionMode: requested ?? null };
      }
      const e = liveEntry(chatId);
      if (!e) return { permissionMode: "ask" };
      if (e.token && opts?.allowToken === false) return { permissionMode: "ask" };
      if (e.token) {
        const token = e.token;
        e.token = null; // single use
        e.until = now() + GRANT_TTL_MS; // never later than the core's own 30 minutes (it starts when the token is verified)
        return { permissionMode: "bypass", headers: { [APPROVAL_HEADER]: token } };
      }
      return { permissionMode: "bypass" };
    },
    live: (chatId) => liveEntry(chatId) !== null,
    rejected(chatId) { if (entries.delete(chatId)) fire(); },
    end(chatId) { if (entries.delete(chatId)) fire(); },
    endAll() { if (entries.size > 0) { entries.clear(); fire(); } },
    msLeft(chatId) { const e = liveEntry(chatId); return e && e.until !== null ? Math.max(0, e.until - now()) : null; },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}

/** Fixed template for the native dialog's quoted detail: chat title and project folder only, stripped and capped. */
export function bypassSummary(title: string | null | undefined, projectRoot: string | null | undefined): string {
  const clean = (s: string, max: number) => {
    // eslint-disable-next-line no-control-regex
    const t = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const folder = projectRoot ? clean(projectRoot.split(/[\\/]/).filter(Boolean).slice(-2).join("/"), 60) : "";
  return `Chat "${clean(title ?? "", 60) || "Untitled chat"}" in ${folder || "no project"}`;
}
