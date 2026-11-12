import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { Banner, Button, EmptyState, Sheet, UiIcon, growTextarea } from "../ui/index.ts";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { ChangeAddress } from "./ChangeAddress.tsx";

export const DELETE_CHAT_CONFIRM = "Delete on this browser and the desktop \u2014 the Ask chat is not affected.";
export const EXECUTE_EMPTY_TITLE = "Run a code change";
export const EXECUTE_EMPTY_TEXT = "Describe it; the desktop edits the project and reports back.";

/** The confirm before the Execute chat is deleted (on this browser and on the desktop). */
export function DeleteChatSheet({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Sheet open={open} onClose={onCancel} title="Delete this chat?"
      footer={<><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button variant="danger" icon="trash" onClick={onConfirm}>Delete</Button></>}>
      <p>{DELETE_CHAT_CONFIRM}</p>
    </Sheet>
  );
}

export interface WebChatProps {
  /** Which chat this is. "execute": the code-change chat (own empty state, "Delete this chat" behind a confirm sheet). Default "ask". */
  variant?: "ask" | "execute";
  /** Turn options rendered above the composer (ComposeBar); absent = none. */
  compose?: ReactNode;
  /** Start a fresh phone chat (capability compose); absent = no button. */
  onNewChat?: () => void;
  /** Offline sync is linked: the reconnecting banner offers a way back to the offline copy. */
  onOpenOffline?: () => void;
  /** The shell's header shows the desktop and the project picker; kept so callers need not change. */
  hostName?: string;
  /** The host address (wss://h:p/host-api/v1): the banner links its https:// twin to trust the certificate. */
  hostUrl?: string;
  /** This page's origin, shown so the user can add it on the desktop; defaults to the browser's. */
  pageOrigin?: string;
  connection: ConnectionState;
  capabilities: ReadonlySet<HostApiCapability>;
  state: ChatState;
  projects?: ProjectsState;
  onSelectProject?: (id: string) => void;
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
const NEAR_BOTTOM_PX = 96;
const openLink = (href: string) => { if (/^https?:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer"); };
const copyText = (text: string) => { void globalThis.navigator?.clipboard?.writeText(text).catch(() => undefined); };
export const EXAMPLE_PROMPTS = [
  "Summarize what changed in this project recently",
  "Explain how the main modules fit together",
  "Draft a plan for the next task and list its risks",
] as const;

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


function Message({ m, waiting }: { m: WebMessage; waiting: boolean }) {
  if (m.role === "user") return <li className="web-msg web-user">{m.text}</li>;
  const streaming = m.status === "streaming";
  const status = streaming ? (waiting ? "Waiting for the desktop…" : null) : m.status === "cancelled" ? "Stopped." : m.error;
  return (
    <li className="web-msg web-assistant" data-status={m.status}>
      {m.text && <Markdown text={m.text} onOpenLink={openLink} onCopy={copyText} />}
      {streaming && !waiting && <span className="web-typing" aria-hidden="true"><i /><i /><i /></span>}
      {m.truncated && <p className="chat-muted">The start of this reply was trimmed while reconnecting.</p>}
      {status && <p className="chat-muted">{status}</p>}
    </li>
  );
}

const useIsoLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function WebChat(p: WebChatProps) {
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [sendError, setSendError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const execute = p.variant === "execute";
  const guard = useRef<ReturnType<typeof createDraftGuard>>(null);
  const send = useRef(p.onSend);
  send.current = p.onSend;
  guard.current ??= createDraftGuard({ send: (t) => send.current(t), setDraft, setError: setSendError });
  const thread = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { state } = p;
  const msgs = state.messages;
  const visible = msgs.slice(Math.max(0, msgs.length - shown));
  const ready = p.connection.kind === "ready";
  const disabledReason = !ready ? "Not connected" : !p.capabilities.has("chat") ? "This host does not serve chat" : null;
  const questions = state.approvals.filter((a) => a.kind === "question");
  const busy = state.turn !== null;

  // Follow the reply while the reader is at the bottom; leave them alone once they scroll up.
  useIsoLayout(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, state.approvals.length, state.turn, state.waiting]);
  useEffect(() => {
    const el = thread.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    // A kept-alive tab shown again has a zero-size scroller until now: restore the bottom.
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useIsoLayout(() => {
    const ta = dock.current?.querySelector<HTMLTextAreaElement>("textarea.chat-textarea");
    if (ta) growTextarea(ta, 7);
  }, [draft]);
  const onScroll = () => {
    const el = thread.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stick.current = near;
    setAtBottom((was) => (was === near ? was : near));
  };
  const jump = () => {
    const el = thread.current;
    if (!el) return;
    stick.current = true; setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const pickExample = (text: string) => {
    setDraft(text);
    queueMicrotask(() => dock.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
  };
  const empty = msgs.length === 0 && !busy && state.approvals.length === 0;
  const chatBlocked = disabledReason !== null;

  return (
    <div className="web-chat">
      <div className="web-chat-bar">
        {p.onNewChat && (<Button size="sm" variant="ghost" onClick={p.onNewChat} disabled={chatBlocked || busy} title={disabledReason ?? (busy ? "Wait for the reply to finish" : execute ? "Start a fresh Execute chat" : "Start a new phone chat; this one stays in the chat list")}>New chat</Button>)}
        {execute
          ? <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)} disabled={chatBlocked || busy} title={disabledReason ?? (busy ? "Wait for the run to finish" : undefined)}>Delete this chat</Button>
          : <Button size="sm" variant="ghost" onClick={p.onClear} disabled={chatBlocked || busy} title={disabledReason ?? (busy ? "Wait for the reply to finish" : undefined)}>Clear history</Button>}
      </div>
      <div className="web-chat-banners">
        {state.notice && <Banner tone="info">{state.notice}</Banner>}
        {p.connection.kind === "reconnecting" && (p.connection.unopened >= UNOPENED_LIMIT ? (
          // The socket never opened several times in a row: the address, origin or certificate is wrong, not a blip.
          <Banner tone="warn" action={<>
            {trustUrl(p.hostUrl) && <a className="ui-btn" data-variant="secondary" data-size="sm" href={trustUrl(p.hostUrl) as string} target="_blank" rel="noopener noreferrer">Open the desktop's address to trust its certificate</a>}
            {p.onChangeAddress && <ChangeAddress onSubmit={p.onChangeAddress} />}
            <Button size="sm" variant="secondary" onClick={p.onForget}>Forget and re-enter the address</Button>
          </>}>{`${ORIGIN_HINT} ${originText(p.pageOrigin ?? globalThis.location?.origin)} ${CERT_HINT}`.replace(/ {2,}/g, " ")}</Banner>
        ) : (
          <Banner tone="info" action={p.onOpenOffline ? <Button size="sm" variant="secondary" onClick={p.onOpenOffline}>Open offline copy</Button> : undefined}>The desktop isn't reachable yet — retrying.</Banner>
        ))}
        {p.connection.kind === "failed" && <Banner tone="error">{p.connection.message}</Banner>}
      </div>
      <div className="web-thread" ref={thread} onScroll={onScroll} tabIndex={-1}>
        <div className="web-thread-inner">
          {msgs.length > shown && <Button size="sm" variant="secondary" onClick={() => setShown(shown + PAGE)}>Show older</Button>}
          {empty && execute && (
            <EmptyState icon="terminal" title={EXECUTE_EMPTY_TITLE}>{EXECUTE_EMPTY_TEXT}</EmptyState>
          )}
          {empty && !execute && (
            <EmptyState icon="message-square" title="Ask your desktop anything"
              action={<div className="web-examples" role="group" aria-label="Example prompts">{EXAMPLE_PROMPTS.map((t) => (
                <button key={t} type="button" className="web-example" disabled={chatBlocked} onClick={() => pickExample(t)}><span>{t}</span><UiIcon name="arrow-up" size={16} /></button>))}</div>}>
              Questions run on your own computer, in the project you picked. Try one of these, or type below.
            </EmptyState>
          )}
          <ul className="web-list">{visible.map((m) => <Message key={m.key} m={m} waiting={state.waiting} />)}</ul>
          {state.approvals.map((a) =>
            a.kind === "question" ? (
              <div key={a.requestId} className="web-approval">
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
        </div>
      </div>
      {!atBottom && <button type="button" className="web-jump" onClick={jump} aria-label="Jump to latest"><UiIcon name="arrow-down" size={16} />Jump to latest</button>}
      <div className="web-dock" ref={dock}>
        <p className="web-status" role="status" aria-live="polite">{busy ? (<><span className="web-typing" aria-hidden="true"><i /><i /><i /></span>{state.waiting ? "Waiting for the desktop…" : "The assistant is replying…"}</>) : ""}</p>
        {sendError && <p role="alert" className="web-error">{sendError}</p>}
        {p.compose}
        <Composer draft={draft} onDraft={(t) => guard.current!.onDraft(t)} busy={busy} aborting={false} queue={[]}
          history={msgs.filter((m) => m.role === "user").map((m) => m.text)}
          onSend={(t) => guard.current!.onSend(t)} onStop={p.onStop} onDropQueued={() => {}} disabledReason={disabledReason} />
      </div>
      <DeleteChatSheet open={confirmDelete} onCancel={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); p.onClear(); }} />
    </div>
  );
}
