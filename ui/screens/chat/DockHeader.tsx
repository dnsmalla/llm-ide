// The docked Code Assistant's header (Mac `ChatSessionHeader` inside `CodeAssistantPanel`): the CODE ASSISTANT label,
// the Route (token limit) chip, a chat history menu, New chat, and Hide. History is a bounded native select over the
// chats already loaded (the Chat section has the full searchable list). Chat titles are untrusted text: rendered as text.
import { Icon } from "@llmide/ui-kit";
import { CapChip } from "./Pickers";
import type { RouteView } from "./route";
import type { SessionSummary } from "./store";

/** The history menu lists at most this many chats (the screen loads 100 at a time; a dock needs the recent ones). */
export const DOCK_HISTORY_MAX = 50;
export const DOCK_TITLE = "CODE ASSISTANT";

const label = (s: SessionSummary, busy: boolean): string => {
  const t = Array.from((s.title || "Untitled chat").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ")).slice(0, 60).join("");
  return busy ? `${t} (running)` : t;
};

/** The options of the history menu: the open chat is always present, even beyond the cap. Pure. */
export function historyOptions(sessions: readonly SessionSummary[], activeId: string | null, busyIds: ReadonlySet<string>): { id: string; text: string }[] {
  const head = sessions.slice(0, DOCK_HISTORY_MAX);
  const rows = head.map((s) => ({ id: s.id, text: label(s, busyIds.has(s.id)) }));
  if (activeId && !head.some((s) => s.id === activeId)) {
    const open = sessions.find((s) => s.id === activeId);
    if (open) rows.unshift({ id: open.id, text: label(open, busyIds.has(open.id)) });
  }
  return rows;
}

export interface DockHeaderProps {
  sessions: readonly SessionSummary[];
  activeId: string | null;
  busyIds: ReadonlySet<string>;
  route: RouteView | null;
  routeDisabled: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCollapse?: () => void;
  onSetLimit: (limit: number | null) => Promise<{ coldSwitch?: boolean; estimatedPrefillTokens?: number } | void>;
}

export function DockHeader({ sessions, activeId, busyIds, route, routeDisabled, onSelect, onNew, onCollapse, onSetLimit }: DockHeaderProps) {
  const options = historyOptions(sessions, activeId, busyIds);
  return (
    <header className="chat-dock-head">
      <h2 className="chat-dock-title">{DOCK_TITLE}</h2>
      <CapChip route={route} disabled={routeDisabled} onSetLimit={onSetLimit} />
      <span className="chat-spacer" />
      {options.length > 0 && (
        <select className="chat-dock-history" aria-label="Chat history" value={activeId ?? ""} onChange={(e) => e.target.value && onSelect(e.target.value)}>
          {!activeId && <option value="">Chat history</option>}
          {options.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
        </select>
      )}
      <button type="button" className="chat-dock-btn" aria-label="New chat" title="New chat" onClick={onNew}><Icon name="plus" size={13} /></button>
      {onCollapse && <button type="button" className="chat-dock-btn" aria-label="Hide Code Assistant" title="Hide Code Assistant" onClick={onCollapse}><Icon name="panel-right" size={14} /></button>}
    </header>
  );
}
