// Composer: multiline, Enter sends, Shift+Enter newline, history recall (Up on an empty draft), Stop while a
// turn runs, queue while streaming. File attachments need a host dialog command (the page never supplies a
// path): `onAttach` is optional and the button is hidden without it.
import { useEffect, useRef, useState } from "react";
import { ImeGuard } from "./ime";
import type { ComposerExtras, SendExtra } from "./slash/extras";
import type { ReactNode } from "react";
import { MAX_QUEUE } from "./state";
import { invokeHost, isHostAvailable } from "../shell/host";

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
  /** Notices about the next message, attached to the top of the prompt box (PromptNotices). */
  notices?: ReactNode;
  /** Dock: keep the advanced controls collapsed until the user opens Options. */
  collapsible?: boolean;
}

/** The Mac's empty-field prompt (ChatComposer.inputBar). */
export const COMPOSER_PLACEHOLDER = "Ask Claude about the attached code…";

/** Longest message the composer accepts (the server caps a turn near 500k characters). */
export const MAX_MESSAGE_CHARS = 120_000;

/** The Mac's send-key glyph (ChatComposer.keyHint): the tooltip says what Return and Shift+Return do. */
export const KEY_HINT = "\u21B5 sends \u00B7 \u21E7\u21B5 for a new line";
const svg = (d: ReactNode) => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
const MIC_ICON = svg(<><rect x="5.5" y="1.75" width="5" height="8" rx="2.5" /><path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" /></>);
export const ATTACH_ICON = svg(<path d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5L9 2.5a2.1 2.1 0 0 1 3 3L6.6 10.9a1 1 0 0 1-1.5-1.5L10 4.5" />);
const SEND_ICON = svg(<path d="M8 13V3.5M3.75 7.75 8 3.5l4.25 4.25" />);
const STOP_ICON = <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" /></svg>;

export function KeyHint() {
  return <span className="chat-muted" role="img" aria-label={KEY_HINT} title={KEY_HINT}>{"\u21B5"}</span>;
}

/**
 * Esc stops a running turn from anywhere on the chat surface (the Mac's Stop button is the window's cancel action).
 * A key a popover, the textarea or an input method already handled is left alone. Pure.
 */
export function stopsOnEscape(e: { key: string; defaultPrevented: boolean; isComposing?: boolean }, active: boolean, busy: boolean): boolean {
  return active && busy && e.key === "Escape" && !e.defaultPrevented && e.isComposing !== true;
}

/**
 * The Mac's ghost prediction (ChatComposer.promptSuggestion): the newest sent prompt that extends the draft. None for
 * an empty draft, while recalling history, or when it would only repeat the draft. Pure.
 */
export function promptSuggestion(draft: string, history: readonly string[], recalling: boolean): string | null {
  if (!draft || recalling) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h !== draft && h.startsWith(draft)) return h;
  }
  return null;
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
/** Which voice input the mic uses: the web view's speech engine, else the Mac host's system Dictation, else none. Pure. */
export function dictationMode(webSpeech: boolean, host: boolean, mac: boolean): "web" | "system" | null {
  return webSpeech ? "web" : host && mac ? "system" : null;
}

export const dictationEnabled = (active: boolean, voice: unknown): boolean => active && voice !== null && voice !== undefined;

/** Window-level shortcut: skip events the focused composer already handled (it calls preventDefault). */
export function isGlobalDictationShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; defaultPrevented?: boolean }, mac = isMacPlatform()): boolean {
  return !e.defaultPrevented && isDictationShortcut(e, mac);
}

