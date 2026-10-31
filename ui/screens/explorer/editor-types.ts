// The editor surface the Explorer controller needs. Implemented over Monaco in
// `desktop/src/editor/explorerHost.ts` (the only place that imports `monaco-editor`, so Monaco stays in
// a lazy chunk and the screen code stays testable with a fake).

export interface EditorCallbacks {
  /** Buffer dirtiness changed (undo back to the saved text makes it clean again). */
  onDirty(path: string, dirty: boolean): void;
  /** Cmd/Ctrl+S inside the editor. */
  onSave(path: string): void;
  /** A clean, inactive model was disposed to stay inside the memory budget; re-read on next activation. */
  onEvict(path: string): void;
}

export interface OpenDoc {
  path: string;
  text: string;
  language: string;
  readOnly: boolean;
  /** Large-file mode: no minimap, no tokenisation, no decorations. */
  large: boolean;
}

export interface EditorHost {
  mount(el: HTMLElement, cb: EditorCallbacks): void;
  /** Creates the model if there is none (an existing buffer, with unsaved edits, is kept) and shows it. */
  open(doc: OpenDoc): void;
  /** Shows an existing model; false when there is none (evicted or never opened). */
  show(path: string): boolean;
  has(path: string): boolean;
  /** Shows the empty state (no tab). */
  showNone(): void;
  getText(path: string): string | null;
  /** Replaces the buffer with disk content and resets the saved baseline (reload). */
  replace(path: string, text: string): void;
  /** Appends text to a read-only range view ("load more"). */
  append(path: string, text: string): void;
  /** The buffer now equals disk: dirty is cleared. */
  markSaved(path: string): void;
  /** Disposes the model (tab closed). */
  close(path: string): void;
  /** A tab's file moved: keep the buffer under the new path, unsaved state included. */
  rename(from: string, to: string): void;
  /** Side-by-side diff of `original` (git HEAD or index) against the buffer. */
  showDiff(path: string, original: string): void;
  hideDiff(): void;
  /** Scrolls the open buffer to `line` (1-based) and places the cursor at `col` (1-based, UTF-16). Optional: search results use it. */
  reveal?(path: string, line: number, col: number): void;
  find(): void;
  focus(): void;
  layout(): void;
  /** Re-reads colours from the CSS tokens (data-theme changed). */
  retheme(): void;
  modelCount(): number;
  dispose(): void;
}

/** Above this size a file opens in large-file mode. */
export const LARGE_FILE_BYTES = 1024 * 1024;
/** Memory budget for open models. */
export const MAX_MODELS = 24;
export const MAX_MODEL_CHARS = 64 * 1024 * 1024;
