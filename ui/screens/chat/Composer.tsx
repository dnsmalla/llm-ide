// Composer: multiline, Enter sends, Shift+Enter newline, history recall (Up on an empty draft), Stop while a
// turn runs, queue while streaming. File attachments need a host dialog command (the page never supplies a
// path): `onAttach` is optional and the button is hidden without it.
import { useEffect, useRef, useState } from "react";
import { ImeGuard } from "./ime";
import type { ComposerExtras, SendExtra } from "./slash/extras";
import type { ReactNode } from "react";

export interface ComposerProps {
  draft: string;
  onDraft: (text: string) => void;
  busy: boolean;
  aborting: boolean;
  queue: readonly string[];
  /** Past sent messages of this chat, newest last (Up/Down recall). */
  history: readonly string[];
  onSend: (text: string, extra?: SendExtra) => void;
  onStop: () => void;
  onDropQueued: (index: number) => void;
  onAttach?: () => void;
  /** This composer's surface is on screen; only then does Cmd+M bind at window level. */
  active?: boolean;
  disabledReason?: string | null;
  /** Slash menu, @ mentions, skill chips and attachments (slash/extras.tsx); absent = the plain composer. */
  extras?: ComposerExtras;
  /** The mode, model, effort and permission pickers: in the bottom bar after Library/Attach, as on the Mac. */
  controls?: ReactNode;
  /** Session memory, after the pickers (the Mac's memoryButton). */
  memory?: ReactNode;
  /** Token/cap meter shown at the right of the bottom bar. */
  meter?: ReactNode;
}

/** The Mac's empty-field prompt (ChatComposer.inputBar). */
export const COMPOSER_PLACEHOLDER = "Ask Claude about the attached code…";

/** Longest message the composer accepts (the server caps a turn near 500k characters). */
export const MAX_MESSAGE_CHARS = 120_000;

/** The Mac's send-key glyph (ChatComposer.keyHint): the tooltip says what Return and Shift+Return do. */
export const KEY_HINT = "\u21B5 sends \u00B7 \u21E7\u21B5 for a new line";
export function KeyHint() {
  return <span className="chat-muted" role="img" aria-label={KEY_HINT} title={KEY_HINT}>{"\u21B5"}</span>;
}

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

interface SpeechEventLike { results: ArrayLike<ArrayLike<{ transcript: string }>> }
interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void;
  onresult: ((e: SpeechEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
type SpeechCtor = new () => SpeechRecognitionLike;
function speechCtor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True on macOS (the webview's platform string). */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");
}

/** The Mac's voice-input key (CodeAssistant+Voice, Cmd+M): Cmd+M on macOS, Ctrl+M elsewhere; no other modifier. Pure.
 *  On macOS the window menu's Minimize also owns Cmd+M, but WKWebView offers key equivalents to the page first, so
 *  this handler's preventDefault keeps the window up while the active Chat surface owns the shortcut; outside Chat
 *  the native Minimize still works. */
export function isDictationShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac = isMacPlatform()): boolean {
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return e.key.toLowerCase() === "m" && primary && !e.altKey && !e.shiftKey;
}

/** The key the Dictate tooltip names. */
export const dictationShortcutLabel = (mac = isMacPlatform()): string => (mac ? "Cmd+M" : "Ctrl+M");

/** The window-level shortcut is enabled only while this surface is on screen. */
export const dictationEnabled = (active: boolean, voice: unknown): boolean => active && voice !== null && voice !== undefined;

/** Window-level shortcut: skip events the focused composer already handled (it calls preventDefault). */
export function isGlobalDictationShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; defaultPrevented?: boolean }, mac = isMacPlatform()): boolean {
  return !e.defaultPrevented && isDictationShortcut(e, mac);
}

