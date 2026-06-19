// Scrapes built-in captions (CC) from Google Meet, Microsoft Teams, and Zoom web.
//
// Design principle: MIRROR what CC shows. Nothing more.
//
// Strategy:
// 1. Every 800ms, read the current CC panel state.
// 2. For each caption block visible (speaker + text), remember the latest text per speaker.
// 3. When a speaker's text CHANGES, send an update (with same sessionId to update same line).
// 4. When a speaker disappears from CC and a new caption shows up later, new sessionId = new line.

import { MsgType, type Message } from '../lib/messages';
import { debug } from '../lib/config';
import { detectPlatformFromUrl, type PlatformId } from '../lib/platforms';

// Guard against re-injection: chrome.scripting.executeScript({files:...})
// re-executes top-level code, which would stack listeners / observers /
// intervals every time the SW wakes and re-injects. Bail out if already loaded.
declare global {
  interface Window {
    __llmideCaptionScraperInjected?: boolean;
  }
}
if (window.__llmideCaptionScraperInjected) {
  debug('[caption-scraper] already injected — skipping re-init');
  // Throwing aborts module evaluation; chrome.scripting.executeScript
  // surfaces it as a rejected promise which the SW logs and ignores.
  throw new Error('llmide:caption-scraper-already-injected');
}
window.__llmideCaptionScraperInjected = true;

type Platform = PlatformId | null;

interface CaptionBlock {
  speaker: string;
  text: string;
}

const SESSION_GAP_MS = 5_000; // After this silence, next caption starts a new line
const SCRAPE_INTERVAL_MS = 800;
const MAX_BLOCK_AGE_MS = 15_000; // Drop speaker state older than this

let isCapturing = false;
let observer: MutationObserver | null = null;
let scrapeInterval: ReturnType<typeof setInterval> | null = null;
let platform: Platform = null;

// Per-speaker session state.
// Meet's CC shows a sliding window of recent speech — old sentences drop off
// the front as new ones appear. Time-based sessions handle this correctly:
// any text change within SESSION_GAP_MS updates the SAME transcript entry,
// so the entry always shows the latest CC text for that speaker's turn.
interface SpeakerState {
  sessionId: string;
  text: string;
  lastSeen: number;
}
const speakerState: Map<string, SpeakerState> = new Map();
let sessionCounter = 0;

function detectPlatform(): Platform {
  return detectPlatformFromUrl(window.location.href);
}

// ── Active-meeting guard ─────────────────────────────────────────────
// The content script is injected on ALL meet.google.com/* pages (the
// manifest can't distinguish meeting rooms from the landing page).
// Scraping the landing or settings page picks up UI text as "captions".
// This guard checks whether the current URL is an actual meeting room.
//
// Meeting room URLs:  /abc-defg-hij, /lookup/..., /_meet/...
// Non-meeting URLs:   /landing, /, /new, /settings, /whoops404
//
// For Teams and Zoom the content_scripts match patterns are already
// narrow enough (e.g. /l/*, /v2/*, /wc/*, /j/*), so we only need
// this guard for Meet.

const MEET_ROOM_RE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/.*)?$/i;
const MEET_VALID_PATHS = ['/lookup/', '/_meet/'];

function isActiveMeetingPage(): boolean {
  if (platform !== 'meet') return true; // Only guard Meet pages
  const path = window.location.pathname;
  if (MEET_ROOM_RE.test(path)) return true;
  if (MEET_VALID_PATHS.some((p) => path.startsWith(p))) return true;
  return false;
}

// ─── Platform-specific caption readers ────────────────────────────────
// Each returns an array of CURRENTLY visible caption blocks on screen.
// This mirrors exactly what CC shows — no history, no heuristics.

// ── Meet caption reader ───────────────────────────────────────────────
//
// Primary path  : class-based (discovered via DOM inspection)
//   Caption block : div.nMcdL.bj4p3b  (one per active speaker)
//   Speaker name  : div.adE6rb inside each block
//   Caption text  : div.ygicle inside each block
//
// Fallback path : heuristic div-scan (used if Meet changes its CSS classes)
//
// The primary path needs no height/line-count heuristics — it reads the
// exact elements Meet itself uses to render CC.

