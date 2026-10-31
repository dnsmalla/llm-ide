// ChatController: one runtime per chat, independent of which chat is on screen. Switching chats never
// touches a running turn (the "background sessions" rule: one live engine per session). The server holds
// the same rule (one turn per user+chat, 409 TURN_IN_PROGRESS). A turn's stream keeps being read and reduced
// here while another chat is displayed.
//
// Not possible yet (blocked by the core, see the parity checklist): re-attaching to a turn after a webview
// reload. The core has no replay route for a running stream, so `refreshRemoteBusy` can only tell the user a
// turn is running on the core; its output is lost to this client.
import { decodePayload, type AgentEvent } from "./events";
import { initialState, reduce, assistantText, type Action, type AssistantMessage, type ChatState } from "./state";
import { toMessages, type ChatStore } from "./store";
import { describeError, httpLike, type CoreTransport } from "./transport";
import { cancelTurn } from "./route";
import { HISTORY_PAGE } from "./virtual";

export interface SendOptions {
  mode: string;
  model?: string | null;
  provider?: string | null;
  permissionMode?: "ask" | "accept-edits" | "bypass" | null;
  language?: string;
  /** Skills the composer selected (slash menu); passed through verbatim. */
  skills?: unknown;
  /** Resend from a fresh SDK session (after SESSION_UNRESUMABLE). */
  fresh?: boolean;
}

export interface ControllerDeps {
  core: CoreTransport;
  store: ChatStore;
  /** The project folder the turn runs in (the host's open project). Required by the server. */
  workspaceRoot: () => string;
  newId?: () => string;
  /** Test seam: wait `ms`. */
  sleep?: (ms: number) => Promise<void>;
  onPersistError?: (sessionId: string, err: unknown) => void;
  /** How long after Stop the UI waits for the stream to unwind before forcing idle. */
  abortGraceMs?: number;
}

/** Per-chat UI state kept out of the reducer: it never affects a turn. */
export interface ChatView { draft: string; scrollTop: number | null; stickToBottom: boolean }

interface Runtime {
  state: ChatState;
  view: ChatView;
  ac: AbortController | null;
  lastSend: { text: string; opts: SendOptions } | null;
  loaded: boolean;
  userAborted: boolean;
}

/** Micro-batching of stream events. */
export const BATCH_MS = 12;
export const BATCH_MAX = 64;
const RETRY_409_DELAYS = [400, 700, 1000, 1500];
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `t${Date.now()}${Math.random().toString(16).slice(2)}`);

export class ChatController {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<() => void>();
  private remoteBusy: ReadonlySet<string> = new Set();
  private version = 0;

  constructor(private readonly deps: ControllerDeps) {}

  // --- subscription (useSyncExternalStore shape) ---------------------------------------------
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  /** Changes on every state change anywhere; per-chat selectors compare their own state identity. */
  getVersion = (): number => this.version;
  private emit(): void { this.version++; for (const l of [...this.listeners]) l(); }

  // --- accessors -----------------------------------------------------------------------------
  private rt(id: string): Runtime {
    let r = this.runtimes.get(id);
    if (!r) {
      r = { state: initialState(id), view: { draft: "", scrollTop: null, stickToBottom: true }, ac: null, lastSend: null, loaded: false, userAborted: false };
      this.runtimes.set(id, r);
    }
    return r;
  }
  getState(id: string): ChatState { return this.rt(id).state; }
  getView(id: string): ChatView { return this.rt(id).view; }
  setView(id: string, patch: Partial<ChatView>): void { Object.assign(this.rt(id).view, patch); }
  /** Chats with a turn running here (not removed by switching). */
  busyIds(): string[] { return [...this.runtimes].filter(([, r]) => r.state.phase === "streaming" || r.state.phase === "aborting").map(([id]) => id); }
  isRemoteBusy(id: string): boolean { return this.remoteBusy.has(id) && !this.busyIds().includes(id); }

  private dispatch(id: string, action: Action): void {
    const r = this.rt(id);
    const next = reduce(r.state, action);
    if (next !== r.state) { r.state = next; this.emit(); }
  }