export function Composer(p: ComposerProps) {
  const speech = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const voice = speechCtor();
  const toggleVoice = () => {
    if (!voice) return;
    if (speech.current) { speech.current.stop(); return; }
    const rec = new voice();
    rec.lang = navigator.language || "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0]?.transcript ?? "";
      if (text.trim()) p.onDraft(`${p.draft}${p.draft.trim() ? " " : ""}${text.trim()}`);
    };
    rec.onerror = () => { speech.current = null; setListening(false); };
    rec.onend = () => { speech.current = null; setListening(false); };
    speech.current = rec;
    setListening(true);
    try { rec.start(); } catch { speech.current = null; setListening(false); }
  };
  // Cmd+M works from anywhere in the Chat section, not only while the textarea has focus. The textarea's
  // handler runs first and preventDefaults, so this listener does not toggle twice.
  const toggleRef = useRef(toggleVoice);
  toggleRef.current = toggleVoice;
  useEffect(() => {
    if (!dictationEnabled(p.active === true, voice)) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isGlobalDictationShortcut(e)) return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voice, p.active]);

  const recall = useRef<number | null>(null);
  const ime = useRef<ImeGuard | null>(null);
  if (!ime.current) ime.current = new ImeGuard();
  const guard = ime.current;
  const tooLong = p.draft.length > MAX_MESSAGE_CHARS;
  const blocked = p.extras?.blockedReason ?? null;
  const canSend = p.draft.trim().length > 0 && !tooLong && !p.disabledReason && !blocked;
  const send = () => {
    if (!canSend) return;
    recall.current = null;
    const prepared = p.extras ? p.extras.prepareSend(p.draft) : { text: p.draft, extra: undefined };
    if (prepared) p.onSend(prepared.text, prepared.extra);
    p.onDraft("");
  };
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
      {p.extras?.chips}
      {p.extras?.menu}
      <textarea
        {...p.extras?.textareaProps}
        className="chat-textarea" aria-label="Message" rows={3} value={p.draft} placeholder={p.busy ? "Type to queue the next message" : COMPOSER_PLACEHOLDER}
        onChange={(e) => p.onDraft(e.target.value)}
        onCompositionStart={guard.onCompositionStart} onCompositionEnd={guard.onCompositionEnd}
        onKeyDown={(e) => {
          // Keys that belong to the input method (commit/cancel a conversion) do nothing here: no send, no menu pick, no Stop.
          if (guard.isIme(e)) return;
          if (voice && isDictationShortcut(e)) { e.preventDefault(); toggleVoice(); return; }
          if (p.extras?.onKeyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          else if (e.key === "Escape" && p.busy) { e.preventDefault(); p.onStop(); }
          else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (p.draft === "" || recall.current !== null)) {
            const r = nextRecall(p.history, recall.current, e.key === "ArrowUp" ? "up" : "down");
            if (r.text !== null) { e.preventDefault(); recall.current = r.cursor; p.onDraft(r.text); }
          }
        }}
      />
      {/* The Mac's toolbar order (ChatComposer.toolbarSingleRow): context buttons, pickers, memory | meter, key hint, voice, send. */}
      <div className="chat-composer-bar">
        {p.extras?.toolbar}
        {!p.extras?.toolbar && p.onAttach && <button type="button" className="chat-btn" onClick={p.onAttach} aria-label="Attach files">Attach</button>}
        {p.controls}
        {p.memory}
        {tooLong && <span role="alert" className="chat-error">Message is too long ({p.draft.length.toLocaleString("en-US")} of {MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters).</span>}
        {p.disabledReason && <span className="chat-muted">{p.disabledReason}</span>}
        {blocked && <span className="chat-muted" role="status">{blocked}</span>}
        <span className="chat-spacer" />
        {p.meter}
        <KeyHint />
        {voice ? <button type="button" className="chat-btn" aria-pressed={listening} onClick={toggleVoice} aria-label={listening ? "Stop dictation" : "Dictate a message"} title={`Dictate with the system speech recogniser (${dictationShortcutLabel()})`}>{listening ? "Listening…" : "Dictate"}</button> : null}
        {p.busy && <button type="button" className="chat-btn chat-danger" onClick={p.onStop} disabled={p.aborting} aria-label="Stop the running turn">{p.aborting ? "Stopping…" : "Stop"}</button>}
        <button type="submit" className="chat-btn chat-primary" disabled={!canSend}>{p.busy ? "Queue" : "Send"}</button>
      </div>
    </form>
  );
}