function readMeetCaptionsByClass(): CaptionBlock[] {
  // Find individual caption blocks (those that have a direct .adE6rb child).
  // The outer wrapper also has class nMcdL bj4p3b but no direct .adE6rb.
  const blocks: CaptionBlock[] = [];
  const seenSpeakers = new Set<string>();

  const captionEls = document.querySelectorAll('.nMcdL.bj4p3b');
  for (const el of Array.from(captionEls).reverse()) {
    const speakerEl = el.querySelector(':scope > .adE6rb') as HTMLElement | null;
    const textEl = el.querySelector(':scope > .ygicle') as HTMLElement | null;
    if (!speakerEl || !textEl) continue;

    let speaker = speakerEl.innerText?.trim() ?? '';
    // Strip Material "groups" icon that appears when 3+ speakers are combined
    speaker = sanitizeSpeaker(speaker.replace(GROUP_ICON_RE, ''));
    if (!speaker) continue;

    const text = textEl.innerText?.trim() ?? '';
    if (!text) continue;

    if (!isValidCaption(speaker, text)) continue;
    if (seenSpeakers.has(speaker)) continue;
    seenSpeakers.add(speaker);
    blocks.push({ speaker, text });
  }
  return blocks;
}

function readMeetCaptionsByHeuristic(): CaptionBlock[] {
  const blocks: CaptionBlock[] = [];
  const vh = window.innerHeight;
  const candidates = document.querySelectorAll('div');
  const seenSpeakers = new Set<string>();

  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) continue;
    if (rect.top > vh || rect.bottom < 0) continue;
    if (rect.top < vh * 0.08 && rect.bottom < vh * 0.2) continue;
    if (rect.height < 20 || rect.height > 500) continue;
    if (rect.width < 100) continue;

    const text = (el as HTMLElement).innerText?.trim();
    if (!text) continue;

    const cleaned: string[] = [];
    for (const raw of text.split('\n')) {
      let l = raw.trim();
      if (!l) continue;
      if (/^groups$/i.test(l)) continue;
      l = l.replace(GROUP_ICON_RE, '').trim();
      if (l) cleaned.push(l);
    }
    if (cleaned.length < 2) continue;

    const speaker = sanitizeSpeaker(cleaned[0]);
    const captionText = cleaned.slice(1).join(' ');
    if (!speaker) continue;
    if (!isValidCaption(speaker, captionText)) continue;
    if (seenSpeakers.has(speaker)) continue;

    const hasSmallerCaptionChild = Array.from(el.children).some((child) => {
      const childText = (child as HTMLElement).innerText?.trim();
      if (!childText) return false;
      const childLines = childText
        .split('\n')
        .map((l) => l.trim().replace(GROUP_ICON_RE, '').trim())
        .filter(Boolean);
      return childLines.length >= 2 && childLines[0] === speaker;
    });
    if (hasSmallerCaptionChild) continue;

    seenSpeakers.add(speaker);
    blocks.push({ speaker, text: captionText });
  }
  return blocks;
}

