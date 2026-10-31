// Chat section entry: the shell lazy-loads this module (default export, SectionProps) and keeps it mounted
// while other sections are shown, so running turns and drafts survive section switches.
import "@llmide/ui-kit/styles.css";
import "./chat.css";
import "./approvals/approvals.css";
import "./slash/compose.css";
import type { SectionProps } from "@llmide/screens/shell";
import { ChatScreen } from "./ChatScreen";
import { useChatSurface } from "./surface";
import { NoProjectCard } from "../shell/NoProjectCard";

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

export { chatRuntime, useChatSurface, type ChatRuntime, type ChatSurface } from "./surface";
export { createChatUiStore, type ChatUiStore, type ChatUiState } from "./ui-state";

export default function ChatSection({ active, projectRoot }: SectionProps) {
  const { rt, host, approvals, banner } = useChatSurface(projectRoot, active);
  // No project: one clear card with the two paths instead of a disabled composer (the sessions list returns with a project).
  if (projectRoot === null) return <NoProjectCard what="chat" hint="Chats work inside a project: the assistant reads and edits the files of the open project." />;
  return <ChatScreen controller={rt.controller} store={rt.store} core={rt.transport} host={host} approvals={approvals} banner={banner} shared={rt.ui} noProject={false} />;
}
