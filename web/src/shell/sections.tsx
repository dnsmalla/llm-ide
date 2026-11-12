// The built-in sections. Register more from anywhere that runs before first render (see registry.ts).
import { Card, EmptyState, Button } from "../ui/index.ts";
import { ReadPanel } from "../screens/ReadPanel.tsx";
import { SettingsScreen } from "../screens/SettingsScreen.tsx";
import { ComposeBar } from "../screens/ComposeBar.tsx";
import { WebChat } from "../screens/WebChat.tsx";
import { ExecuteSection } from "../screens/ExecuteScreen.tsx";
import { TasksSection } from "../screens/TasksSection.tsx";
import { LoopSection } from "../screens/LoopSection.tsx";
import { registerSection, type SectionProps, type ShellContext } from "./registry.ts";

function AskSection({ ctx }: SectionProps) {
  const { actions: a, capabilities: caps, conn, chat, compose } = ctx;
  const canCompose = caps.has("compose");
  return (
    <WebChat hostName={ctx.hostName} hostUrl={ctx.hostUrl} pageOrigin={ctx.pageOrigin} connection={conn} capabilities={caps} state={chat}
      onSend={a.send} onStop={a.stop} onClear={a.clearHistory} onForget={a.forget} onChangeAddress={a.changeAddress} onOpenOffline={a.openOffline}
      onAnswer={a.answerQuestion} onDecline={a.declineQuestion} onTool={a.answerTool} onNewChat={canCompose ? a.newChat : undefined}
      compose={caps.has("chat") ? (
        <ComposeBar state={compose} canChoose={canCompose} disabled={conn.kind !== "ready" || chat.turn !== null}
          onMode={a.setMode} onModel={a.setModel} onRemove={a.removeAttachment} onFiles={a.addFiles} />
      ) : null} />
  );
}

function HistorySection({ ctx }: SectionProps) {
  const { actions: a } = ctx;
  return (
    <div className="web-page">
      <ReadPanel capabilities={ctx.capabilities} state={ctx.read} onOpen={a.readOpen} onOlder={a.readOlder} onClose={a.readClose} onMore={a.readMore} />
    </div>
  );
}

/** A "coming next" page that keeps the nav honest until the screen is registered for real. */
export function ComingNext({ icon, title, children, ctx }: { icon: Parameters<typeof EmptyState>[0]["icon"]; title: string; children: string; ctx?: ShellContext }) {
  return (
    <div className="web-page web-page-center">
      <Card>
        <EmptyState icon={icon} title={title}
          action={ctx ? <Button variant="secondary" onClick={() => ctx.navigate("ask")}>Back to Ask</Button> : undefined}>{children}</EmptyState>
      </Card>
    </div>
  );
}

registerSection({ id: "ask", label: "Ask", icon: "message-square", requires: ["chat"], order: 10, keepAlive: true, layout: "fill", component: AskSection });
registerSection({ id: "execute", label: "Execute", icon: "terminal", requires: ["chat", "compose"], order: 20, keepAlive: true, layout: "fill", component: ExecuteSection });
registerSection({ id: "tasks", label: "Auto Tasks", shortLabel: "Tasks", icon: "list-checks", requires: ["read"], order: 30, component: TasksSection });
registerSection({ id: "loop", label: "Loop", icon: "repeat", requires: ["read"], order: 40, component: LoopSection });
registerSection({ id: "history", label: "History", icon: "rotate-ccw-clock", requires: ["read"], order: 50, component: HistorySection });
registerSection({ id: "settings", label: "Settings", icon: "sliders-horizontal", order: 90, component: SettingsScreen });
