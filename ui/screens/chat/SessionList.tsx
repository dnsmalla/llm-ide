// Virtualised, grouped chat list. 1,000+ chats cost the same DOM as 20: only rows near the viewport render.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Chip } from "@llmide/ui-kit";
import type { SessionSummary } from "./store";
import { groupRows, rowHeights, ITEM_HEIGHT, type SessionRowModel } from "./virtual";
import { useVirtualList } from "./hooks";

export interface SessionListProps {
  sessions: readonly SessionSummary[];
  activeId: string | null;
  /** Chats with a turn running in this app. */
  busyIds: ReadonlySet<string>;
  /** More sessions exist on the core than are loaded. */
  hasMore: boolean;
  onLoadMore: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Injected for tests and the server-render path. */
  nowMs?: number;
}

export function filterSessions(sessions: readonly SessionSummary[], q: string): SessionSummary[] {
  const needle = q.trim().toLowerCase();
  return needle ? sessions.filter((s) => (s.title || "Untitled chat").toLowerCase().includes(needle)) : sessions.slice();
}

export function SessionList(props: SessionListProps) {
  const { sessions, activeId, busyIds, hasMore, onLoadMore, onSelect, onNew, onRename, onDelete } = props;
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const nowMs = props.nowMs ?? Date.now();

  const rows = useMemo(
    () => groupRows(filterSessions(sessions, query), (s) => s.updatedAt * 1000, (s) => s.id, nowMs),
    [sessions, query, nowMs],
  );
  const heights = useMemo(() => rowHeights(rows), [rows]);
  const keyOf = useCallback((i: number) => rows[i]?.key ?? String(i), [rows]);
  const known = useCallback((i: number) => heights[i], [heights]);
  const { scrollRef, range, offsets, scrollTop, viewport } = useVirtualList(rows.length, keyOf, ITEM_HEIGHT, known, 6);

  // Near the end of what is loaded: ask for the next page.
  const nearEnd = hasMore && !query && (offsets[rows.length] ?? 0) - (scrollTop + viewport) < ITEM_HEIGHT * 10;
  useEffect(() => { if (nearEnd) onLoadMore(); }, [nearEnd, rows.length, onLoadMore]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = rows.filter((r): r is Extract<SessionRowModel<SessionSummary>, { kind: "item" }> => r.kind === "item");
    const at = items.findIndex((r) => r.item.id === activeId);
    const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) { e.preventDefault(); onSelect(next.item.id); }
  };

  return (
    <nav className="chat-sessions" aria-label="Chats">
      <div className="chat-sessions-bar">
        <input type="search" className="chat-input" aria-label="Search chats" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="chat-btn" onClick={onNew} aria-label="New chat">New</button>
      </div>
      <div ref={scrollRef} className="chat-sessions-scroll" role="list" aria-label={`${sessions.length} chats`} onKeyDown={onKey}>
        {rows.length === 0 && <p className="chat-muted chat-pad">{query ? "No chats match." : "No chats yet."}</p>}
        <div style={{ paddingTop: range.padTop, paddingBottom: range.padBottom }}>
          {rows.slice(range.start, range.end).map((r) => {
            if (r.kind === "header") return <div key={r.key} className="chat-group" role="presentation" style={{ height: 28 }}>{r.label}</div>;
            const s = r.item;
            const active = s.id === activeId;
            const busy = busyIds.has(s.id);
            const title = s.title || "Untitled chat";
            return (
              <div key={r.key} role="listitem" className="chat-session" data-active={active} style={{ height: ITEM_HEIGHT }}>
                {renaming === s.id ? (
                  <form className="chat-rename" onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t) onRename(s.id, t); setRenaming(null); }}>
                    <input className="chat-input" aria-label="Chat title" autoFocus value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }} />
                  </form>
                ) : (
                  <button type="button" className="chat-session-main" aria-current={active ? "true" : undefined} onClick={() => onSelect(s.id)}>
                    <span className="chat-session-title">{title}</span>
                    {busy && <Chip label="Running" compact />}
                  </button>
                )}
                {renaming !== s.id && (confirming === s.id ? (
                  <span className="chat-session-actions">
                    <button type="button" className="chat-btn chat-danger" onClick={() => { setConfirming(null); onDelete(s.id); }}>Delete chat</button>
                    <button type="button" className="chat-btn" onClick={() => setConfirming(null)}>Keep</button>
                  </span>
                ) : (
                  <span className="chat-session-actions">
                    <button type="button" className="chat-link-btn" aria-label={`Rename ${title}`} onClick={() => { setDraft(s.title); setRenaming(s.id); }}>Rename</button>
                    <button type="button" className="chat-link-btn" aria-label={`Delete ${title}`} onClick={() => setConfirming(s.id)}>Delete</button>
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