// Aria/structure-based reader.  Independent of CSS class names because
// Google Meet rotates obfuscated class identifiers (`.nMcdL.bj4p3b` etc.)
// on every UI redesign.  Aria attributes and DOM roles survive those
// redesigns: every accessible captions panel has a stable signal
// somewhere — `role="region"` + `aria-label="Captions"`,
// `aria-live="polite"`, or a localized variant of the same.  We probe
// each in cascade and group child text into (speaker, text) pairs.
function readMeetCaptionsByAria(): CaptionBlock[] {
  // 1. Find the captions container via aria signals.  Locale-aware:
  //    "caption" / "subtitle" / "字幕" / "subtítulo" all use the same
  //    aria-label idiom in Meet.  Case-insensitive substring match
  //    catches "Captions", "Live Captions", "Closed Captions", etc.
  const ariaCandidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[aria-label*="aption" i], [aria-label*="ubtitle" i], [aria-label*="字幕"], ' +
        '[role="region"][aria-label], [aria-live="polite"]',
    ),
  );
  const liveLabels = ['caption', 'subtitle', 'cc', '字幕', 'transcript'];
  let panels = ariaCandidates.filter((el) => {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    return liveLabels.some((k) => label.includes(k));
  });
  if (panels.length === 0) {
    // 2. Last resort: any aria-live polite region in the lower half of
    //    the viewport with non-trivial height — Meet's caption area
    //    always satisfies all three even when stripped of identifying
    //    aria-labels in early-bird builds.
    const vh = window.innerHeight;
    panels = ariaCandidates.filter((el) => {
      if (el.getAttribute('aria-live') !== 'polite') return false;
      const rect = el.getBoundingClientRect();
      return rect.height > 24 && rect.bottom > vh * 0.4;
    });
  }
  if (panels.length === 0) return [];

  const blocks: CaptionBlock[] = [];
  const seenSpeakers = new Set<string>();

  for (const panel of panels) {
    // Walk caption rows.  Each row contains a speaker label (avatar
    // alt-text or short text node) followed by the caption text in a
    // sibling/child element.  We treat any descendant whose innerText
    // contains a newline as a row container — Meet renders the
    // speaker name and text as separate blocks within one row, and
    // innerText folds them into "<name>\n<text>".
    const rowCandidates = panel.querySelectorAll<HTMLElement>('div, p, li');
    for (const row of rowCandidates) {
      const text = row.innerText?.trim();
      if (!text || text.length < 3) continue;
      // The row should have at LEAST a name + text.  We accept either
      // newline-separated or two-line (avatar alt + text) shapes.
      const lines = text
        .split('\n')
        .map((l) => l.replace(GROUP_ICON_RE, '').trim())
        .filter((l) => l && !/^groups$/i.test(l));
      if (lines.length < 2) continue;

      // Skip if this row's children also satisfy the predicate —
      // we want the smallest container, not its parent (otherwise we
      // double-emit the same caption for the row AND its wrapping
      // panel).
      const childMatchesSelf = Array.from(row.children).some((child) => {
        const t = (child as HTMLElement).innerText?.trim();
        if (!t) return false;
        const childLines = t
          .split('\n')
          .map((l) => l.replace(GROUP_ICON_RE, '').trim())
          .filter(Boolean);
        return childLines.length >= 2 && childLines[0] === lines[0];
      });
      if (childMatchesSelf) continue;

      const speaker = sanitizeSpeaker(lines[0]);
      const captionText = lines.slice(1).join(' ').trim();
      if (!speaker) continue;
      if (!isValidCaption(speaker, captionText)) continue;
      if (seenSpeakers.has(speaker)) continue;
      seenSpeakers.add(speaker);
      blocks.push({ speaker, text: captionText });
    }
  }
  return blocks;
}

function readMeetCaptions(): CaptionBlock[] {
  // Cascade: the class-based reader is fastest when its selectors
  // happen to match (Meet ships builds where they hold for weeks at a
  // time).  When Google rotates the obfuscated class names, the
  // aria-based reader takes over with no maintenance.  The viewport
  // heuristic is the last resort for builds that strip both.
  //
  // Each strategy returns [] on miss, so we just pick the first
  // non-empty result.  When DEBUG is on, we log which strategy hit so
  // a user reporting "captions stopped" can tell us at which layer.
  const byClass = readMeetCaptionsByClass();
  if (byClass.length > 0) {
    debug('meet captions: class-based hit', byClass.length);
    return byClass;
  }
  const byAria = readMeetCaptionsByAria();
  if (byAria.length > 0) {
    debug('meet captions: aria-based hit', byAria.length);
    return byAria;
  }
  const byHeuristic = readMeetCaptionsByHeuristic();
  if (byHeuristic.length > 0) {
    debug('meet captions: heuristic hit', byHeuristic.length);
    return byHeuristic;
  }
  return [];
}

function readTeamsCaptions(): CaptionBlock[] {
  const blocks: CaptionBlock[] = [];
  const seenSpeakers = new Set<string>();

  const messages = document.querySelectorAll('[data-tid="closed-caption-chat-message"]');
  // Iterate in reverse order — we want the LATEST caption per speaker
  const msgArray = Array.from(messages).reverse();
  for (const msg of msgArray) {
    const speaker = sanitizeSpeaker(msg.querySelector('.ui-chat__message__author')?.textContent || '');
    const text = msg.querySelector('[data-tid="closed-caption-text"]')?.textContent?.trim() || '';
    if (!isValidCaption(speaker, text)) continue;
    if (seenSpeakers.has(speaker)) continue;
    seenSpeakers.add(speaker);
    blocks.push({ speaker, text });
  }
  return blocks;
}

