export enum MsgType {
  // Side panel → content script
  START_CAPTION_SCRAPING = 'START_CAPTION_SCRAPING',
  STOP_CAPTION_SCRAPING = 'STOP_CAPTION_SCRAPING',
  GET_CAPTION_STATUS = 'GET_CAPTION_STATUS',
  PING = 'PING',

  // Content script → service worker (popup management)
  OPEN_POPUP = 'OPEN_POPUP',

  // Content script → side panel
  CAPTION_FINAL = 'CAPTION_FINAL',
  CAPTION_STATUS = 'CAPTION_STATUS',
  CAPTION_SCRAPER_READY = 'CAPTION_SCRAPER_READY',
  ACTIVE_SPEAKER = 'ACTIVE_SPEAKER',
  PARTICIPANTS_LIST = 'PARTICIPANTS_LIST',
  POST_CHAT = 'POST_CHAT',
}

export type Message =
  | { type: MsgType.START_CAPTION_SCRAPING }
  | { type: MsgType.STOP_CAPTION_SCRAPING }
  | { type: MsgType.GET_CAPTION_STATUS }
  | { type: MsgType.PING }
  | { type: MsgType.OPEN_POPUP }
  | { type: MsgType.CAPTION_FINAL; speaker: string; text: string; timestamp: number; sessionId: string }
  | { type: MsgType.CAPTION_STATUS; active: boolean; platform: string | null }
  | { type: MsgType.CAPTION_SCRAPER_READY; platform: string | null }
  | { type: MsgType.ACTIVE_SPEAKER; speaker: string }
  | { type: MsgType.PARTICIPANTS_LIST; participants: string[] }
  | { type: MsgType.POST_CHAT; text: string };

export function isMessage(obj: unknown): obj is Message {
  if (typeof obj !== 'object' || obj === null || !('type' in obj)) return false;
  const t = (obj as { type: unknown }).type;
  if (typeof t !== 'string' || !Object.values(MsgType).includes(t as MsgType)) return false;
  // Per-variant payload validation — previously the function only
  // checked `type` membership and downstream handlers crashed with
  // `undefined.length` on malformed messages.  Untrusted senders
  // (other extensions, page-script bridges) can now be rejected at
  // the guard instead of crashing the side panel.
  const m = obj as Record<string, unknown>;
  const s = (k: string) => typeof m[k] === 'string';
  const n = (k: string) => typeof m[k] === 'number';
  const b = (k: string) => typeof m[k] === 'boolean';
  const a = (k: string) => Array.isArray(m[k]);
  // Lenient string check: accept the empty string AND null/undefined
  // because the caption scraper legitimately sends platform=null
  // before detection completes.  Anything that isn't a string OR a
  // nullish is rejected.
  const sOrNull = (k: string) => m[k] === null || m[k] === undefined || typeof m[k] === 'string';
  switch (t as MsgType) {
    case MsgType.CAPTION_FINAL:
      return s('speaker') && s('text') && n('timestamp') && s('sessionId');
    case MsgType.CAPTION_STATUS:
      // platform may be null while detection is in flight — the side
      // panel relies on this message to flip its captureMode, so
      // dropping it strands every subsequent CAPTION_FINAL.
      return b('active') && sOrNull('platform');
    case MsgType.CAPTION_SCRAPER_READY:
      return sOrNull('platform');
    case MsgType.ACTIVE_SPEAKER:
      return s('speaker');
    case MsgType.PARTICIPANTS_LIST:
      return a('participants') && (m.participants as unknown[]).every((p) => typeof p === 'string');
    case MsgType.POST_CHAT:
      return s('text');
    // Payload-less control messages.
    case MsgType.START_CAPTION_SCRAPING:
    case MsgType.STOP_CAPTION_SCRAPING:
    case MsgType.GET_CAPTION_STATUS:
    case MsgType.PING:
    case MsgType.OPEN_POPUP:
      return true;
  }
  return false;
}
