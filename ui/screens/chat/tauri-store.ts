// TauriChatStore: the desktop app's ChatStore over the host's chat commands (chat_list / chat_load / chat_save /
// chat_delete, desktop/src-tauri/src/chat_cmds.rs). A chat is one file in the Mac app's own format, so this is the
// same transcript the Mac app reads; the core keeps only working state (docs/how-to/desktop-chat-store.md).
//
// Contract with the quit-archive protocol: the file is the final transcript, so the UI never keeps the only copy
// in memory. The controller persists the user message when a turn starts and the reply when it ends; each call
// here writes through (`chat_save` append) before resolving, serialised per chat so appends cannot interleave.
//
// Mapping: a stored message's `seq` is its 1-based index in the file; ids are upper-case UUIDs; the file's
// timestamps are Apple reference-date seconds (we convert to epoch seconds, as SessionSummary uses).
import { CoreHttpError } from "./transport";
import type { ChatStore, ListHealth, MessagePage, SessionSummary, StoredMessage } from "./store";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Seconds between 1970-01-01 and the 2001-01-01 reference date. */
export const APPLE_EPOCH_OFFSET = 978_307_200;
const toEpoch = (apple: number): number => apple + APPLE_EPOCH_OFFSET;
const toApple = (epochMs: number): number => epochMs / 1000 - APPLE_EPOCH_OFFSET;

interface HostSummary {
  id: string;
  title: string;
  scope?: string | null;
  projectId?: string | null;
  createdAt: number;
  lastUsedAt: number;
  engine?: string | null;
}
interface HostLoaded {
  session: { messages?: unknown[]; [k: string]: unknown };
  total: number;
  start: number;
  revision: string;
}
interface HostSaved {
  revision: string;
  messageCount: number;
}

interface Tracked {
  count: number;
  revision: string;
  /** The stored header fields an append must echo (the host validates them and an append overwrites them). */
  scope: string;
  title: string;
}

const headerOf = (session: Record<string, unknown>): { scope: string; title: string } => ({
  scope: typeof session.scope === "string" ? session.scope : "explorer",
  title: typeof session.title === "string" ? session.title : "Chat",
});

/** Host errors arrive as `{ code, message }` (StoreError) or a string; map them to the shapes the UI already handles. */
export function toStoreError(e: unknown): CoreHttpError {
  if (e instanceof CoreHttpError) return e;
  const code = e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "io";
  const status = code === "not_found" || code === "deleted" ? 404 : code === "conflict" ? 409 : code === "invalid" ? 400 : code === "too_large" ? 413 : code === "not_bound" || code === "core_unavailable" ? 503 : 500;
  // The host's message never contains chat content, but the UI maps by code anyway.
  let message = e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : code;
  if (code === "pending_corrupt") message = PENDING_CORRUPT_NOTICE;
  if (code === "declined") message = "Cancelled";
  return new CoreHttpError(status, code.toUpperCase(), message);
}

/** Shown (as a notice, not an alarm) when the host's delete bookkeeping file needs a person to look at it. */
export const PENDING_CORRUPT_NOTICE = "Delete bookkeeping needs attention: see core.log / Settings > Diagnostics";

/** The user said no in a native confirm: a clean cancel, not an error. Never retried automatically. */
export function isDeclined(e: unknown): boolean {
  return e instanceof CoreHttpError && e.code === "DECLINED";
}

/** Notice kind for a store error the UI shows as information rather than a failure. */
export function isPendingCorrupt(e: unknown): boolean {
  return e instanceof CoreHttpError && e.code === "PENDING_CORRUPT";
}

/** The host refuses a Replace that drops more than half of a chat of more than 4 messages without a confirm token. */
export function needsTruncateConfirm(oldCount: number, newCount: number): boolean {
  return oldCount > 4 && newCount * 2 < oldCount;
}