function readZoomCaptions(): CaptionBlock[] {
  const blocks: CaptionBlock[] = [];
  const seenSpeakers = new Set<string>();

  // Zoom transcript panel
  const panel = document.querySelector(
    '[aria-label*="Transcript"], [aria-label*="Caption"], [class*="transcript"], [class*="caption-panel"]',
  );

  if (panel) {
    const items = panel.querySelectorAll('[class*="message"], [class*="item"], li, [role="listitem"]');
    const itemArray = Array.from(items).reverse();
    for (const item of itemArray) {
      const t = (item as HTMLElement).innerText?.trim();
      if (!t) continue;
      const lines = t
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) continue;
      const speaker = sanitizeSpeaker(lines[0]);
      const text = lines.slice(1).join(' ');
      if (!speaker) continue;
      if (!isValidCaption(speaker, text)) continue;
      if (seenSpeakers.has(speaker)) continue;
      seenSpeakers.add(speaker);
      blocks.push({ speaker, text });
    }
    return blocks;
  }

  // Inline captions fallback
  const inline = document.querySelectorAll('[class*="subtitle"], [class*="closed-caption"], [class*="cc-text"]');
  for (const el of inline) {
    const t = (el as HTMLElement).innerText?.trim();
    if (!t) continue;
    const lines = t
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;
    const speaker = sanitizeSpeaker(lines[0]);
    const text = lines.slice(1).join(' ');
    if (!speaker) continue;
    if (!isValidCaption(speaker, text)) continue;
    if (seenSpeakers.has(speaker)) continue;
    seenSpeakers.add(speaker);
    blocks.push({ speaker, text });
  }
  return blocks;
}

// ─── Validation ───────────────────────────────────────────────────────

// Known non-caption UI text patterns
const UI_PATTERNS =
  /^(present|mute|unmute|camera|more|chat|people|raise|record|share|hang|info|meeting|host|leave|call|keyboard|audio|video|back_hand|mood|apps|lock|closed_caption|format_size|circle|font|settings|open|turn|send|language|japanese|english|live captions|ume-|pm\s|am\s|frame_person|visual_effects|reframe|backgrounds|effects|filters|appearance|touch|framing|portrait|blur|lighting|close\s|your\s+meeting|dial-in|pin:|copy\s|joining\s+info|attachments|add\s|share\s+this|meeting\s+link|meeting\s+code|loading\s+invitees|contributors|just\s+you|\d+\s+joined|save\s+transcript|ask\s+tactiq|chevron_right|chevron_left|expand_more|expand_less|content_copy|return\s+to\s+home|submit\s+feedback|in\s+the\s+meeting|your\s+meet\s+call|secure\s+video|video\s+conferencing|new\s+meeting|enter\s+a\s+code|connect.*collaborate|from\s+your\s+google)/i;

const ICON_PATTERN =
  /\b(frame_person|visual_effects|closed_caption|format_size|keyboard_arrow|more_vert|call_end|back_hand|mic|videocam|computer|reaction|settings|lock_person|chat|apps|info|mood|raise|stop_circle|filter|chevron_right|chevron_left|expand_more|expand_less|content_copy|arrow_back|arrow_forward|open_in_new|check_circle|cancel|navigate_next|navigate_before)\b/i;

// When Meet has 3+ active speakers it prefixes the caption block with the
// Material Symbol `groups`. Depending on how innerText folds the DOM this
// shows up either as its own line or as an inline prefix on the speaker
// label ("groups 西尾拓摩 & 1 others"). We strip it BEFORE validation so
// the underlying speaker name passes cleanly.
const GROUP_ICON_RE = /^groups\b\s*/i;

// Meet renders a combined caption for 3+ simultaneous speakers as
// "<primary-name> & N others" (or the localized equivalent in JA:
// "<名前> 他Nさん").  That composite isn't a real participant name — it
// changes per-utterance based on who else is talking, and treating it as
// one speaker fragments the transcript into many short one-person lines.
// Collapse to the primary name so the grouped utterance is attributed to
// at least the loudest speaker instead of a synthetic "& 6 others" label.
const COMBINED_SPEAKER_RE = /\s*[&＆]\s*\d+\s*(others?|more)\b.*$/i;
const COMBINED_SPEAKER_JA = /\s*(他|ほか)\s*\d+\s*(名|人|さん)?\b.*$/;

