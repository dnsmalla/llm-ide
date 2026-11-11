// The desktop's Chat list is a local file store, while a phone/browser turn writes its "Phone chat" to the core's
// chat routes. Without a bridge those chats exist but are invisible on the desktop. This wrapper keeps the native
// store as the source for desktop chats and adds any core-only chats as read/write sessions over the same routes.
// Native ids always win, so an id collision can never redirect an existing desktop transcript.
import { HttpChatStore, type ChatStore, type ListHealth, type MessagePage, type SessionSummary } from "./store";
import type { CoreTransport } from "./transport";

export class CoreMirrorChatStore implements ChatStore {
  private readonly core: HttpChatStore;
  private coreIds = new Set<string>();

  constructor(private readonly native: ChatStore, transport: CoreTransport) {
    this.core = new HttpChatStore(transport);
  }

  listHealth(): ListHealth { return this.native.listHealth?.() ?? { unreadable: 0, unsupported: 0 }; }

  async listSessions(opts: { limit: number; offset: number }, signal?: AbortSignal): Promise<SessionSummary[]> {
    // Ask native for the whole prefix, then page the merged list. Passing the offset to native would page only
    // its own chats and make the merged offset wrong once a Core-only chat sorts above them.
    const native = await this.native.listSessions({ limit: Math.max(1, opts.offset + opts.limit), offset: 0 }, signal);
    let extra: SessionSummary[] = [];
    try {
      // One bounded page is enough for the picker; native pagination still owns "load more".
      extra = await this.core.listSessions({ limit: 200, offset: 0 }, signal);
    } catch {
      // The core may be restarting. Native chats must still list.
      extra = [];
    }
    this.coreIds = new Set(extra.map((s) => s.id).filter((id) => !native.some((n) => n.id === id)));
    const merged = [...native, ...extra.filter((s) => this.coreIds.has(s.id))]
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    return merged.slice(opts.offset, opts.offset + Math.max(1, opts.limit));
  }

  createSession(opts: { title?: string; projectId?: string | null; mode?: string }, signal?: AbortSignal): Promise<SessionSummary> {
    return this.native.createSession(opts, signal);
  }

  renameSession(id: string, title: string, signal?: AbortSignal): Promise<void> {
    return this.coreIds.has(id) ? this.core.renameSession(id, title, signal) : this.native.renameSession(id, title, signal);
  }

  deleteSession(id: string, signal?: AbortSignal): Promise<void> {
    return this.coreIds.has(id) ? this.core.deleteSession(id, signal) : this.native.deleteSession(id, signal);
  }

  loadMessages(id: string, opts: { limit: number; beforeSeq?: number }, signal?: AbortSignal): Promise<MessagePage> {
    return this.coreIds.has(id) ? this.core.loadMessages(id, opts, signal) : this.native.loadMessages(id, opts, signal);
  }

  appendMessage(id: string, msg: { role: "user" | "assistant"; content: string; meta?: Record<string, unknown> | null }, signal?: AbortSignal): Promise<void> {
    return this.coreIds.has(id) ? this.core.appendMessage(id, msg, signal) : this.native.appendMessage(id, msg, signal);
  }

  dropInterruptedMessage(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.coreIds.has(id) ? this.core.dropInterruptedMessage(id, signal) : this.native.dropInterruptedMessage(id, signal);
  }
}
