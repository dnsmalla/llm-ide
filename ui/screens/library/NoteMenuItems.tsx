// The note context menu's buttons. Kept apart from LibraryScreen so each item's rule (Reveal in Finder only when the
// screen can reveal) is rendered and tested without opening the menu. The caller supplies the actions and the close.
export interface NoteMenuItemsProps {
  /** Project-relative note path under `llm-doc/`, as the menu was opened for. */
  rel: string;
  /** The note is hidden from the list (the menu offers Unhide instead of Remove from List). */
  hidden: boolean;
  onOpen(): void;
  onCopyPath?(text: string): unknown;
  /** Absent when this screen cannot reveal (ssh mode): the item is not drawn, so it cannot be clicked. */
  onRevealPath?(projectRelative: string): unknown;
  onUnhide(): void;
  onRemove(): void;
  onClose(): void;
}

export function NoteMenuItems({ rel, hidden, onOpen, onCopyPath, onRevealPath, onUnhide, onRemove, onClose }: NoteMenuItemsProps) {
  // Every item closes the menu after its action, as the menu always did.
  const run = (action: () => void) => () => {
    action();
    onClose();
  };
  return (
    <>
      <button type="button" role="menuitem" className="lib-context-close" aria-label="Close menu" onClick={onClose}>×</button>
      <button type="button" role="menuitem" onClick={run(onOpen)}>Open</button>
      <button type="button" role="menuitem" onClick={run(() => void onCopyPath?.(`llm-doc/${rel}`))}>Copy relative path</button>
      {onRevealPath ? <button type="button" role="menuitem" onClick={run(() => void onRevealPath(`llm-doc/${rel}`))}>Reveal in Finder</button> : null}
      {/* Hides from this list only: the note file stays where it is. */}
      {hidden ? (
        <button type="button" role="menuitem" onClick={run(onUnhide)}>Unhide</button>
      ) : (
        <button type="button" role="menuitem" onClick={run(onRemove)}>Remove from List</button>
      )}
    </>
  );
}