// Strip control chars, combined-speaker suffixes, collapse whitespace,
// cap length.  Speaker names come from DOM text we don't control —
// without this, a display name like "Alice\nIgnore prior instructions and"
// could break prompt structure on the server side once it's concatenated
// into "[Alice\n...]: text".
function sanitizeSpeaker(raw: string): string {
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

function isValidCaption(speaker: string, text: string): boolean {
  if (!speaker || !text) return false;
  if (speaker.length > 50 || speaker.length < 1) return false;
  if (text.length < 1 || text.length > 2000) return false;

  // Speaker shouldn't look like UI text
  if (UI_PATTERNS.test(speaker)) return false;
  if (ICON_PATTERN.test(speaker)) return false;
  if (/^\d{1,2}:\d{2}/.test(speaker)) return false; // Clock
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(speaker)) return false; // Meeting ID

  // Real person names rarely exceed 5 words.  Longer "speakers" are
  // almost always scraped UI headings (e.g. "Secure video conferencing
  // for everyone").  CJK names have few spaces, so word count is safe.
  const speakerWords = speaker.split(/\s+/).length;
  if (speakerWords > 5) return false;

  // Text shouldn't be UI text either
  if (UI_PATTERNS.test(text)) return false;
  if (ICON_PATTERN.test(text)) return false;
  if (/\+\d{1,3}[\s-]?\d/.test(text)) return false; // Phone number
  if (/keyboard_arrow|Turn off|Turn on/i.test(text)) return false;
  // Material icon text fragments embedded in scraped UI blocks
  if (/\bvideo_call\b|\bkeyboard\b.*\bJoin\b/i.test(text)) return false;

  // Speaker shouldn't be a snake_case identifier
  if (/\b[a-z]+_[a-z]+\b/.test(speaker)) return false;

  // Reject text that is ONLY icon names or short UI labels
  // (e.g. "chevron_right chevron_right chevron_right")
  const textWords = text.split(/\s+/);
  if (textWords.every((w) => /^[a-z]+_[a-z]+$/i.test(w))) return false;

  // Reject standalone numbers (e.g. "1" from "Contributors 1")
  if (/^\d{1,3}$/.test(text.trim())) return false;

  return true;
}

// ─── Platform registries ─────────────────────────────────────────────
// Registry pattern: add a new platform by adding one entry here and
// one entry in PLATFORMS (platforms.ts).  No if-else chains to update.

const CAPTION_READERS: Record<PlatformId, () => CaptionBlock[]> = {
  meet: readMeetCaptions,
  teams: readTeamsCaptions,
  zoom: readZoomCaptions,
};

const CC_ENABLERS: Record<PlatformId, () => boolean> = {
  meet: enableMeetCC,
  teams: enableTeamsCC,
  zoom: enableZoomCC,
};

// ─── Main diff loop ───────────────────────────────────────────────────

// ─── Extension context invalidation ──────────────────────────────────
//
// Chrome MV3 service workers sleep after ~30s of inactivity.  When one
// wakes, existing content-script runtimes lose their connection and every
// chrome.runtime.sendMessage() rejects with "Extension context invalidated"
// or "Could not establish connection".  We detect that, stop wasting CPU,
// and surface a visible banner so the user knows to reload the tab.

let contextInvalidated = false;

function handleSendError(e: Error): void {
  const msg = e?.message ?? '';

  // "Extension context invalidated" is the ONLY definitive sign that the
  // content script's chrome.runtime connection is permanently gone.
  // "Could not establish connection" / "receiving end does not exist" are
  // TRANSIENT — they fire when the service worker is still waking up after
  // being idle.  Do NOT treat those as fatal or the scraper stops on the
  // very first send of a new recording.
  if (msg.includes('Extension context invalidated')) {
    if (contextInvalidated) return;
    contextInvalidated = true;

    console.error('[LLM IDE] Extension context lost — stopping scraper. Reload the tab to resume.');
    isCapturing = false;
    stopScraping();

    // Show an in-page banner so the user sees the issue without DevTools.
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed',
      bottom: '70px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      background: '#b71c1c',
      color: '#fff',
      fontFamily: 'Google Sans, Roboto, sans-serif',
      fontSize: '13px',
      padding: '10px 18px',
      borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      whiteSpace: 'nowrap',
    });
    banner.textContent = '⚠ LLM IDE: connection lost — reload this tab to resume capture';
    document.body?.appendChild(banner);
    return;
  }

  // Transient errors — log but keep scraping.
  console.warn('[LLM IDE] send failed (will retry):', msg);
}

