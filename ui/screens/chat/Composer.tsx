// Composer: multiline, Enter sends, Shift+Enter newline, history recall (Up on an empty draft), Stop while a
// turn runs, queue while streaming. File attachments need a host dialog command (the page never supplies a
// path): `onAttach` is optional and the button is hidden without it.
import { useRef } from "react";

export interface ComposerProps {
  draft: string;
  onDraft: (text: string) => void;
  busy: boolean;
  aborting: boolean;
  queue: readonly string[];
  /** Past sent messages of this chat, newest last (Up/Down recall). */
  history: readonly string[];
  onSend: (text: string) => void;
  onStop: () => void;
  onDropQueued: (index: number) => void;
  onAttach?: () => void;
  disabledReason?: string | null;
}

/** Longest message the composer accepts (the server caps a turn near 500k characters). */
export const MAX_MESSAGE_CHARS = 120_000;

export function nextRecall(history: readonly string[], cursor: number | null, dir: "up" | "down"): { cursor: number | null; text: string | null } {
  if (history.length === 0) return { cursor, text: null };
  if (dir === "up") {
    const c = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
    return { cursor: c, text: history[c] };
  }
  if (cursor === null) return { cursor, text: null };
  const c = cursor + 1;
  return c >= history.length ? { cursor: null, text: "" } : { cursor: c, text: history[c] };
}

export function Composer(p: ComposerProps) {
  const recall = useRef<number | null>(null);
  const tooLong = p.draft.length > MAX_MESSAGE_CHARS;
  const canSend = p.draft.trim().length > 0 && !tooLong && !p.disabledReason;
  const send = () => { if (canSend) { recall.current = null; p.onSend(p.draft); p.onDraft(""); } };
  return (
    <form className="chat-composer" aria-label="Message composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      {p.queue.length > 0 && (
        <ul className="chat-queue" aria-label="Queued messages">
          {p.queue.map((q, i) => (
            <li key={i}><span className="chat-queue-text">{q}</span>
              <button type="button" className="chat-link-btn" aria-label={`Remove queued message ${i + 1}`} onClick={() => p.onDropQueued(i)}>Remove</button></li>
          ))}
        </ul>
      )}
      <textarea
        className="chat-textarea" aria-label="Message" rows={3} value={p.draft} placeholder={p.busy ? "Type to queue the next message" : "Message"}
        onChange={(e) => p.onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          else if (e.key === "Escape" && p.busy) { e.preventDefault(); p.onStop(); }
          else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (p.draft === "" || recall.current !== null)) {
            const r = nextRecall(p.history, recall.current, e.key === "ArrowUp" ? "up" : "down");
            if (r.text !== null) { e.preventDefault(); recall.current = r.cursor; p.onDraft(r.text); }
          }
        }}
      />
      <div className="chat-composer-bar">
        {p.onAttach && <button type="button" className="chat-btn" onClick={p.onAttach} aria-label="Attach files">Attach</button>}
        {tooLong && <span role="alert" className="chat-error">Message is too long ({p.draft.length.toLocaleString("en-US")} of {MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters).</span>}
        {p.disabledReason && <span className="chat-muted">{p.disabledReason}</span>}
        <span className="chat-spacer" />
        {p.busy && <button type="button" className="chat-btn chat-danger" onClick={p.onStop} disabled={p.aborting} aria-label="Stop the running turn">{p.aborting ? "Stopping…" : "Stop"}</button>}
        <button type="submit" className="chat-btn chat-primary" disabled={!canSend}>{p.busy ? "Queue" : "Send"}</button>
      </div>
    </form>
  );
}
