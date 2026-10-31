// ChatStore: where chat history lives, behind an interface. The live copy is the server DB
// (`/kb/chat/sessions/*`, plan section 4); the archive-to-disk side is S-D's (host commands) and is not
// reachable from here. Two implementations: HttpChatStore (the core's existing chat routes) and
// MemoryChatStore (tests, previews).
import { CoreHttpError, type CoreTransport } from "./transport";
import { textPartOf, type Message } from "./state";

export interface SessionSummary {
  id: string;
  title: string;
  surface: string;
  mode: string | null;
  projectId: string | null;
  /** Seconds since epoch (as the server sends them). */
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export interface MessagePage {
  messages: StoredMessage[];
  /** Messages older than the first returned one exist. */
  hasMore: boolean;
}

export interface ChatStore {
  listSessions(opts: { limit: number; offset: number }, signal?: AbortSignal): Promise<SessionSummary[]>;
  createSession(opts: { title?: string; projectId?: string | null; mode?: string }, signal?: AbortSignal): Promise<SessionSummary>;
  renameSession(id: string, title: string, signal?: AbortSignal): Promise<void>;
  /** Removes the chat everywhere the core keeps it. */
  deleteSession(id: string, signal?: AbortSignal): Promise<void>;
  /** The newest `limit` messages, or the `limit` messages just older than `beforeSeq`. */
  loadMessages(id: string, opts: { limit: number; beforeSeq?: number }, signal?: AbortSignal): Promise<MessagePage>;
  appendMessage(id: string, msg: { role: "user" | "assistant"; content: string; meta?: Record<string, unknown> | null }, signal?: AbortSignal): Promise<void>;
}

/** History row -> view message. Only user and assistant rows are shown; system rows are dropped. */
export function toMessages(rows: readonly StoredMessage[]): Message[] {
  const out: Message[] = [];
  for (const r of rows) {
    if (r.role === "user") out.push({ role: "user", id: `s${r.seq}`, seq: r.seq, text: r.content });
    else if (r.role === "assistant") out.push({ role: "assistant", id: `s${r.seq}`, seq: r.seq, parts: [textPartOf(r.content)], notices: [], status: "done" });
  }
  return out;
}

/** Server caps (extension/kb/chat-sessions.mjs): list 200 per call, a session read 2000 messages. */
export const SERVER_LIST_CAP = 200;
export const SERVER_MESSAGE_CAP = 2000;

export class HttpChatStore implements ChatStore {
  /** Highest seq seen per chat: the server has no `before` cursor, so older pages are a larger newest-N read. */
  private readonly newest = new Map<string, number>();
  constructor(private readonly core: CoreTransport) {}

  async listSessions(opts: { limit: number; offset: number }, signal?: AbortSignal): Promise<SessionSummary[]> {
    const q = `limit=${Math.min(opts.limit, SERVER_LIST_CAP)}&offset=${Math.max(0, opts.offset)}`;
    const res = await this.core.json<{ sessions?: SessionSummary[] }>("GET", `/kb/chat/sessions?${q}`, undefined, signal);
    if (!res || !Array.isArray(res.sessions)) throw new CoreHttpError(502, "BAD_RESPONSE", "Unexpected chat session list");
    return res.sessions;
  }

  async createSession(opts: { title?: string; projectId?: string | null; mode?: string }, signal?: AbortSignal): Promise<SessionSummary> {
    const res = await this.core.json<{ session?: SessionSummary }>("POST", "/kb/chat/sessions", { surface: "any", ...opts }, signal);
    if (!res?.session) throw new CoreHttpError(502, "BAD_RESPONSE", "Unexpected create answer");
    return res.session;
  }

  async renameSession(id: string, title: string, signal?: AbortSignal): Promise<void> {
    await this.core.json("PATCH", `/kb/chat/sessions/${encodeURIComponent(id)}`, { title }, signal);
  }

  async deleteSession(id: string, signal?: AbortSignal): Promise<void> {
    await this.core.json("DELETE", `/kb/chat/sessions/${encodeURIComponent(id)}`, undefined, signal);
    this.newest.delete(id);
  }