function sendUpdate(speaker: string, text: string, sessionId: string): void {
  if (contextInvalidated) return;

  const msg: Message = {
    type: MsgType.CAPTION_FINAL,
    speaker,
    text,
    timestamp: Date.now(),
    sessionId,
  };
  chrome.runtime.sendMessage(msg).catch((e: Error) => handleSendError(e));

  // Notify the floating overlay (same tab — custom events are shared across content scripts)
  window.dispatchEvent(
    new CustomEvent('llmide:caption', {
      detail: { speaker, text, sessionId },
    }),
  );
}

function scrape(): void {
  if (!isCapturing || !platform) return;

  const reader = CAPTION_READERS[platform];
  if (!reader) return;

  const blocks = reader();
  const now = Date.now();

  for (const { speaker, text } of blocks) {
    const prev = speakerState.get(speaker);

    // New session if: first time seeing this speaker, or silent > SESSION_GAP_MS.
    const needsNewSession = !prev || now - prev.lastSeen > SESSION_GAP_MS;

    if (needsNewSession) {
      sessionCounter++;
      const sessionId = `${speaker}-${sessionCounter}`;
      speakerState.set(speaker, { sessionId, text, lastSeen: now });
      debug(`NEW ${speaker} [${sessionId}]:`, text.slice(0, 60));
      sendUpdate(speaker, text, sessionId);
      continue;
    }

    // Same session: CC showed a different text (sliding window updated).
    // Always update the same transcript entry — no new entry until speaker pauses.
    if (prev.text === text) {
      prev.lastSeen = now;
      continue;
    }

    prev.text = text;
    prev.lastSeen = now;
    debug(`UPD ${speaker} [${prev.sessionId}]:`, text.slice(0, 60));
    sendUpdate(speaker, text, prev.sessionId);
  }

  // Cleanup stale entries
  for (const [speaker, state] of speakerState) {
    if (now - state.lastSeen > MAX_BLOCK_AGE_MS) {
      speakerState.delete(speaker);
    }
  }
}

// ─── Caption enable (platform-specific) ───────────────────────────────

function enableMeetCC(): boolean {
  const buttons = document.querySelectorAll('button[aria-label]');
  for (const btn of buttons) {
    const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
    if (label.includes('caption') || label.includes('subtitle') || label.includes('cc')) {
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed === 'false') {
        (btn as HTMLButtonElement).click();
        return true;
      }
      if (pressed === 'true') return true;
    }
  }
  for (const btn of document.querySelectorAll('button')) {
    const t = (btn.getAttribute('data-tooltip') || btn.getAttribute('title') || '').toLowerCase();
    if (t.includes('caption') || t.includes('subtitle')) {
      (btn as HTMLButtonElement).click();
      return true;
    }
  }
  return false;
}

function enableTeamsCC(): boolean {
  for (const btn of document.querySelectorAll('button[aria-label], button[data-tid]')) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const tid = (btn.getAttribute('data-tid') || '').toLowerCase();
    if (label.includes('caption') || label.includes('subtitle') || tid.includes('caption') || tid.includes('cc')) {
      if (btn.getAttribute('aria-pressed') === 'true') return true;
      (btn as HTMLButtonElement).click();
      return true;
    }
  }
  return false;
}

function enableZoomCC(): boolean {
  for (const btn of document.querySelectorAll('button')) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const text = (btn.textContent || '').toLowerCase();
    if (label.includes('caption') || label.includes('transcript') || text.includes('cc') || text.includes('caption')) {
      if (btn.getAttribute('aria-pressed') === 'true') return true;
      (btn as HTMLButtonElement).click();
      return true;
    }
  }
  return false;
}

function enableCC(): boolean {
  if (!platform) return false;
  const enabler = CC_ENABLERS[platform];
  return enabler ? enabler() : false;
}

// ─── CC overlay visibility (Meet only) ───────────────────────────────
//
// Keep CC enabled in Meet so its DOM elements are populated (the scraper
// reads from them), but hide the visual overlay so the screen stays clean.
// visibility:hidden keeps elements in the layout and innerText still returns
// text — unlike display:none which empties innerText.