export function unreadableNotice(h: ListHealth): string | null {
  const parts: string[] = [];
  if (h.unreadable > 0) parts.push(`${h.unreadable} ${h.unreadable === 1 ? "chat" : "chats"} could not be read (not touched)`);
  if (h.unsupported > 0) parts.push(`${h.unsupported} ${h.unsupported === 1 ? "chat uses" : "chats use"} a format this version does not read (not touched)`);
  return parts.length ? parts.join(". ") : null;
}

function newChatId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().toUpperCase();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** A file message -> StoredMessage (`seq` = index + 1). Unknown roles (`toolResult`) become `system` and are not shown. */
export function fromFileMessage(m: unknown, index: number): StoredMessage {
  const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
  const role = o.role === "user" || o.role === "assistant" ? o.role : "system";
  return { seq: index + 1, role, content: asString(o.content), meta: null, createdAt: typeof o.createdAt === "number" ? toEpoch(o.createdAt) : 0 };
}

/** A new message in the Mac `ChatMessage` shape (extra keys are kept verbatim by the host and ignored by the Mac). */
export function toFileMessage(msg: { role: "user" | "assistant"; content: string; meta?: Record<string, unknown> | null }, nowMs: number): Record<string, unknown> {
  const stopped = msg.meta?.status === "aborted";
  return { id: newChatId(), role: msg.role, content: msg.content, status: stopped ? "stopped" : "done", toolSteps: [], createdAt: toApple(nowMs) };
}

export interface TauriChatStoreOptions {
  invoke: Invoke;
  /** Resolves once the host has bound the session (`chatBinding.whenBound`). */
  ready: () => Promise<void>;
  now?: () => number;
}

