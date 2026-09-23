// Keep storage.ts free of runtime dependencies on the sidepanel hook
// (type-only import avoids a circular runtime graph via useTranscript →
// storage → useTranscript).
import type { TranscriptSegment } from '../sidepanel/hooks/useTranscript';

// Cap the number of past meetings we keep.  chrome.storage.local has a
// ~5 MB per-extension quota; long meetings can be ~200 KB each, so this
// is the limit that keeps us comfortably under the quota even on heavy
// use.  Oldest entries are pruned first.
const MAX_TRANSCRIPTS = 50;
const STORAGE_KEY = 'transcripts';
// One key per recording session (`transcriptDraft:<id>`), so two side panels
// recording at once never overwrite each other's draft.
const DRAFT_PREFIX = 'transcriptDraft:';
// A live panel rewrites its draft every few seconds while captions arrive;
// one untouched this long belongs to a panel that is gone (closed, crashed,
// browser quit) and is safe to recover.
export const DRAFT_STALE_MS = 2 * 60 * 1000;

interface SavedTranscript {
  id: string; // UUID-ish — `${startedAt}-${random}`
  meetingTitle: string;
  date: string; // ISO timestamp when stopRecording fired
  duration: number; // seconds of elapsed recording
  language?: string; // primary language at save time
  transcript: string; // pre-rendered `[Name] text` string
  segments: TranscriptSegment[]; // raw segments, lets us restore UI exactly
  speakerNames: Record<string, string>; // speaker-id → display name map
  notes?: string; // room for future "save notes with transcript" flow
}

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${Date.now()}-${rand}`;
}

export class StorageQuotaError extends Error {
  saved: SavedTranscript;
  constructor(message: string, saved: SavedTranscript) {
    super(message);
    this.name = 'StorageQuotaError';
    this.saved = saved;
  }
}

export async function saveTranscript(input: Omit<SavedTranscript, 'id'> & { id?: string }): Promise<SavedTranscript> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const transcripts: SavedTranscript[] = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  const saved: SavedTranscript = { ...input, id: input.id || generateId() };
  // Upsert by id: a session's final save and a recovered draft of the same
  // session (see recoverTranscriptDrafts) must not both land as entries.
  const existing = transcripts.findIndex((t) => t?.id === saved.id);
  if (existing !== -1) transcripts.splice(existing, 1);
  transcripts.unshift(saved);
  if (transcripts.length > MAX_TRANSCRIPTS) {
    transcripts.length = MAX_TRANSCRIPTS;
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: transcripts });
  } catch (err) {
    // QUOTA_BYTES exceeded: drop the oldest half and retry once so the
    // newest meeting still lands.  If THAT also fails, surface a typed
    // error so the UI can flash a "transcript not saved" warning
    // instead of silently losing it (previous behavior).
    const msg = (err as Error)?.message || String(err);
    const trimmed = transcripts.slice(0, Math.max(1, Math.floor(MAX_TRANSCRIPTS / 2)));
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
      return saved;
    } catch {
      throw new StorageQuotaError(`Could not persist transcript (chrome.storage.local quota): ${msg}`, saved);
    }
  }
  return saved;
}

// ─── Crash-safe drafts ────────────────────────────────────────────────
//
// saveTranscript() runs on Stop only. Closing the side panel, a crash, or
// quitting the browser mid-meeting used to lose the whole transcript. While
// recording, useTranscript checkpoints the session here; Stop saves it for
// real and clears the draft, and the next panel to open recovers any draft
// whose panel never got to Stop.

type TranscriptInput = Omit<SavedTranscript, 'id'> & { id: string };
type Draft = TranscriptInput & { updatedAt: number };

export async function saveTranscriptDraft(input: TranscriptInput, now = Date.now()): Promise<void> {
  const draft: Draft = { ...input, updatedAt: now };
  await chrome.storage.local.set({ [DRAFT_PREFIX + input.id]: draft });
}

export async function clearTranscriptDraft(id: string): Promise<void> {
  await chrome.storage.local.remove(DRAFT_PREFIX + id);
}

/**
 * Move every stale draft into the saved list (same id, so a session whose
 * final save already landed is not duplicated) and delete it. Drafts still
 * being written by a live panel are left alone. Returns what was recovered,
 * oldest first (by last checkpoint).
 */
export async function recoverTranscriptDrafts(now = Date.now()): Promise<SavedTranscript[]> {
  const all: Record<string, unknown> = await chrome.storage.local.get(null);
  const recovered: SavedTranscript[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(DRAFT_PREFIX)) continue;
    const draft = value as Partial<Draft> | null;
    const updatedAt = typeof draft?.updatedAt === 'number' ? draft.updatedAt : 0;
    if (now - updatedAt < DRAFT_STALE_MS) continue;
    if (draft && Array.isArray(draft.segments) && draft.segments.length > 0 && typeof draft.id === 'string') {
      const { updatedAt: _updatedAt, ...rest } = draft as Draft;
      // A failed save keeps the draft so the next open can try again.
      recovered.push(await saveTranscript({ ...rest, date: rest.date || new Date(updatedAt || now).toISOString() }));
    }
    await chrome.storage.local.remove(key);
  }
  return recovered.sort((a, b) => a.date.localeCompare(b.date));
}
