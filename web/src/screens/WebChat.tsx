import { useRef, useState, type ReactNode } from "react";
import { Chip, StatusBanner } from "@llmide/ui-kit";
import { Markdown } from "@llmide/screens/chat/MarkdownView.tsx";
import { Composer } from "@llmide/screens/chat/Composer.tsx";
import { QuestionCard } from "@llmide/screens/chat/approvals/QuestionCard.tsx";
import "@llmide/screens/chat/chat.css";
import "@llmide/screens/chat/approvals/approvals.css";
import { CERT_HINT, ORIGIN_HINT, UNOPENED_LIMIT, originText, trustUrl, type ConnectionState } from "../host-api/connection.ts";
import type { HostApiCapability } from "../host-api/types.generated.ts";
import type { ChatState, WebMessage } from "../chat/store.ts";
import { MAX_SEND_CHARS } from "../chat/controller.ts";
import type { ProjectsState } from "../projects/controller.ts";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";

export interface WebChatProps {
  /** Turn options rendered above the composer (ComposeBar); absent = none. */
  compose?: ReactNode;
  /** Start a fresh phone chat (capability compose); absent = no button. */
  onNewChat?: () => void;
  /** Offline sync is linked: the reconnecting banner offers a way back to the offline copy. */
  onOpenOffline?: () => void;
  hostName: string;
  /** The host address (wss://h:p/host-api/v1): the banner links its https:// twin to trust the certificate. */
  hostUrl?: string;
  /** This page's origin, shown so the user can add it on the desktop; defaults to the browser's. */
  pageOrigin?: string;
  connection: ConnectionState;
  capabilities: ReadonlySet<HostApiCapability>;
  state: ChatState;
  projects: ProjectsState;
  onSelectProject: (id: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onClear: () => void;
  onForget: () => void;
  /** Reconnect the paired desktop at a new wss address; resolves to an error text or null. Absent = no action. */
  onChangeAddress?: (url: string) => Promise<string | null>;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  onDecline: (requestId: string) => void;
  onTool: (requestId: string, decision: "allow_once" | "deny") => void;
}

const PAGE = 50;
const openLink = (href: string) => { if (/^https?:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer"); };

export const TOO_LONG = "Keep a message under 100,000 characters. Your text is kept so you can shorten it.";

// The shared Composer clears the draft right after onSend; an over-long send must keep it (the controller would refuse it unseen).
export function createDraftGuard(o: { send: (t: string) => void; setDraft: (t: string) => void; setError: (m: string | null) => void }) {
  let refused = false;
  return {
    onSend(text: string) {
      if (text.trim().length > MAX_SEND_CHARS) { refused = true; o.setError(TOO_LONG); return; }
      o.setError(null);
      o.send(text);
    },
    onDraft(text: string) {
      if (text === "" && refused) { refused = false; return; }
      refused = false;
      o.setDraft(text);
    },
  };
}

function chipLabel(c: ConnectionState) {
  if (c.kind === "ready") return "Connected";
  if (c.kind === "reconnecting") return `Reconnecting in ${Math.ceil(c.inMs / 1000)} s`;
  return "Offline";
}

function Message({ m, waiting }: { m: WebMessage; waiting: boolean }) {
  if (m.role === "user") return <li className="web-msg web-user">{m.text}</li>;
  const status = m.status === "streaming" ? (waiting ? "Waiting for the desktop…" : "…") : m.status === "cancelled" ? "Stopped." : m.error;
  return (
    <li className="web-msg web-assistant">
      {m.text && <Markdown text={m.text} onOpenLink={openLink} />}
      {m.truncated && <p className="chat-muted">The start of this reply was trimmed while reconnecting.</p>}
      {status && <p className="chat-muted">{status}</p>}
    </li>
  );
}

function ChangeAddress({ onSubmit }: { onSubmit: (url: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="web-chat-action" onClick={() => setOpen(true)}>Change address</button>;
  const submit = async () => {
    setBusy(true); setError(null);
    const err = await onSubmit(url);
    setBusy(false);
    if (err) setError(err); else setOpen(false);
  };
  return (
    <form className="web-unopened" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label>New address <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://host:port/host-api/v1" disabled={busy} /></label>
      <span className="web-chat-eyebrow">Kept signed in only if the desktop there is the same one; otherwise you pair again with a PIN.</span>
      {error && <StatusBanner severity="error" message={error} />}
      <button type="submit" className="web-chat-action" disabled={busy || !url.trim()}>{busy ? "Connecting…" : "Connect"}</button>
      <button type="button" className="web-chat-action web-chat-action-muted" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
    </form>
  );
}

export function WebChat(p: WebChatProps) {
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [sendError, setSendError] = useState<string | null>(null);
  const guard = useRef<ReturnType<typeof createDraftGuard>>(null);
  const send = useRef(p.onSend);
  send.current = p.onSend;
  guard.current ??= createDraftGuard({ send: (t) => send.current(t), setDraft, setError: setSendError });
  const { state } = p;
  const msgs = state.messages;
  const visible = msgs.slice(Math.max(0, msgs.length - shown));
  const ready = p.connection.kind === "ready";
  const disabledReason = !ready ? "Not connected" : !p.capabilities.has("chat") ? "This host does not serve chat" : null;
  const questions = state.approvals.filter((a) => a.kind === "question");
  return (
    <main className="web-app web-chat-app">
      <header className="web-chat-bar">
        <div className="web-chat-identity">
          <span className="web-mark web-chat-mark" aria-hidden="true" />
          <div><span className="web-chat-eyebrow">Connected desktop</span><h1>{p.hostName}</h1></div>
        </div>
        <ProjectPicker state={p.projects} disabled={state.turn !== null} onSelect={p.onSelectProject} />
        <div className="web-chat-actions">
          {p.onNewChat && (<button type="button" className="web-chat-action" onClick={p.onNewChat} disabled={disabledReason !== null || state.turn !== null} title={disabledReason ?? (state.turn ? "Wait for the reply to finish" : "Start a new phone chat; this one stays in the chat list")}>New chat</button>)}
          <Chip label={chipLabel(p.connection)} />
          <button type="button" className="web-chat-action" onClick={p.onClear} disabled={disabledReason !== null || state.turn !== null}
            title={disabledReason ?? (state.turn ? "Wait for the reply to finish" : undefined)}>Clear history</button>
          {p.onChangeAddress && <ChangeAddress onSubmit={p.onChangeAddress} />}
          <button type="button" className="web-chat-action web-chat-action-muted" onClick={p.onForget}>Forget this host</button>
        </div>
      </header>
      {state.notice && <StatusBanner severity="info" message={state.notice} />}
      {p.connection.kind === "reconnecting" && (p.connection.unopened >= UNOPENED_LIMIT ? (
        // The socket never opened several times in a row: the address, origin or certificate is wrong, not a blip.
        <div className="web-unopened">
          <StatusBanner severity="warning" message={`${ORIGIN_HINT} ${originText(p.pageOrigin ?? globalThis.location?.origin)} ${CERT_HINT}`.replace(/ {2,}/g, " ")} />
          {trustUrl(p.hostUrl) && <a className="web-chat-action" href={trustUrl(p.hostUrl) as string} target="_blank" rel="noopener noreferrer">Open the desktop's address to trust its certificate</a>}
          {p.onChangeAddress && <ChangeAddress onSubmit={p.onChangeAddress} />}
          <button type="button" className="web-chat-action" onClick={p.onForget}>Forget and re-enter the address</button>
        </div>
      ) : (
        <div className="web-unopened">
          <StatusBanner severity="info" message="The desktop isn't reachable yet — retrying." />
          {p.onOpenOffline && <button type="button" className="web-chat-action" onClick={p.onOpenOffline}>Open offline copy</button>}
        </div>
      ))}
      {p.connection.kind === "failed" && <StatusBanner severity="error" message={p.connection.message} />}
      {msgs.length > shown && <button type="button" onClick={() => setShown(shown + PAGE)}>Show older</button>}
      <p className="web-status" role="status" aria-live="polite">{state.turn ? (state.waiting ? "Waiting for the desktop…" : "The assistant is replying…") : ""}</p>
      <ul className="web-list">{visible.map((m) => <Message key={m.key} m={m} waiting={state.waiting} />)}</ul>
      {state.approvals.map((a) =>
        a.kind === "question" ? (
          <div key={a.requestId}>
            <QuestionCard
              approval={{ requestId: a.requestId, kind: "AskUserQuestion", questions: a.questions }}
              ui={{ phase: a.submitting ? "submitting" : "idle", error: a.error, shown: "", confirmingRule: false }}
              position={questions.indexOf(a) + 1} total={questions.length} turnClosed={false}
              onAnswer={(answers) => p.onAnswer(a.requestId, answers)} onDecline={() => p.onDecline(a.requestId)} />
            <p className="chat-muted">Declining stops the reply.</p>
          </div>
        ) : p.capabilities.has("tool_approvals") ? (
          <ToolApprovalCard key={a.requestId} approval={a} onDecide={(d) => p.onTool(a.requestId, d)} />
        ) : null)}
      {sendError && <p role="alert" className="web-error">{sendError}</p>}
      {p.compose}
      <Composer draft={draft} onDraft={(t) => guard.current!.onDraft(t)} busy={state.turn !== null} aborting={false} queue={[]}
        history={msgs.filter((m) => m.role === "user").map((m) => m.text)}
        onSend={(t) => guard.current!.onSend(t)} onStop={p.onStop} onDropQueued={() => {}} disabledReason={disabledReason} />
    </main>
  );
}