export class TauriChatStore implements ChatStore {
  private readonly tracked = new Map<string, Tracked>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private health: ListHealth = { unreadable: 0, unsupported: 0 };
  constructor(private readonly o: TauriChatStoreOptions) {
    this.now = o.now ?? Date.now;
  }

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      await this.o.ready();
      return await this.o.invoke<T>(command, args);
    } catch (e) {
      throw toStoreError(e);
    }
  }

  /** Runs `fn` after the previous operation on the same chat: appends and renames never interleave. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return run;
  }

  listHealth(): ListHealth {
    return { ...this.health };
  }

  async listSessions(opts: { limit: number; offset: number }, signal?: AbortSignal): Promise<SessionSummary[]> {
    if (signal?.aborted) return [];
    const page = await this.call<{ items?: HostSummary[]; unreadable?: number; unsupported?: number }>("chat_list", { args: { offset: Math.max(0, opts.offset), limit: Math.max(1, opts.limit) } });
    if (!Array.isArray(page?.items)) throw new CoreHttpError(502, "BAD_RESPONSE", "Unexpected chat list");
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    this.health = { unreadable: n(page.unreadable), unsupported: n(page.unsupported) };
    return page.items.map((s) => ({
      id: s.id,
      title: s.title,
      surface: s.scope ?? "any",
      mode: null,
      projectId: s.projectId ?? null,
      createdAt: toEpoch(s.createdAt),
      updatedAt: toEpoch(s.lastUsedAt),
    }));
  }

  async createSession(opts: { title?: string; projectId?: string | null; mode?: string }): Promise<SessionSummary> {
    const id = newChatId();
    const nowMs = this.now();
    const session: Record<string, unknown> = {
      storeVersion: 2,
      id,
      scope: "explorer",
      title: opts.title?.slice(0, 200) || "New chat",
      createdAt: toApple(nowMs),
      lastUsedAt: toApple(nowMs),
      messages: [],
      engine: "agentV2",
    };
    if (opts.projectId) session.projectId = opts.projectId;
    const out = await this.call<HostSaved>("chat_save", { args: { session } });
    this.tracked.set(id, { count: out.messageCount ?? 0, revision: out.revision, ...headerOf(session) });
    return { id, title: String(session.title), surface: "explorer", mode: opts.mode ?? null, projectId: opts.projectId ?? null, createdAt: nowMs / 1000, updatedAt: nowMs / 1000 };
  }

  /** Header-only update: an append of zero messages with the changed fields. */
  async renameSession(id: string, title: string): Promise<void> {
    await this.serial(id, async () => {
      await this.appendRaw(id, [], { title: title.slice(0, 200) });
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.serial(id, async () => {
      await this.call("chat_delete", { args: { id } });
      this.tracked.delete(id);
    });
  }

  /**
   * Replace the stored messages. A shrink of more than half of a chat of more than 4 messages asks the host for a
   * native confirm first and passes its one-time token. A declined confirm rejects with DECLINED (a clean cancel);
   * neither a decline nor a host refusal is retried here.
   */
  async replaceMessages(id: string, messages: Record<string, unknown>[]): Promise<void> {
    await this.serial(id, async () => {
      const t = this.tracked.get(id) ?? (await this.refresh(id));
      const args: Record<string, unknown> = { session: { id, scope: t.scope, title: t.title, messages }, mode: "replace", expectedRevision: t.revision };
      if (needsTruncateConfirm(t.count, messages.length)) {
        args.allowTruncate = await this.call<string>("chat_confirm_truncate", { args: { id, newCount: messages.length } });
      }
      const out = await this.call<HostSaved>("chat_save", { args });
      this.tracked.set(id, { ...t, count: out.messageCount, revision: out.revision });
    });
  }

  async loadMessages(id: string, opts: { limit: number; beforeSeq?: number }): Promise<MessagePage> {
    const args: Record<string, unknown> = { id, limit: Math.max(1, opts.limit) };
    // seq = index + 1, so "seq < beforeSeq" is "index < beforeSeq - 1".
    if (opts.beforeSeq !== undefined) args.before = Math.max(0, opts.beforeSeq - 1);
    const r = await this.call<HostLoaded>("chat_load", { args });
    const raw = r?.session?.messages;
    if (!Array.isArray(raw) || typeof r.start !== "number") throw new CoreHttpError(502, "BAD_RESPONSE", "Unexpected chat");
    // Track the newest state only (a page of older messages says nothing about the tail except `total`).
    this.tracked.set(id, { count: r.total, revision: r.revision, ...headerOf(r.session) });
    return { messages: raw.map((m, i) => fromFileMessage(m, r.start + i)), hasMore: r.start > 0 };
  }

  async appendMessage(id: string, msg: { role: "user" | "assistant"; content: string; meta?: Record<string, unknown> | null }): Promise<void> {
    await this.serial(id, () => this.appendRaw(id, [toFileMessage(msg, this.now())], {}));
  }

  /** Append with the expected count and revision; one retry after a conflict (re-read the file's state first). */
  private async appendRaw(id: string, messages: Record<string, unknown>[], header: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const t = this.tracked.get(id) ?? (await this.refresh(id));
      const session = { id, scope: t.scope, title: t.title, ...header, messages };
      try {
        const out = await this.call<HostSaved>("chat_save", { args: { session, mode: "append", expectedCount: t.count, expectedRevision: t.revision } });
        this.tracked.set(id, { ...t, ...(typeof header.title === "string" ? { title: header.title } : {}), count: out.messageCount, revision: out.revision });
        return;
      } catch (e) {
        const err = toStoreError(e);
        if (err.code === "CONFLICT" && attempt === 0) {
          this.tracked.delete(id);
          continue;
        }
        throw err;
      }
    }
  }

  /** Count and revision of the file now (a one-message load: the host pages, it never reads the whole chat into the UI). */
  private async refresh(id: string): Promise<Tracked> {
    const r = await this.call<HostLoaded>("chat_load", { args: { id, limit: 1 } });
    const t = { count: r.total, revision: r.revision, ...headerOf(r.session) };
    this.tracked.set(id, t);
    return t;
  }
}
