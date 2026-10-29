// Browser wiring for capture-store.ts: the real chrome.storage area and the
// /kb/live/* API over authFetch. Kept apart so capture-store stays testable.
import { authFetch, getServerUrl } from './config';
import type { AppendResult, FinalizeResult, LiveApi, LiveState, StatusResult, StorageArea } from './capture-store';

const STATES: readonly string[] = ['live', 'finalized', 'acked', 'expired', 'unknown'];

export function chromeArea(): StorageArea {
  return chrome.storage.local as unknown as StorageArea;
}

/** Single-flight across side panels/tabs; null when another holder has it. */
export function lockRunner(name: string): <T>(fn: () => Promise<T>) => Promise<T | null> {
  return async <T>(fn: () => Promise<T>) => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) return fn();
    return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? fn() : null));
  };
}

const enc = encodeURIComponent;

export const httpLiveApi: LiveApi = {
  async status(id): Promise<StatusResult> {
    try {
      const base = await getServerUrl();
      const r = await authFetch(`${base}/kb/live/${enc(id)}/status`);
      if (!r.ok) return { ok: false }; // 404 = no ack feature; 5xx/503 = unreachable: keep the draft
      const d = await r.json();
      if (typeof d?.state !== 'string' || !STATES.includes(d.state)) return { ok: false };
      return { ok: true, state: d.state as LiveState, durable: d.durable === true };
    } catch {
      return { ok: false };
    }
  },
  async append(id, meetingTitle, captions): Promise<AppendResult> {
    try {
      const base = await getServerUrl();
      const r = await authFetch(`${base}/kb/live/${enc(id)}/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captions, meetingTitle }),
      });
      if (!r.ok) return { ok: false, accepted: 0, finalized: false };
      const d = await r.json();
      return { ok: true, accepted: Number(d?.accepted) || 0, finalized: d?.finalized === true };
    } catch {
      return { ok: false, accepted: 0, finalized: false };
    }
  },
  async finalize(id): Promise<FinalizeResult> {
    try {
      const base = await getServerUrl();
      const r = await authFetch(`${base}/kb/live/${enc(id)}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) return { ok: false, ackRequired: false, captionCount: 0, durable: false };
      const d = await r.json();
      return {
        ok: true,
        ackRequired: d?.ackRequired === true,
        captionCount: Number(d?.captionCount) || 0,
        durable: d?.durable === true,
      };
    } catch {
      return { ok: false, ackRequired: false, captionCount: 0, durable: false };
    }
  },
};
