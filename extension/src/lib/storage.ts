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