export function Composer(p: ComposerProps) {
  const speech = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
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
  // No web speech engine (the macOS web view has none for apps): the desktop host starts the system's own Dictation
  // in the focused message box instead, so the mic always works on the Mac app.
  const form = useRef<HTMLFormElement | null>(null);
  const [dictError, setDictError] = useState<string | null>(null);
  const systemDictation = dictationMode(voice !== null, isHostAvailable(), isMacPlatform()) === "system";
  const startSystemDictation = () => {
    form.current?.querySelector("textarea")?.focus();
    setDictError(null);
    invokeHost<void>("start_system_dictation").catch(() => setDictError("Dictation could not start. Turn it on in System Settings → Keyboard → Dictation."));
  };
  const dictate = voice ? toggleVoice : systemDictation ? startSystemDictation : null;
  toggleRef.current = dictate ?? toggleVoice;
  useEffect(() => {
    if (!dictationEnabled(p.active === true, dictate)) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isGlobalDictationShortcut(e)) return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dictate !== null, p.active]);

  const stopRef = useRef(p.onStop);
  stopRef.current = p.onStop;
  useEffect(() => {
    if (!p.active || !p.busy) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => { if (stopsOnEscape(e, true, true)) { e.preventDefault(); stopRef.current(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.active, p.busy]);

  const recall = useRef<number | null>(null);
  // An Esc-dismissed prediction stays dismissed only for the draft it was dismissed on.
  const [ghostOffFor, setGhostOffFor] = useState<string | null>(null);
  const ghost = ghostOffFor === p.draft || p.extras?.menu ? null : promptSuggestion(p.draft, p.history, recall.current !== null);
  const ime = useRef<ImeGuard | null>(null);
  if (!ime.current) ime.current = new ImeGuard();
  const guard = ime.current;
  const tooLong = p.draft.length > MAX_MESSAGE_CHARS;
  const blocked = p.extras?.blockedReason ?? null;
  // A full queue refuses the message: Send stays off so the draft and attachments are kept for later, never cleared.
  const queueFull = p.queue.length >= MAX_QUEUE;
  const canSend = p.draft.trim().length > 0 && !tooLong && !p.disabledReason && !blocked && !queueFull;
  const send = () => {
    if (!canSend) return;
    recall.current = null;
    const prepared = p.extras ? p.extras.prepareSend(p.draft) : { text: p.draft, extra: undefined };
    if (prepared) p.onSend(prepared.text, prepared.extra);
    p.onDraft("");
  };
  return (
    <form ref={form} className="chat-composer" aria-label="Message composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
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
      <div className="chat-input-card" data-busy={p.busy || undefined} data-listening={listening || undefined}>
      {p.notices}
      <textarea
        {...p.extras?.textareaProps}
        className="chat-textarea" aria-label="Message" rows={3} value={p.draft} placeholder={p.busy ? "Type to queue the next message" : COMPOSER_PLACEHOLDER}
        onChange={(e) => p.onDraft(e.target.value)}
        onCompositionStart={guard.onCompositionStart} onCompositionEnd={guard.onCompositionEnd}
        onKeyDown={(e) => {
          // Keys that belong to the input method (commit/cancel a conversion) do nothing here: no send, no menu pick, no Stop.
          if (guard.isIme(e)) return;
          if (dictate && isDictationShortcut(e)) { e.preventDefault(); dictate(); return; }
          if (p.extras?.onKeyDown(e)) return;
          if (e.key === "Tab" && !e.shiftKey && ghost) { e.preventDefault(); p.onDraft(ghost); return; }
          if (e.key === "Escape" && ghost && !p.busy) { e.preventDefault(); setGhostOffFor(p.draft); return; }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          else if (e.key === "Escape" && p.busy) { e.preventDefault(); p.onStop(); }
          else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (p.draft === "" || recall.current !== null)) {
            const r = nextRecall(p.history, recall.current, e.key === "ArrowUp" ? "up" : "down");
            if (r.text !== null) { e.preventDefault(); recall.current = r.cursor; p.onDraft(r.text); }
          }
        }}
      />
      {ghost ? <p className="chat-muted chat-ghost" role="status">Tab: {ghost}</p> : null}
      {/* The Mac's toolbar order (ChatComposer.toolbarSingleRow): context buttons, pickers, memory | meter, key hint, voice, send. */}
      <div className="chat-composer-bar" data-options={p.collapsible ? optionsOpen : true}>
        <button type="button" className="chat-icon-btn chat-options-toggle" aria-label={optionsOpen ? "Hide composer options" : "Show composer options"} aria-expanded={optionsOpen} title={optionsOpen ? "Hide options" : "Options"} onClick={() => setOptionsOpen((v) => !v)} hidden={!p.collapsible}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h7M12 4h2M2 8h2M7 8h7M2 12h5M10 12h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><circle cx="10.5" cy="4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2"/><circle cx="5.5" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2"/><circle cx="8.5" cy="12" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
        {(!p.collapsible || optionsOpen) && p.extras?.toolbar}
        {(!p.collapsible || optionsOpen) && !p.extras?.toolbar && p.onAttach && <button type="button" className="chat-icon-btn" onClick={p.onAttach} aria-label="Attach files" title="Attach files">{ATTACH_ICON}</button>}
        {(!p.collapsible || optionsOpen) && p.controls}
        {(!p.collapsible || optionsOpen) && p.memory}
        {tooLong && <span role="alert" className="chat-error">Message is too long ({p.draft.length.toLocaleString("en-US")} of {MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters).</span>}
        {p.disabledReason && <span className="chat-muted">{p.disabledReason}</span>}
        {queueFull && <span className="chat-muted" role="status">Queue full ({MAX_QUEUE} waiting). Your draft is kept.</span>}
        {blocked && <span className="chat-muted" role="status">{blocked}</span>}
        <span className="chat-spacer" />
        {p.meter}
        <KeyHint />
        {dictate
          ? <button type="button" className="chat-icon-btn chat-mic" aria-pressed={listening} onClick={dictate} aria-label={listening ? "Stop dictation" : "Dictate a message"} title={`${listening ? "Stop dictation" : voice ? "Dictate" : "Dictate with macOS Dictation"} (${isMacPlatform() ? "⌘M" : "Ctrl+M"})`}>{MIC_ICON}</button>
          : <button type="button" className="chat-icon-btn chat-mic" disabled aria-label="Dictate a message" title="Speech recognition is not available here">{MIC_ICON}</button>}
        {p.busy && <button type="button" className="chat-btn chat-danger chat-stop" onClick={p.onStop} disabled={p.aborting} aria-label="Stop the running turn" title="Stop the running reply (Esc)">{STOP_ICON}{p.aborting ? "Stopping…" : "Stop"}</button>}
        <button type="submit" className="chat-btn chat-primary chat-send" disabled={!canSend} title={p.busy ? "Queue this message: it sends when the current reply ends (↵)" : "Send (↵ · ⇧↵ for a new line)"}>{p.busy ? "Queue" : "Send"}{SEND_ICON}</button>
      </div>
      </div>
      {dictError ? <p className="chat-muted chat-dict-error" role="status">{dictError}</p> : null}
    </form>
  );
}
