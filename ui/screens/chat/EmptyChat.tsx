// An empty chat (the Mac's ChatMessageList.emptyState): the Code Assistant title, one line on what to do, and four
// quiet suggestions that fill the composer (never send).
export const EMPTY_SUGGESTIONS = ["Review for bugs", "Refactor for readability", "Add unit tests", "Explain this code"] as const;
/** Suggestions that cannot change code: shown in Ask/Review/Document/Plan modes. */
export const READ_ONLY_SUGGESTIONS = ["Review for bugs", "Explain this code", "Find risks", "Suggest tests"] as const;

export function EmptyChat({ onPick, readOnly = false }: { onPick: (text: string) => void; readOnly?: boolean }) {
  return (
    <div className="chat-empty-state">
      <h3 className="chat-empty-title">Code Assistant</h3>
      <p className="chat-muted">{readOnly ? "Read-only: this mode explains and reviews but never edits. Use Execute for code changes." : "Attach context with the buttons below, then describe what you want."}</p>
      <div className="chat-empty-suggestions" role="group" aria-label="Suggestions">
        {(readOnly ? READ_ONLY_SUGGESTIONS : EMPTY_SUGGESTIONS).map((s) => <button key={s} type="button" className="chat-suggestion" onClick={() => onPick(s)}>{s}</button>)}
      </div>
    </div>
  );
}