  // --- history -------------------------------------------------------------------------------
  /** Loads the newest page once; a running or already loaded chat is left alone. */
  async open(id: string, signal?: AbortSignal): Promise<void> {
    const r = this.rt(id);
    if (r.loaded || r.state.phase === "streaming") return;
    try {
      const page = await this.deps.store.loadMessages(id, { limit: HISTORY_PAGE }, signal);
      if (signal?.aborted) return;
      // A turn may have started while the page was loading: keep its messages after the history.
      const live = r.state.messages.filter((m) => m.seq === undefined);
      this.dispatch(id, { type: "load", messages: [...toMessages(page.messages), ...live], hasMoreOlder: page.hasMore });
      r.loaded = true;
    } catch (e) {
      if (signal?.aborted) return;
      const d = describeError(e);
      this.dispatch(id, { type: "transport_error", code: d.code, message: d.message, retryable: true });
    }
  }

  /** Pages older messages in (call near the top of the list). Returns how many were added. */
  async loadOlder(id: string, signal?: AbortSignal): Promise<number> {
    const r = this.rt(id);
    const s = r.state;
    if (!s.hasMoreOlder || s.oldestSeq === null) return 0;
    const page = await this.deps.store.loadMessages(id, { limit: HISTORY_PAGE, beforeSeq: s.oldestSeq }, signal);
    if (signal?.aborted) return 0;
    const msgs = toMessages(page.messages);
    this.dispatch(id, { type: "prepend", messages: msgs, hasMoreOlder: page.hasMore });
    return msgs.length;
  }

  /** Asks the core which chats have a turn running (cheap enough on chat open; see the file header). */
  async refreshRemoteBusy(signal?: AbortSignal): Promise<void> {
    try {
      const st = await this.deps.core.json<{ running?: { chatTurns?: Array<{ chatSessionId?: string }> } }>("GET", "/kb/os/state?activity=1", undefined, signal);
      this.remoteBusy = new Set((st.running?.chatTurns ?? []).map((t) => t.chatSessionId).filter((x): x is string => typeof x === "string"));
      this.emit();
    } catch { /* optional hint only */ }
  }

  /** Drops a chat's runtime (after delete or when closing an idle chat). A running chat is kept. */
  forget(id: string): boolean {
    const r = this.runtimes.get(id);
    if (!r || r.state.phase === "streaming" || r.state.phase === "aborting") return false;
    this.runtimes.delete(id);
    this.emit();
    return true;
  }

