// Pure helpers for the side panel's persisted UI preferences. The extension
// stores no meeting data of its own (live-then-archive rule 5): speaker names
// and pinned question participants are meeting content, so they live in memory
// only, and any copy an older build wrote is purged. Types only at runtime
// (loadable by the Node test runner).

export type QuestionType = 'conflict' | 'confirm' | 'explain';
export const DEFAULT_QUESTION_TYPES: QuestionType[] = ['conflict', 'confirm'];

/** chrome.storage.local keys older builds used for meeting content (speaker id -> name). */
export const LEGACY_MEETING_STORAGE_KEYS = ['speakerNames'];

export interface PrefsStorageArea {
  remove(keys: string | string[]): Promise<void>;
}

/** Removes meeting content an older build persisted. Never throws. */
export async function purgeLegacyMeetingKeys(area: PrefsStorageArea | undefined): Promise<void> {
  if (!area) return;
  try {
    await area.remove(LEGACY_MEETING_STORAGE_KEYS);
  } catch {
    /* nothing to purge or storage unavailable */
  }
}

/** Reads the saved blob: only the question types survive; `dirty` says an old blob held participant names. */
export function parseQuestionPrefs(raw: string | null): { types: QuestionType[]; dirty: boolean } {
  if (!raw) return { types: DEFAULT_QUESTION_TYPES, dirty: false };
  try {
    const j = JSON.parse(raw);
    const types = Array.isArray(j?.types)
      ? j.types.filter((t: unknown): t is QuestionType => t === 'conflict' || t === 'confirm' || t === 'explain')
      : DEFAULT_QUESTION_TYPES;
    return {
      types: types.length ? types : DEFAULT_QUESTION_TYPES,
      dirty: Object.keys(j ?? {}).some((k) => k !== 'types'),
    };
  } catch {
    return { types: DEFAULT_QUESTION_TYPES, dirty: true };
  }
}

/** The only thing persisted: the question types. Participant names are never written. */
export function serializeQuestionPrefs(types: QuestionType[]): string {
  return JSON.stringify({ types });
}