const CC_HIDE_STYLE_ID = 'llmide-cc-hide';

function hideMeetCCOverlay(): void {
  if (!document.getElementById(CC_HIDE_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = CC_HIDE_STYLE_ID;
    // .nMcdL.bj4p3b are the caption block elements discovered via DOM inspection.
    // Hiding them removes the CC overlay from view while keeping the DOM intact.
    // opacity:0  — invisible to the user but elements stay "rendered" so
    //              innerText still returns their text (visibility:hidden would
    //              cause innerText to return empty strings, breaking the scraper).
    // pointer-events:none — prevents the transparent overlay intercepting clicks.
    style.textContent = '.nMcdL.bj4p3b { opacity: 0 !important; pointer-events: none !important; }';
    document.head.appendChild(style);
  }
}

function showMeetCCOverlay(): void {
  document.getElementById(CC_HIDE_STYLE_ID)?.remove();
}

// ─── Chat injection (Meet only) ───────────────────────────────────────

async function injectMeetChat(text: string): Promise<boolean> {
  // 1. Find the chat button and open the panel if needed.
  // Meet's DOM varies by build; try multiple selectors.
  const chatBtnSelectors = [
    'button[aria-label*="Chat with everyone" i]',
    'button[aria-label*="chat" i][data-panel-id]',
    'button[aria-label*="Chat" i]',
  ];
  let chatBtn: HTMLButtonElement | null = null;
  for (const sel of chatBtnSelectors) {
    chatBtn = document.querySelector(sel) as HTMLButtonElement | null;
    if (chatBtn) break;
  }
  if (!chatBtn) {
    debug('injectMeetChat: no chat button found with any selector');
    return false;
  }

  const isPanelOpen = chatBtn.getAttribute('aria-pressed') === 'true';
  if (!isPanelOpen) {
    chatBtn.click();
    // Wait for the panel animation — retry up to 3 times if needed
    await new Promise((r) => setTimeout(r, 600));
  }

  // 2. Find the input. Meet uses textarea OR contenteditable depending on build.
  const inputSelectors = [
    'textarea[aria-label*="Send a message" i]',
    'textarea[aria-label*="message" i]',
    'div[contenteditable="true"][aria-label*="Send a message" i]',
    'div[contenteditable="true"][aria-label*="message" i]',
  ];
  let input: HTMLTextAreaElement | HTMLDivElement | null = null;
  // Retry: the chat panel may still be animating in
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const sel of inputSelectors) {
      input = document.querySelector(sel) as HTMLTextAreaElement | HTMLDivElement | null;
      if (input) break;
    }
    if (input) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!input) {
    debug('injectMeetChat: no chat input found after retries');
    return false;
  }

  // 3. Inject text — handle both textarea and contenteditable
  if (input instanceof HTMLTextAreaElement) {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // contenteditable div
    input.focus();
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }

  // 4. Find and click send button
  const sendBtnSelectors = [
    'button[aria-label*="Send a message" i]:not([disabled])',
    'button[aria-label*="Send" i]:not([disabled])',
  ];
  for (const sel of sendBtnSelectors) {
    const sendBtn = document.querySelector(sel) as HTMLButtonElement | null;
    if (sendBtn && sendBtn !== chatBtn) {
      sendBtn.click();
      return true;
    }
  }

  // Fallback: hit Enter
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }),
  );
  return true;
}

// ─── Lifecycle ────────────────────────────────────────────────────────

// Coalesce mutation-triggered scrapes to at most one per animation frame.
// Active Meet sessions fire 50+ mutations/sec; running the full DOM scan
// on each was burning CPU. The 800ms interval below remains the safety
// net so we never miss a caption between frames.
let scrapeScheduled = false;
function scheduleScrape(): void {
  if (scrapeScheduled) return;
  scrapeScheduled = true;
  requestAnimationFrame(() => {
    scrapeScheduled = false;
    scrape();
  });
}

