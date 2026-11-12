// The Execute section: a second chat, separate from Ask, on the desktop's "execute" surface. The desktop edits the project and asks
// before each file edit or command; the approval cards are the same as Ask's.
import { EmptyState, Button, Card, Banner } from "../ui/index.ts";
import { EXECUTE_UNAVAILABLE, executeAvailability } from "../chat/execute.ts";
import type { SectionProps } from "../shell/registry.ts";
import { ComposeBar } from "./ComposeBar.tsx";
import { WebChat } from "./WebChat.tsx";

/** One chat turn per connection on the desktop: while the other surface replies, this composer is off and says why. */
export function OtherTurnHint({ text, label, onOpen }: { text: string; label: string; onOpen: () => void }) {
  return <Banner tone="info" action={<Button size="sm" variant="secondary" onClick={onOpen}>{label}</Button>}>{text}</Banner>;
}

export function ExecuteSection({ ctx }: SectionProps) {
  const { execute: ex, capabilities: caps, conn } = ctx;
  const a = ex ? executeAvailability(caps, ex.compose) : { ok: false as const, reason: "no_grant" as const };
  if (!ex || !a.ok) {
    const why = EXECUTE_UNAVAILABLE[a.ok ? "no_grant" : a.reason];
    const retry = !a.ok && a.reason === "load_failed" && ex?.actions.reload;
    return (
      <div className="web-page web-page-center">
        <Card>
          <EmptyState icon="terminal" title={why.title} action={retry ? <Button variant="secondary" onClick={retry}>Retry</Button> : <Button variant="secondary" onClick={() => ctx.navigate("ask")}>Back to Ask</Button>}>{why.text}</EmptyState>
        </Card>
      </div>
    );
  }
  const x = ex.actions;
  const askBusy = ctx.chat.turn !== null;
  return (
    <WebChat variant="execute" hostName={ctx.hostName} hostUrl={ctx.hostUrl} pageOrigin={ctx.pageOrigin} connection={conn} capabilities={caps} state={ex.chat}
      onSend={x.send} onStop={x.stop} onClear={x.deleteChat} onForget={ctx.actions.forget} onChangeAddress={ctx.actions.changeAddress} onOpenOffline={ctx.actions.openOffline}
      onAnswer={x.answerQuestion} onDecline={x.declineQuestion} onTool={x.answerTool} onNewChat={x.newChat}
      compose={(
        <>
          {askBusy && ex.chat.turn === null ? <OtherTurnHint text="Ask is replying…" label="Go to Ask" onOpen={() => ctx.navigate("ask")} /> : null}
          <ComposeBar state={ex.compose} canChoose fixedMode="execute" disabled={conn.kind !== "ready" || ex.chat.turn !== null || askBusy}
            onMode={() => undefined} onModel={x.setModel} onRemove={x.removeAttachment} onFiles={x.addFiles} />
        </>
      )} />
  );
}
