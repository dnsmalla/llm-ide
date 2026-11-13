// Notices about the next message (permission mode, budget, model and routing notes), shown like Claude's: a strip
// attached to the top of the prompt box, one line each, with an optional action and a close button. A closed notice
// stays closed until its text changes. Real errors stay in the transcript as banners.
import type { ReactNode } from "react";

export interface PromptNotice {
  /** Stable id of the kind of notice (mode, budget, tools…); with the text it is the dismissal key. */
  id: string;
  tone: "info" | "warn" | "danger";
  text: string;
  action?: { label: string; run: () => void };
  /** Runs when closed, besides hiding it (e.g. clearing a one-off notice). */
  onClose?: () => void;
}

export const noticeKey = (n: Pick<PromptNotice, "id" | "text">): string => `${n.id}\u0000${n.text}`;

/** The notices still to show: those not closed, in order, without duplicates. Pure. */
export function visibleNotices(items: readonly (PromptNotice | null | false | undefined)[], closed: ReadonlySet<string>): PromptNotice[] {
  const seen = new Set<string>();
  const out: PromptNotice[] = [];
  for (const n of items) {
    if (!n) continue;
    const k = noticeKey(n);
    if (closed.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

export function PromptNotices({ items, onClose }: { items: readonly PromptNotice[]; onClose: (n: PromptNotice) => void }): ReactNode {
  if (items.length === 0) return null;
  return (
    <div className="chat-prompt-notices">
      {items.map((n) => (
        <div key={noticeKey(n)} className="chat-prompt-notice" data-tone={n.tone} role={n.tone === "danger" ? "alert" : "status"}>
          <span className="chat-prompt-notice-text">
            {n.text}
            {n.action ? <> · <button type="button" className="chat-prompt-notice-action" onClick={n.action.run}>{n.action.label}</button></> : null}
          </span>
          <button type="button" className="chat-prompt-notice-close" aria-label={`Close: ${n.text}`} title="Close" onClick={() => onClose(n)}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