  // --- turns ---------------------------------------------------------------------------------
  /** Sends a message. While a turn runs it is queued and sent when the turn ends. */
  send(id: string, text: string, opts: SendOptions, isRetry = false): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const r = this.rt(id);
    const wasBusy = r.state.phase === "streaming" || r.state.phase === "aborting";
    this.dispatch(id, { type: "send", id: (this.deps.newId ?? defaultId)(), text: trimmed, replaceFailed: isRetry });
    if (wasBusy) { r.lastSend = { text: trimmed, opts }; return; }
    void this.runTurn(id, trimmed, opts, !isRetry);
  }

  /** Retries the last message of a failed turn (fresh SDK session when the error asks for it). */
  retry(id: string): void {
    const r = this.rt(id);
    if (!r.lastSend || r.state.phase !== "error") return;
    const { text, opts } = r.lastSend;
    const unresumable = r.state.error?.code === "SESSION_UNRESUMABLE";
    this.dispatch(id, { type: "clear_error" });
    this.send(id, text, { ...opts, fresh: unresumable || opts.fresh }, true);
  }

  clearError(id: string): void { this.dispatch(id, { type: "clear_error" }); }
  dropQueued(id: string, index: number): void { this.dispatch(id, { type: "drop_queued", index }); }

  abort(id: string): void {
    const r = this.rt(id);
    if (r.state.phase !== "streaming" || !r.ac) return;
    r.userAborted = true;
    this.dispatch(id, { type: "abort_requested" });
    const ac = r.ac;
    ac.abort();
    void cancelTurn(this.deps.core, id).catch(() => undefined); // frees the server lock; best effort
    // The stream normally rejects at once; this guarantees idle even if a transport swallows the abort.
    const grace = this.deps.abortGraceMs ?? 1500;
    void (this.deps.sleep ?? defaultSleep)(grace).then(() => {
      if (r.ac === ac && r.state.phase === "aborting") { r.ac = null; this.dispatch(id, { type: "aborted" }); this.afterTurn(id); }
    });
  }

  private async runTurn(id: string, text: string, opts: SendOptions, persistUser = true): Promise<void> {
    const r = this.rt(id);
    const ac = new AbortController();
    r.ac = ac; r.userAborted = false; r.lastSend = { text, opts };
    if (persistUser) this.persist(id, { role: "user", content: text, meta: { mode: opts.mode } });
    const body = {
      message: text, mode: opts.mode, language: opts.language, skills: opts.skills, fresh: opts.fresh === true ? true : undefined,
      ...(opts.model ? { model: opts.model } : {}), ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      agentContext: { chatSessionId: id, workspaceRoot: this.deps.workspaceRoot(), surface: "desktop" },
    };
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.readStream(id, body, ac);
          break;
        } catch (e) {
          // The previous turn of this chat may still be unwinding on the server (it answers 409 until it has).
          const h = httpLike(e);
          const busy = h?.status === 409 && h.code === "TURN_IN_PROGRESS";
          if (busy && attempt < RETRY_409_DELAYS.length && !ac.signal.aborted && r.state.applied === 0) {
            await (this.deps.sleep ?? defaultSleep)(RETRY_409_DELAYS[attempt]);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (r.ac !== ac) return; // already forced idle
      if (ac.signal.aborted || r.userAborted) this.dispatch(id, { type: "aborted" });
      else { const d = describeError(e); this.dispatch(id, { type: "transport_error", code: d.code, message: d.message, retryable: d.retryable }); }
    }
    if (r.ac !== ac) return;
    r.ac = null;
    this.afterTurn(id);
  }

  /**
   * Reads the stream. Events are micro-batched (one reducer pass per BATCH_MS or BATCH_MAX events, at once on a
   * terminal event) so a 10k-delta reply costs a few hundred passes, not 10k, and the UI renders per frame anyway.
   */
  private async readStream(id: string, body: unknown, ac: AbortController): Promise<void> {
    let pending: AgentEvent[] = [];
    let malformed = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending.length === 0 && malformed === 0) return;
      const events = pending, bad = malformed;
      pending = []; malformed = 0;
      this.dispatch(id, { type: "events", events, malformed: bad });
    };
    const terminal = () => { const ph = this.rt(id).state.phase; return ph === "idle" || ph === "error"; };
    try {
      for await (const payload of this.deps.core.stream("/agent/v2/stream", body, ac.signal)) {
        if (ac.signal.aborted) break;
        const d = decodePayload(payload);
        if (d.ok) pending.push(d.event);
        else if (d.reason === "malformed") malformed++; // unknown types are ignored silently
        if (d.ok && (d.event.type === "result" || d.event.type === "error") || pending.length >= BATCH_MAX) flush();
        else if (!timer) timer = setTimeout(flush, BATCH_MS);
        if (terminal()) return;
      }
    } finally {
      flush();
    }
    if (ac.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    this.dispatch(id, { type: "stream_end" });
  }

  /** After a turn ends: persist the reply, then send the next queued message. */
  private afterTurn(id: string): void {
    const r = this.rt(id);
    const last = [...r.state.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
    if (last && last.seq === undefined && (last.status === "done" || last.status === "aborted")) {
      const content = assistantText(last);
      if (content) this.persist(id, { role: "assistant", content, meta: { mode: r.state.resolvedMode, model: r.state.model, status: last.status } });
    }
    if (r.state.queue.length > 0 && r.state.phase === "idle" && r.lastSend) {
      const [next] = r.state.queue;
      this.dispatch(id, { type: "dequeue" });
      this.dispatch(id, { type: "send", id: (this.deps.newId ?? defaultId)(), text: next });
      void this.runTurn(id, next, r.lastSend.opts);
    }
  }

  private persist(id: string, msg: { role: "user" | "assistant"; content: string; meta?: Record<string, unknown> | null }): void {
    this.deps.store.appendMessage(id, msg).catch((e) => this.deps.onPersistError?.(id, e));
  }
}
