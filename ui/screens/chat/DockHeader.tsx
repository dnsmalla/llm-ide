// The docked Code Assistant's header (Mac `ChatSessionHeader` inside `CodeAssistantPanel`): the CODE ASSISTANT label,
// the Route (token limit) chip, a chat history menu, New chat, and Hide. History is a bounded native select over the
// chats already loaded (the Chat section has the full searchable list). Chat titles are untrusted text: rendered as text.
import { useRef, useState } from "react";
import { Icon } from "@llmide/ui-kit";
import { CapChip } from "./Pickers";
import { DELETE_CHAT_DETAIL, DELETE_CHAT_TITLE, type RouteView } from "./route";
import type { SessionSummary } from "./store";

/** The history menu lists at most this many chats (the screen loads 100 at a time; a dock needs the recent ones). */
export const DOCK_HISTORY_MAX = 50;
export const DOCK_TITLE = "CODE ASSISTANT";

/** A chat waiting for an approval says so: it is the one the user has to act on, ahead of a plain running turn. */
const label = (s: SessionSummary, busy: boolean, approval: boolean): string => {
  const t = Array.from((s.title || "Untitled chat").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ")).slice(0, 60).join("");
  if (approval) return `${t} (needs approval)`;
  return busy ? `${t} (running)` : t;
};

/** The options of the history menu: the open chat is always present, even beyond the cap. Pure. */
export function historyOptions(sessions: readonly SessionSummary[], activeId: string | null, busyIds: ReadonlySet<string>, approvalIds: ReadonlySet<string> = new Set()): { id: string; text: string }[] {
  const head = sessions.slice(0, DOCK_HISTORY_MAX);
  const text = (s: SessionSummary) => label(s, busyIds.has(s.id), approvalIds.has(s.id));
  const rows = head.map((s) => ({ id: s.id, text: text(s) }));
  if (activeId && !head.some((s) => s.id === activeId)) {
    const open = sessions.find((s) => s.id === activeId);
    if (open) rows.unshift({ id: open.id, text: text(open) });
  }
  return rows;
}

export interface DockHeaderProps {
  sessions: readonly SessionSummary[];
  activeId: string | null;
  busyIds: ReadonlySet<string>;
  /** Chats (open or in the background) waiting for an approval or question answer. */
  approvalIds?: ReadonlySet<string>;
  route: RouteView | null;
  routeDisabled: boolean;
  /** The same compact turn/token line as the section header; omitted at very narrow widths. */
  meta?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCollapse?: () => void;
  onSetLimit: (limit: number | null) => Promise<{ coldSwitch?: boolean; estimatedPrefillTokens?: number } | void>;
  onRename?: (title: string) => void;
  onDelete?: () => void;
  /** The open chat has messages: the header trash asks first (the Mac's clearChatButton); an empty chat goes at once. */
  hasMessages?: boolean;
}

/** What the header trash does (ChatSessionHeader.clearChatButton): an empty chat has nothing to lose. Pure. */
export const deleteChatAction = (hasMessages: boolean): "confirm" | "delete" => (hasMessages ? "confirm" : "delete");

export function DockHeader({ sessions, activeId, busyIds, approvalIds = new Set(), route, routeDisabled, meta, onSelect, onNew, onCollapse, onSetLimit, onRename, onDelete, hasMessages = false }: DockHeaderProps) {
  const options = historyOptions(sessions, activeId, busyIds, approvalIds);
  // A background chat needs an answer: the header says so while the history menu is closed.
  const backgroundApprovals = [...approvalIds].filter((id) => id !== activeId).length;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const historyButton = useRef<HTMLButtonElement>(null);
  const [actions, setActions] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState(false);
  return (
    <header className="chat-dock-head">
      <h2 className="chat-dock-title">{DOCK_TITLE}</h2>
      {meta ? <span className="chat-meta chat-dock-meta">{meta}</span> : null}
      <CapChip route={route} disabled={routeDisabled} onSetLimit={onSetLimit} />
      <span className="chat-spacer" />
      <button ref={historyButton} type="button" className="chat-dock-history" aria-label="Chat history" aria-haspopup="dialog" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
        <span className="chat-dock-history-title">{sessions.find((s) => s.id === activeId)?.title || "Chat history"}</span>
        {backgroundApprovals > 0 && <span className="chat-dock-attn" role="status">{backgroundApprovals === 1 ? "1 chat needs approval" : `${backgroundApprovals} chats need approval`}</span>}
        <span aria-hidden="true">▾</span>
      </button>
      {historyOpen ? (
        <div className="chat-session-picker" role="dialog" aria-label="Chat history" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setHistoryOpen(false); historyButton.current?.focus(); } }}>
          <input className="chat-input" type="search" autoFocus aria-label="Search chats" placeholder="Search chats" value={historyQuery} onChange={(e) => setHistoryQuery(e.target.value)} />
          <ul className="chat-session-picker-list">
            {options.filter((o) => !historyQuery.trim() || o.text.toLowerCase().includes(historyQuery.trim().toLowerCase())).map((o) => (
              <li key={o.id}><button type="button" className="chat-session-picker-row" data-on={o.id === activeId || undefined} onClick={() => { setHistoryOpen(false); setHistoryQuery(""); onSelect(o.id); }}>{o.text}</button></li>
            ))}
            {options.filter((o) => !historyQuery.trim() || o.text.toLowerCase().includes(historyQuery.trim().toLowerCase())).length === 0 ? <li className="chat-muted">No chats match.</li> : null}
          </ul>
          <button type="button" className="chat-btn chat-primary" onClick={() => { setHistoryOpen(false); setHistoryQuery(""); onNew(); }}>New chat</button>
        </div>
      ) : null}
      {activeId && (onRename || onDelete) ? <button type="button" className="chat-dock-btn" aria-label="Chat actions" aria-haspopup="menu" aria-expanded={actions} title="Chat actions" onClick={() => setActions((v) => !v)}>⋯</button> : null}
      {actions && activeId ? (
        <div className="chat-dock-menu" role="menu" aria-label="Chat actions">
          {renaming && onRename ? (
            <form onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t) onRename(t); setRenaming(false); setActions(false); }}>
              <input className="chat-input" aria-label="Chat title" autoFocus maxLength={200} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" className="chat-btn chat-primary">Save</button>
            </form>
          ) : confirm && onDelete ? (
            <div className="chat-dock-confirm">
              <span>{DELETE_CHAT_TITLE} <span className="chat-muted">{DELETE_CHAT_DETAIL}</span></span>
              <button type="button" className="chat-btn chat-danger" onClick={() => { onDelete(); setConfirm(false); setActions(false); }}>Delete chat</button>
              <button type="button" className="chat-btn" onClick={() => setConfirm(false)}>Keep</button>
            </div>
          ) : (
            <>
              {onRename ? <button type="button" role="menuitem" className="chat-link-btn" onClick={() => { setDraft(sessions.find((s) => s.id === activeId)?.title ?? ""); setRenaming(true); }}>Rename chat</button> : null}
              {onDelete ? <button type="button" role="menuitem" className="chat-link-btn chat-danger" onClick={() => setConfirm(true)}>Delete chat</button> : null}
            </>
          )}
        </div>
      ) : null}
      {activeId && onDelete ? (
        <button type="button" className="chat-dock-btn" aria-label="Delete current chat" title="Delete current chat"
          onClick={() => { if (deleteChatAction(hasMessages) === "delete") onDelete(); else { setRenaming(false); setConfirm(true); setActions(true); } }}>
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      ) : null}
      <button type="button" className="chat-dock-btn" aria-label="New chat" title="New chat" onClick={onNew}><Icon name="plus" size={13} /></button>
      {onCollapse && <button type="button" className="chat-dock-btn" aria-label="Hide Code Assistant" title="Hide Code Assistant" onClick={onCollapse}><Icon name="panel-right" size={14} /></button>}
    </header>
  );
}