  async loadMessages(id: string, opts: { limit: number; beforeSeq?: number }, signal?: AbortSignal): Promise<MessagePage> {
    const newest = this.newest.get(id) ?? 0;
    const span = opts.beforeSeq === undefined ? 0 : Math.max(0, newest - opts.beforeSeq + 1);
    const fetchLimit = Math.min(SERVER_MESSAGE_CAP, opts.limit + span);
    const res = await this.core.json<{ session?: { messages?: StoredMessage[] } }>(
      "GET", `/kb/chat/sessions/${encodeURIComponent(id)}?limit=${fetchLimit}`, undefined, signal);
    const all = res?.session?.messages;
    if (!Array.isArray(all)) throw new CoreHttpError(502, "BAD_RESPONSE", "Unexpected chat session");
    if (all.length) this.newest.set(id, Math.max(newest, all[all.length - 1].seq));
    const older = opts.beforeSeq === undefined ? all : all.filter((m) => m.seq < opts.beforeSeq!);
    const page = older.slice(Math.max(0, older.length - opts.limit));
    // More exist when the read was full (the server may hold more) or rows older than the page are in hand.
    const hasMore = page.length > 0 && (older.length > page.length || (all.length >= fetchLimit && page[0].seq > 1));
    return { messages: page, hasMore };
  }

  async appendMessage(id: string, msg: { role: "user" | "assistant"; content: string; meta?: Record<string, unknown> | null }, signal?: AbortSignal): Promise<void> {
    const res = await this.core.json<{ seq?: number }>("POST", `/kb/chat/sessions/${encodeURIComponent(id)}/messages`, msg, signal);
    if (typeof res?.seq === "number") this.newest.set(id, Math.max(this.newest.get(id) ?? 0, res.seq));
  }
}

/** In-memory store: same contract, no network. */
export class MemoryChatStore implements ChatStore {
  private readonly sessions = new Map<string, SessionSummary>();
  private readonly messages = new Map<string, StoredMessage[]>();
  private clock = 1_700_000_000;
  private n = 0;

  seed(id: string, title: string, rows: Array<Pick<StoredMessage, "role" | "content">> = [], updatedAt?: number): void {
    const t = updatedAt ?? ++this.clock;
    this.sessions.set(id, { id, title, surface: "any", mode: null, projectId: null, createdAt: t, updatedAt: t });
    this.messages.set(id, rows.map((r, i) => ({ seq: i + 1, role: r.role, content: r.content, meta: null, createdAt: t })));
  }

  async listSessions(opts: { limit: number; offset: number }): Promise<SessionSummary[]> {
    const all = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    return all.slice(opts.offset, opts.offset + Math.min(opts.limit, SERVER_LIST_CAP));
  }
  async createSession(opts: { title?: string; projectId?: string | null; mode?: string }): Promise<SessionSummary> {
    const id = `mem-${++this.n}`;
    this.seed(id, opts.title ?? "New chat");
    return this.sessions.get(id)!;
  }
  private need(id: string): SessionSummary {
    const s = this.sessions.get(id);
    if (!s) throw new CoreHttpError(404, "NOT_FOUND", "session not found");
    return s;
  }
  async renameSession(id: string, title: string): Promise<void> { this.need(id).title = title; }
  async deleteSession(id: string): Promise<void> { this.need(id); this.sessions.delete(id); this.messages.delete(id); }
  async loadMessages(id: string, opts: { limit: number; beforeSeq?: number }): Promise<MessagePage> {
    this.need(id);
    const all = this.messages.get(id) ?? [];
    const older = opts.beforeSeq === undefined ? all : all.filter((m) => m.seq < opts.beforeSeq!);
    const page = older.slice(Math.max(0, older.length - opts.limit));
    return { messages: page, hasMore: older.length > page.length };
  }
  async appendMessage(id: string, msg: { role: "user" | "assistant"; content: string; meta?: Record<string, unknown> | null }): Promise<void> {
    const s = this.need(id);
    const rows = this.messages.get(id) ?? [];
    rows.push({ seq: rows.length + 1, role: msg.role, content: msg.content, meta: msg.meta ?? null, createdAt: ++this.clock });
    this.messages.set(id, rows);
    s.updatedAt = this.clock;
  }
}
