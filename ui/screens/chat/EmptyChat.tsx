// An empty chat (the Mac's ChatMessageList.emptyState): the Code Assistant title, one line on what to do, and four
// quiet suggestions that fill the composer (never send).
export const EMPTY_SUGGESTIONS = ["Review for bugs", "Refactor for readability", "Add unit tests", "Explain this code"] as const;

export function EmptyChat({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="chat-empty-state">
      <h3 className="chat-empty-title">Code Assistant</h3>
      <p className="chat-muted">Attach context with the buttons below, then describe what you want.</p>
      <div className="chat-empty-suggestions" role="group" aria-label="Suggestions">
        {EMPTY_SUGGESTIONS.map((s) => <button key={s} type="button" className="chat-suggestion" onClick={() => onPick(s)}>{s}</button>)}
      </div>
    </div>
  );
}
