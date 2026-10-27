// The native bridge contract shared with the Mac app (WKWebView). Keep this file
// the only place that knows the message names.
//
// Inside the Mac app the page has NO network access of its own: the page's origin
// is file://, which the server refuses, and the access token never enters
// JavaScript. Every server call goes to native over the bridge; native makes it
// with its authenticated client and answers.
//
//   page -> native   window.webkit.messageHandlers.llmide.postMessage(msg)
//     { type: 'ready' }                              on load
//     { type: 'open', target }                       navigate: loop | autoTasks | settings | library
//                                                    | explorer | codeGraph (a target whose feature is off is ignored)
//     { type: 'openFile', path, line? }              show a repo file in Explorer (no reply; line is 1-based)
//     { type: 'request', id, method, path, body? }   one allowlisted server call (native SystemBridge)
//     { type: 'native', id, name }                   native-only data: projectGraph | routines
//                                                    (answered like a request; unknown name = 400 not_allowed)
//     { type: 'native', id, name: 'file', path }     one repo file's text for the code preview
//                                                    (200 {path,text,truncated,bytes,language} or
//                                                    200 {path,binary:true,bytes}; 404 not_found; 400 not_allowed)
//     { type: 'subscribe' } / { type: 'unsubscribe' } the change feed (GET /kb/os/stream) on or off
//   native -> page   window.llmideConfigure({ theme, projectName })
//     may be called again (theme or project change); each call applies.
//   native -> page   window.llmideResponse(id, { status, body?, error? })
//     the answer to one request. status 0 means the call never reached the server.
//   native -> page   window.llmideEvent({ type, at })
//     one change event from the feed; the page re-fetches (debounced). hello is ignored.
//   native -> page   window.llmideStatus({ status, detail? })
//     the feed's state: connecting | live | reconnecting | stopped.

export const THEMES = ['dark', 'light', 'midnight'] as const;
export type ThemeId = (typeof THEMES)[number];

export type ViewTarget = 'loop' | 'autoTasks' | 'settings' | 'library' | 'explorer' | 'codeGraph';

/** The native-only data sets the page can ask for. Each is answered by native, not by the server. */
export type NativeName = 'projectGraph' | 'routines';

/** A native call that carries a repo-relative file path: the text of one file for the code preview. */
export type NativeFileCall = { name: 'file'; path: string };

export type ToNative =
  | { type: 'ready' }
  | { type: 'open'; target: ViewTarget }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'request'; id: string; method: 'GET' | 'POST'; path: string; body?: Record<string, string> }
  | { type: 'native'; id: string; name: NativeName }
  | ({ type: 'native'; id: string } & NativeFileCall)
  | { type: 'subscribe' }
  | { type: 'unsubscribe' };

export type NativeConfig = {
  theme?: string;
  projectName?: string | null;
};

export type NativeReply = { status: number; body?: unknown; error?: string };

export type NativeEvent = { type: string; at?: string | null };

export type NativeFeedStatus = 'connecting' | 'live' | 'reconnecting' | 'stopped';

type MessageHandler = { postMessage(message: ToNative): void };
type BridgeGlobal = {
  webkit?: { messageHandlers?: { llmide?: MessageHandler } };
};

function handlerOf(scope: unknown): MessageHandler | undefined {
  return (scope as BridgeGlobal | undefined)?.webkit?.messageHandlers?.llmide;
}

/** True inside the Mac app's web view (the llmide message handler exists). */
export function hasNativeBridge(scope: unknown = globalThis): boolean {
  return handlerOf(scope) !== undefined;
}

/** Posts to native. Returns false when there is no bridge (plain browser). */
export function postToNative(message: ToNative, scope: unknown = globalThis): boolean {
  const handler = handlerOf(scope);
  if (!handler) return false;
  handler.postMessage(message);
  return true;
}

/** Sets data-theme on <html>. Unknown or missing themes fall back to dark. */
export function applyTheme(theme: string | undefined, root: HTMLElement): ThemeId {
  const id: ThemeId = (THEMES as readonly string[]).includes(theme ?? '') ? (theme as ThemeId) : 'dark';
  root.setAttribute('data-theme', id);
  return id;
}

// --- Request/response over the bridge ------------------------------------

/** How long a bridged request may wait for native before it fails. */
export const NATIVE_REQUEST_TIMEOUT_MS = 15_000;

type Pending = {
  resolve: (reply: NativeReply) => void;
  timer: unknown;
};

/**
 * The pending-promise map. Ids are unique per page load; a reply for an unknown
 * or already-settled id (a late answer after the timeout) is dropped.
 */
export class NativeRequests {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly post: (message: ToNative) => boolean,
    private readonly setTimer: (fn: () => void, ms: number) => unknown,
    private readonly clearTimer: (handle: unknown) => void,
  ) {}

  /** Sends one allowlisted call to native. Rejects on timeout or when there is no bridge. */
  call(method: 'GET' | 'POST', path: string, body?: Record<string, string>): Promise<NativeReply> {
    return this.dispatch((id) =>
      body === undefined ? { type: 'request', id, method, path } : { type: 'request', id, method, path, body },
    );
  }

  /** Asks native for one native-only data set. Rejects on timeout or when there is no bridge. */
  native(name: NativeName): Promise<NativeReply> {
    return this.dispatch((id) => ({ type: 'native', id, name }));
  }

  /** Asks native for the text of one repo file (the code preview). Rejects on timeout or when there is no bridge. */
  file(path: string): Promise<NativeReply> {
    return this.dispatch((id) => ({ type: 'native', id, name: 'file', path }));
  }

  private dispatch(build: (id: string) => ToNative): Promise<NativeReply> {
    const id = `r${this.nextId++}`;
    return new Promise<NativeReply>((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (this.pending.delete(id)) reject(new Error('LLM-IDE did not answer in time'));
      }, NATIVE_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      if (!this.post(build(id))) {
        this.clearTimer(timer);
        this.pending.delete(id);
        reject(new Error('The LLM-IDE bridge is not available'));
      }
    });
  }

  /** Called by native through window.llmideResponse. */
  settle(id: unknown, reply: unknown): void {
    if (typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.clearTimer(entry.timer);
    const r = (reply && typeof reply === 'object' ? reply : {}) as Partial<NativeReply>;
    entry.resolve({
      status: typeof r.status === 'number' ? r.status : 0,
      body: r.body,
      error: typeof r.error === 'string' ? r.error : undefined,
    });
  }

  get size(): number {
    return this.pending.size;
  }
}