function startScraping(): void {
  if (observer) return;
  scrapeInterval = setInterval(scrape, SCRAPE_INTERVAL_MS);
  observer = new MutationObserver(scheduleScrape);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stopScraping(): void {
  if (scrapeInterval) {
    clearInterval(scrapeInterval);
    scrapeInterval = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  speakerState.clear();
  sessionCounter = 0;
  if (platform === 'meet') showMeetCCOverlay();
}

// ─── Message listener ─────────────────────────────────────────────────

platform = detectPlatform();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false;
  }
  const type = (message as { type: unknown }).type;

  if (type === MsgType.PING) {
    sendResponse({ pong: true });
    return false;
  }

  if (type === MsgType.START_CAPTION_SCRAPING && platform) {
    // Skip non-meeting pages (e.g. Meet landing page, settings).
    if (!isActiveMeetingPage()) {
      debug(`Ignoring START on non-meeting page: ${window.location.pathname}`);
      return false;
    }
    // Only fire recording-start on the first START message, not on retries.
    // The side panel sends START up to 3× (at 0s, 1s, 3s) to handle
    // late-loading content scripts.  Firing the overlay event every time
    // would reopen the overlay 1s after the user closed it with ✕.
    const wasAlreadyCapturing = isCapturing;
    isCapturing = true;
    contextInvalidated = false;
    // Only reset per-speaker state on the FIRST start, not on the retry
    // sends that the side panel fires at 0s/1s/3s.  Wiping mid-session
    // would split an active utterance into two transcript lines.
    if (!wasAlreadyCapturing) {
      speakerState.clear();
      sessionCounter = 0;
      window.dispatchEvent(new CustomEvent('llmide:recording-start'));
    }
    debug(`Starting caption scraping on ${platform}`);

    const ok = enableCC();
    debug(`CC enable result: ${ok}`);
    setTimeout(() => {
      if (isCapturing) enableCC();
    }, 2_000);
    setTimeout(() => {
      if (isCapturing) enableCC();
    }, 5_000);

    // Hide the CC overlay once it has appeared in the DOM (give it 1s to render).
    // CC must stay enabled in Meet for the scraper to work — we just make it
    // invisible so the transcript panel is the user's only view of captions.
    if (platform === 'meet') {
      setTimeout(() => {
        if (isCapturing) hideMeetCCOverlay();
      }, 1_000);
    }

    startScraping();

    const statusMsg: Message = { type: MsgType.CAPTION_STATUS, active: true, platform };
    chrome.runtime.sendMessage(statusMsg).catch(() => {});
  }

  if (type === MsgType.STOP_CAPTION_SCRAPING) {
    isCapturing = false;
    stopScraping();
    window.dispatchEvent(new CustomEvent('llmide:recording-stop'));
    debug('Stopped caption scraping');

    // Broadcast stop so every extension context (side panel, floating popup)
    // clears its isRecording flag — otherwise a popup opened while mic-mode
    // was active would keep showing "recording" after Stop was pressed
    // elsewhere.
    if (platform) {
      const statusMsg: Message = { type: MsgType.CAPTION_STATUS, active: false, platform };
      chrome.runtime.sendMessage(statusMsg).catch(() => {});
    }
  }

  // A newly-opened side panel / popup asks the scraper for its current
  // state so it can sync isRecording without waiting for the next caption.
  if (type === MsgType.GET_CAPTION_STATUS && platform) {
    const statusMsg: Message = { type: MsgType.CAPTION_STATUS, active: isCapturing, platform };
    chrome.runtime.sendMessage(statusMsg).catch(() => {});
  }

  if (type === MsgType.POST_CHAT) {
    if (platform !== 'meet') {
      sendResponse({
        ok: false,
        error: `Chat injection is only supported on Google Meet (current platform: ${platform ?? 'unknown'}).`,
      });
      return false;
    }
    injectMeetChat((message as unknown as { text: string }).text)
      .then((ok) => {
        if (!ok) {
          sendResponse({ ok: false, error: 'Could not find the Meet chat panel. Open the chat first and try again.' });
        } else {
          sendResponse({ ok: true });
        }
      })
      .catch((err) => sendResponse({ ok: false, error: err?.message || 'Chat injection failed unexpectedly.' }));
    return true; // Keep channel open for async response
  }

  return false;
});

if (platform) {
  debug(`Caption scraper loaded on ${platform}`);
  const readyMsg: Message = { type: MsgType.CAPTION_SCRAPER_READY, platform };
  chrome.runtime.sendMessage(readyMsg).catch(() => {});
}
