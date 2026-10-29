// The extension's old local chat buffer (`chatMessages`, up to 200 messages).
// Q18 removes it, but it can be the ONLY copy of a conversation (it was written
// whenever the server session could not be created), so it is never deleted
// blind: removed only after the server was reached and the buffer is empty, or
// after the user exported or discarded it. The cached session id is only a
// pointer and goes freely. Types only: loadable by the Node test runner.

export interface LegacyChatMessage {
  role: string;
  content: string;
  timestamp?: number;
}

export interface LegacyChatArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  remove(keys: string | string[]): Promise<void>;
}

export const LEGACY_CHAT_KEY = 'chatMessages';
export const LEGACY_SESSION_POINTER_KEY = 'unifiedChatSessionId';

/**
 * Returns the messages that are still only local (to offer Export), or [] when
 * nothing is left. Never throws.
 */
export async function settleLegacyChat(area: LegacyChatArea, serverReached: boolean): Promise<LegacyChatMessage[]> {
  try {
    await area.remove(LEGACY_SESSION_POINTER_KEY);
  } catch {
    /* a pointer only */
  }
  let messages: LegacyChatMessage[] = [];
  try {
    const r = await area.get(LEGACY_CHAT_KEY);
    const v = r?.[LEGACY_CHAT_KEY];
    if (Array.isArray(v)) messages = v.filter((m) => m && typeof m.content === 'string');
    else if (v === undefined) return [];
  } catch {
    return []; // cannot read: leave it alone
  }
  if (messages.length > 0) return messages; // the only copy: keep, whatever the server state
  if (!serverReached) return []; // empty, but do not touch anything before the server answered
  try {
    await area.remove(LEGACY_CHAT_KEY);
  } catch {
    /* harmless: an empty list */
  }
  return [];
}

/** After the user exported or discarded the buffer. */
export async function discardLegacyChat(area: LegacyChatArea): Promise<void> {
  await area.remove(LEGACY_CHAT_KEY);
}

export function legacyChatJson(messages: LegacyChatMessage[]): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), messages }, null, 2);
}
