// Chat section entry: the shell lazy-loads this module (default export, SectionProps) and keeps it mounted
// while other sections are shown, so running turns and drafts survive section switches.
import "@llmide/ui-kit/styles.css";
import "./chat.css";
import { useEffect, useMemo, useRef } from "react";
import { chatBinding, core as shellCore, host as shellHost, invokeHost, relativeToProject, shellBus } from "@llmide/screens/shell";
import type { SectionProps } from "@llmide/screens/shell";
import { coreTransportFrom } from "./adapter";
import { ChatScreen, type ChatHost } from "./ChatScreen";
import { ChatController } from "./controller";
import { HttpChatStore, type ChatStore } from "./store";
import { TauriChatStore } from "./tauri-store";
import { safeHref } from "./markdown";

export { ChatScreen, type ChatHost, type ChatScreenProps } from "./ChatScreen";
export { ChatController, type ControllerDeps, type SendOptions, type ChatView } from "./controller";
export { TauriChatStore } from "./tauri-store";
export { HttpChatStore, MemoryChatStore, toMessages, type ChatStore, type SessionSummary, type StoredMessage } from "./store";
export { CoreHttpError, describeError, type CoreTransport } from "./transport";
export { coreTransportFrom } from "./adapter";
export { decodeEvent, decodePayload, SseFramer, type AgentEvent, type DecodeResult } from "./events";
export { reduce, initialState, type ChatState, type Message, type Action } from "./state";
export { safeHref, parseBlocks, parseInline } from "./markdown";
export { Markdown } from "./MarkdownView";

/** Opens an allowlisted URL. The host command is not in the Rust host yet (blocked-by, see the checklist): until it
 *  lands the desktop app ignores the click rather than navigating the webview; a plain browser opens a new tab. */
async function openLink(href: string): Promise<void> {
  const safe = safeHref(href);
  if (!safe) return;
  try {
    await invokeHost("open_external_url", { url: safe });
  } catch {
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) window.open(safe, "_blank", "noopener,noreferrer");
  }
}

const BASE_HOST = {
  openLink: (href: string) => void openLink(href),
  copy: (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); },
};

export default function ChatSection({ active, projectRoot }: SectionProps) {
  const root = useRef<string | null>(projectRoot);
  root.current = projectRoot;
  const transport = useMemo(() => coreTransportFrom(shellCore), []);
  // Capability choice: inside the desktop app the chat file store (Mac format, live-then-archive) is the one copy;
  // in a plain browser (vite dev, the extension) the core's own chat routes are.
  const store = useMemo<ChatStore>(
    () => (shellHost.isAvailable() ? new TauriChatStore({ invoke: invokeHost, ready: () => chatBinding.whenBound() }) : new HttpChatStore(transport)),
    [transport],
  );
  const controller = useMemo(() => new ChatController({ core: transport, store, workspaceRoot: () => root.current ?? "" }), [transport, store]);
  useEffect(() => { if (active) void controller.refreshRemoteBusy(); }, [active, controller]);
  // "Open in Explorer": paths named by tool calls, only when they are inside the open project.
  const host = useMemo<ChatHost>(
    () => ({
      ...BASE_HOST,
      // Bypass needs a native, default-Cancel confirmation (host command `bypass_confirm`); without the host it fails closed.
      ...(shellHost.isAvailable()
        ? { confirmBypass: () => invokeHost<boolean>("bypass_confirm", { summary: "Bypass lets the assistant run tools without asking first." }).then((ok) => ok === true, () => false) }
        : {}),
      files: {
        resolve: (raw) => relativeToProject(raw, root.current),
        open: (rel) => shellBus.publish({ type: "open-file", path: rel }),
      },
    }),
    [],
  );
  return <ChatScreen controller={controller} store={store} core={transport} host={host} noProject={projectRoot === null} />;
}
