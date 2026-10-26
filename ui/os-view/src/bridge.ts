// The native bridge contract shared with the Mac app (WKWebView) and, later, the
// desktop app. Keep this file the only place that knows the message names.
//
//   page -> native   window.webkit.messageHandlers.llmide.postMessage(msg)
//     { type: 'ready' }                   on load
//     { type: 'needToken' }               a request answered 401
//     { type: 'open', target }            navigate: loop | autoTasks | settings | library
//   native -> page   window.llmideConfigure({ baseURL, token, theme, projectName })
//     may be called again later (token refresh, theme change); each call applies.

export const THEMES = ['dark', 'light', 'midnight'] as const;
export type ThemeId = (typeof THEMES)[number];

export type ViewTarget = 'loop' | 'autoTasks' | 'settings' | 'library';

export type ToNative =
  | { type: 'ready' }
  | { type: 'needToken' }
  | { type: 'open'; target: ViewTarget };

export type NativeConfig = {
  baseURL: string;
  token: string;
  theme?: string;
  projectName?: string | null;
};

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
