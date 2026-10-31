// IME guard for the composer. Japanese, Chinese and Korean input methods use Enter (and Escape) to commit or cancel a
// conversion. Browsers disagree on how that key is reported: Chrome sets `isComposing`; Safari and WKWebView (the
// desktop app) fire `compositionend` BEFORE the committing keydown, which then has `isComposing === false` and
// `keyCode === 229`. So a key counts as IME input when any of these holds: a composition is open, the event says it is
// composing, its keyCode is 229, or it follows a compositionend within a short window. Pure apart from the clock.

/** The committing keydown arrives within a few ms of compositionend; a deliberate Enter takes longer. */
export const IME_COMMIT_WINDOW_MS = 80;

export interface KeyLike { keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number }; isComposing?: boolean }

export class ImeGuard {
  private composing = false;
  private endedAt = -Infinity;

  constructor(private readonly clock: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now())) {}

  readonly onCompositionStart = (): void => { this.composing = true; };
  readonly onCompositionEnd = (): void => { this.composing = false; this.endedAt = this.clock(); };

  /** True when this keydown belongs to the input method and must not send, accept a menu item or stop a turn. */
  isIme(e: KeyLike): boolean {
    if (this.composing) return true;
    if (e.isComposing === true || e.nativeEvent?.isComposing === true) return true;
    if (e.keyCode === 229 || e.nativeEvent?.keyCode === 229) return true;
    return this.clock() - this.endedAt <= IME_COMMIT_WINDOW_MS;
  }
}
