// The Explorer's docked Code Assistant (Mac `ChatPanelView` in `ExplorerView`): the SAME chat as the Chat section
// (shared runtime, controller, store and UI state in `surface.tsx`), laid out for a narrow column beside the editor.
// The shell mounts this lazily through its chat-dock seam (`shell/chat-dock.tsx`); Explorer never imports Chat.
import "@llmide/ui-kit/styles.css";
import "./chat.css";
import "./approvals/approvals.css";
import "./slash/compose.css";
import type { ChatDockProps } from "@llmide/screens/shell";
import { ChatScreen } from "./ChatScreen";
import { useChatSurface } from "./surface";

export default function ChatDock({ active, projectRoot, onCollapse }: ChatDockProps) {
  const { rt, host, approvals, banner } = useChatSurface(projectRoot, active);
  if (projectRoot === null) return <p className="chat-muted chat-pad" role="status">Open a project to use the Code Assistant.</p>;
  return <ChatScreen dock onCollapse={onCollapse} controller={rt.controller} store={rt.store} core={rt.transport} host={host} approvals={approvals} banner={banner} shared={rt.ui} noProject={false} />;
}
