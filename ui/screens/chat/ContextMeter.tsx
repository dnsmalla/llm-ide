// The Mac's context ring in the composer bar: a ring and the percentage of the last turn's context window; the
// popover lists the SDK's categories. Nothing until a turn has reported one (a new chat, an older core).
import { useState } from "react";
import { contextAdvises, contextPercentLabel, contextRows, contextShare, contextTokensLabel, contextWarns, type ContextUsage } from "./context-meter";

const R = 5;
const RING = 2 * Math.PI * R;

export function ContextMeter({ usage, onNewChat, onContinueWithRecap }: { usage: ContextUsage | null; onNewChat?: () => void; onContinueWithRecap?: () => void }) {
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const rows = contextRows(usage);
  const filled = Math.min(1, Math.max(0, usage.percentage / 100)) * RING;
  const row = (c: ContextUsage["categories"][number], muted: boolean) => (
    <li key={`${c.kind}:${c.name}`} data-muted={muted || undefined}><span>{c.name}</span><span>{c.tokens.toLocaleString("en-US")}</span><span>{contextShare(c, usage)}</span></li>
  );
  return (
    <div className="chat-context" data-warn={contextWarns(usage) || undefined}>
      <button type="button" className="chat-context-chip" aria-label={`Context used ${contextPercentLabel(usage)}`} aria-haspopup="dialog" aria-expanded={open}
        title={`Context used: ${contextTokensLabel(usage)}`} onClick={() => setOpen((v) => !v)}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r={R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <circle cx="6" cy="6" r={R} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${filled} ${RING}`} transform="rotate(-90 6 6)" />
        </svg>
        <span>{contextPercentLabel(usage)}</span>
      </button>
      {open ? (
        <div role="dialog" aria-label="Context usage" className="chat-popover chat-context-popover" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
          <p className="chat-context-total">{contextTokensLabel(usage)}</p>
          <ul className="chat-context-list">{rows.used.map((c) => row(c, false))}</ul>
          {rows.other.length > 0 ? <ul className="chat-context-list">{rows.other.map((c) => row(c, true))}</ul> : null}
          {contextAdvises(usage) ? (
            <div className="chat-context-advice">
              <p>This chat is getting expensive: every new turn re-sends the whole context.</p>
              {onNewChat ? <button type="button" className="chat-btn" onClick={() => { setOpen(false); onNewChat(); }}>Start a fresh chat</button> : null}
              {onContinueWithRecap ? <button type="button" className="chat-btn" onClick={() => { setOpen(false); onContinueWithRecap(); }}>Continue with a local recap</button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
