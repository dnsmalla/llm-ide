// Chat section entry: the shell lazy-loads this module (default export, SectionProps) and keeps it mounted
// while other sections are shown, so running turns and drafts survive section switches.
import "@llmide/ui-kit/styles.css";
import "./chat.css";
import { useEffect, useMemo, useRef } from "react";
import { core as shellCore, invokeHost } from "@llmide/screens/shell";
import type { SectionProps } from "@llmide/screens/shell";
import { coreTransportFrom } from "./adapter";
import { ChatScreen, type ChatHost } from "./ChatScreen";
import { ChatController } from "./controller";
import { HttpChatStore } from "./store";
import { safeHref } from "./markdown";

export { ChatScreen, type ChatHost, type ChatScreenProps } from "./ChatScreen";
export { ChatController, type ControllerDeps, type SendOptions, type ChatView } from "./controller";
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

const HOST: ChatHost = {
  openLink: (href) => void openLink(href),
  copy: (text) => { void navigator.clipboard?.writeText(text).catch(() => undefined); },
};

export default function ChatSection({ active, projectRoot }: SectionProps) {
  const root = useRef<string | null>(projectRoot);
  root.current = projectRoot;
  const transport = useMemo(() => coreTransportFrom(shellCore), []);
  const store = useMemo(() => new HttpChatStore(transport), [transport]);
  const controller = useMemo(() => new ChatController({ core: transport, store, workspaceRoot: () => root.current ?? "" }), [transport, store]);
  useEffect(() => { if (active) void controller.refreshRemoteBusy(); }, [active, controller]);
  return <ChatScreen controller={controller} store={store} core={transport} host={HOST} noProject={projectRoot === null} />;
}
