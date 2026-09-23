// Pure validation helpers for the caption scraper — DOM-free so Node tests can
// cover the invariants in docs/explanation/invariants.md without a browser.

import type { PlatformId } from '../lib/platforms';

/** Meet room URLs: /abc-defg-hij, /lookup/..., /_meet/... */
const MEET_ROOM_RE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/.*)?$/i;
const MEET_VALID_PATHS = ['/lookup/', '/_meet/'] as const;

export const GROUP_ICON_RE = /^groups\b\s*/i;

// Anchored UI-label prefixes. The trailing `(?:\b|(?<=[\s:-]))` makes each
// alternative end at a word boundary (or on its own trailing space/colon/
// dash, e.g. `pin:`), so a label word never matches as the first letters of
// a longer word — without it `call` rejected the speaker "Callum" and
// `more` rejected "Moreover, …".
const UI_PATTERNS =
  /^(?:present|mute|unmute|camera|more|chat|people|raise|record|share|hang|info|meeting|host|leave|call|keyboard|audio|video|back_hand|mood|apps|lock|closed_caption|format_size|circle|font|settings|open|turn|send|language|japanese|english|live captions|ume-|pm\s|am\s|frame_person|visual_effects|reframe|backgrounds|effects|filters|appearance|touch|framing|portrait|blur|lighting|close\s|your\s+meeting|dial-in|pin:|copy\s|joining\s+info|attachments|add\s|share\s+this|meeting\s+link|meeting\s+code|loading\s+invitees|contributors|just\s+you|\d+\s+joined|save\s+transcript|ask\s+tactiq|chevron_right|chevron_left|expand_more|expand_less|content_copy|return\s+to\s+home|submit\s+feedback|in\s+the\s+meeting|your\s+meet\s+call|secure\s+video|video\s+conferencing|new\s+meeting|enter\s+a\s+code|connect.*collaborate|from\s+your\s+google)(?:\b|(?<=[\s:-]))/i;

// Material icon ligature names. The snake_case ones never occur in speech,
// so they reject anywhere. The bare words are ordinary English ("Let's chat
// tomorrow.", "Can you raise that?"), so in caption text they only count
// when the text is shaped like a UI label — see looksLikeUiLabel().
const ICON_TOKEN_PATTERN =
  /\b(frame_person|visual_effects|closed_caption|format_size|keyboard_arrow|more_vert|call_end|back_hand|lock_person|stop_circle|chevron_right|chevron_left|expand_more|expand_less|content_copy|arrow_back|arrow_forward|open_in_new|check_circle|navigate_next|navigate_before)\b/i;
const ICON_WORD_PATTERN = /\b(mic|videocam|computer|reaction|settings|chat|apps|info|mood|raise|filter|cancel)\b/i;

// Meet landing/lobby copy that is long enough to fail looksLikeUiLabel()
// but is never spoken — rejected unconditionally.
const UI_BANNER_PATTERN = /^(connect.*collaborate|from\s+your\s+google)/i;

/**
 * True when caption text looks like a toolbar/menu label rather than
 * speech: at most 5 words and no sentence-final punctuation. Meet, Teams
 * and Zoom all punctuate finished captions, so a real line that happens to
 * start with a UI word ("Share your screen, please.") is not label-shaped,
 * while chrome like "Turn off captions" or "More options" is.
 */
function looksLikeUiLabel(text: string): boolean {
  const t = text.trim();
  return t.split(/\s+/).length <= 5 && !/[.?!…。？！]$/.test(t);
}

const COMBINED_SPEAKER_RE = /\s*[&＆]\s*\d+\s*(others?|more)\b.*$/i;
const COMBINED_SPEAKER_JA = /\s*(他|ほか)\s*\d+\s*(名|人|さん)?\b.*$/;

/** True when the current URL is an active Meet room (not landing/settings). */
export function isActiveMeetingPage(platform: PlatformId | null, pathname: string): boolean {
  if (platform !== 'meet') return true;
  if (MEET_ROOM_RE.test(pathname)) return true;
  if (MEET_VALID_PATHS.some((p) => pathname.startsWith(p))) return true;
  return false;
}

/** Strip control chars, combined-speaker suffixes, collapse whitespace, cap length. */
export function sanitizeSpeaker(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(COMBINED_SPEAKER_RE, '')
      .replace(COMBINED_SPEAKER_JA, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50)
  );
}

/** Content-based caption validation — not position-based (see invariants.md). */
export function isValidCaption(speaker: string, text: string): boolean {
  if (!speaker || !text) return false;
  if (speaker.length > 50 || speaker.length < 1) return false;
  if (text.length < 1 || text.length > 2000) return false;

  if (UI_PATTERNS.test(speaker)) return false;
  if (ICON_TOKEN_PATTERN.test(speaker) || ICON_WORD_PATTERN.test(speaker)) return false;
  if (/^\d{1,2}:\d{2}/.test(speaker)) return false;
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(speaker)) return false;

  const speakerWords = speaker.split(/\s+/).length;
  if (speakerWords > 5) return false;

  if (ICON_TOKEN_PATTERN.test(text) || UI_BANNER_PATTERN.test(text)) return false;
  if (looksLikeUiLabel(text)) {
    if (UI_PATTERNS.test(text)) return false;
    if (ICON_WORD_PATTERN.test(text)) return false;
    if (/\bturn (off|on)\b/i.test(text)) return false;
  }
  if (/\+\d{1,3}[\s-]?\d/.test(text)) return false;
  if (/\bvideo_call\b|\bkeyboard\b.*\bJoin\b/i.test(text)) return false;
  if (/\b[a-z]+_[a-z]+\b/.test(speaker)) return false;

  const textWords = text.split(/\s+/);
  if (textWords.every((w) => /^[a-z]+_[a-z]+$/i.test(w))) return false;
  if (/^\d{1,3}$/.test(text.trim())) return false;

  return true;
}

/** Live-sync and Mac mirror: spoken-word sources only (not agent commentary). */
export function isHumanTranscriptSource(source: string | undefined): boolean {
  if (!source) return true;
  return !source.startsWith('agent-');
}
