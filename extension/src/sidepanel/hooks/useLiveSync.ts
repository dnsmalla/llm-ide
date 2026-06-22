import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch, getServerUrl } from '../../lib/config';
import type { TranscriptSegment } from './useTranscript';

const PUSH_DEBOUNCE_MS = 800;
const FAILURE_THRESHOLD = 3;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;

export type SyncStatus = 'idle' | 'synced' | 'error';

export interface LiveSyncState {
  isRecording: boolean;
  sessionId: string;
  meetingTitle?: string;
  segments: TranscriptSegment[];
}

export interface LiveSyncResult {
  syncStatus: SyncStatus;
  consecutiveFailures: number;
  resetSyncError: () => void;
}

export function useLiveSync({ isRecording, sessionId, meetingTitle, segments }: LiveSyncState): LiveSyncResult {
  const lastPushedIndex = useRef(0);
  // Text last pushed for each segment index, so an in-place edit to ANY
  // segment (not just the trailing one) is detected and re-pushed.
  const lastPushedTexts = useRef<string[]>([]);
  const lastSessionId = useRef('');
  const debounceHandle = useRef<number | null>(null);
  const retryHandle = useRef<number | null>(null);
  const failureCount = useRef(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  // Stable refs for the retry timer to read current values without
  // re-registering the effect on every segment change.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const meetingTitleRef = useRef(meetingTitle);
  meetingTitleRef.current = meetingTitle;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const clearRetry = useCallback(() => {
    if (retryHandle.current) {
      window.clearTimeout(retryHandle.current);
      retryHandle.current = null;
    }
  }, []);

  const markSuccess = useCallback(() => {
    failureCount.current = 0;
    setConsecutiveFailures(0);
    setSyncStatus('synced');
    clearRetry();
  }, [clearRetry]);

  const markFailure = useCallback(() => {
    failureCount.current += 1;
    setConsecutiveFailures(failureCount.current);
    if (failureCount.current >= FAILURE_THRESHOLD) {
      setSyncStatus('error');
    }
  }, []);

  const scheduleRetry = useCallback(() => {
    clearRetry();
    const delay = Math.min(RETRY_BASE_MS * Math.pow(2, failureCount.current - 1), RETRY_MAX_MS);
    retryHandle.current = window.setTimeout(() => {
      retryHandle.current = null;
      const sid = sessionIdRef.current;
      const segs = segmentsRef.current;
      const title = meetingTitleRef.current;
      if (!sid || segs.length === 0) return;
      pushPendingSegments(sid, segs, title, lastPushedIndex, lastPushedTexts)
        .then(markSuccess)
        .catch(() => {
          markFailure();
          scheduleRetry();
        });
    }, delay);
  }, [clearRetry, markSuccess, markFailure]);

  const resetSyncError = useCallback(() => {
    failureCount.current = 0;
    setConsecutiveFailures(0);
    setSyncStatus(isRecording ? 'synced' : 'idle');
    clearRetry();
    // Immediately try pushing queued segments on manual retry.
    if (isRecording) {
      const sid = sessionIdRef.current;
      const segs = segmentsRef.current;
      const title = meetingTitleRef.current;
      if (sid && segs.length > 0) {
        pushPendingSegments(sid, segs, title, lastPushedIndex, lastPushedTexts)
          .then(markSuccess)
          .catch(() => {
            markFailure();
            scheduleRetry();
          });
      }
    }
  }, [isRecording, clearRetry, markSuccess, markFailure, scheduleRetry]);

  useEffect(() => {
    if (sessionId !== lastSessionId.current) {
      lastSessionId.current = sessionId;
      lastPushedIndex.current = 0;
      lastPushedTexts.current = [];
      failureCount.current = 0;
      setConsecutiveFailures(0);
      setSyncStatus('idle');
      clearRetry();
    }
  }, [sessionId, clearRetry]);

  useEffect(() => {
    if (!isRecording) return;
    if (debounceHandle.current) {
      window.clearTimeout(debounceHandle.current);
    }
    debounceHandle.current = window.setTimeout(() => {
      pushPendingSegments(sessionId, segments, meetingTitle, lastPushedIndex, lastPushedTexts)
        .then(markSuccess)
        .catch(() => {
          markFailure();
          scheduleRetry();
        });
    }, PUSH_DEBOUNCE_MS);
    return () => {
      if (debounceHandle.current) {
        window.clearTimeout(debounceHandle.current);
        debounceHandle.current = null;
      }
    };
  }, [isRecording, sessionId, segments, meetingTitle, markSuccess, markFailure, scheduleRetry]);

  useEffect(() => {
    if (isRecording || !sessionId) return;
    clearRetry();
    // Only finalize if there is actually something to save.
    // Calling finalize on an empty session creates an orphaned DB row
    // with no transcript that then shows up as a blank meeting card.
    if (segments.length === 0) {
      setSyncStatus('idle');
      return;
    }
    pushPendingSegments(sessionId, segments, meetingTitle, lastPushedIndex, lastPushedTexts)
      .catch(() => {})
      .finally(async () => {
        try {
          const serverUrl = await getServerUrl();
          await authFetch(`${serverUrl}/kb/live/${encodeURIComponent(sessionId)}/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
        } catch {
          /* ignore */
        }
        setSyncStatus('idle');
      });
    // deps intentionally narrow — re-run only on recording transitions
  }, [isRecording]);

  // Clean up retry timer on unmount.
  useEffect(() => clearRetry, [clearRetry]);

  return { syncStatus, consecutiveFailures, resetSyncError };
}

async function pushPendingSegments(
  sessionId: string,
  segments: TranscriptSegment[],
  meetingTitle: string | undefined,
  lastPushedIndex: { current: number },
  lastPushedTexts: { current: string[] },
) {
  if (!sessionId || segments.length === 0) return;

  // Push every segment that is NEW (index >= lastPushedIndex) OR whose text
  // changed in place since we last pushed it. In-place growth of a non-last
  // segment happens whenever speakers interleave — useTranscript merges a
  // caption back into an earlier segment by sessionId (see useTranscript.ts),
  // so checking only the trailing segment (the old behaviour) silently dropped
  // those edits, leaving the mirrored/persisted transcript truncated. The
  // server dedupes by (speaker, text) within a window, so re-sending an
  // unchanged segment is a no-op; we only send real changes.
  const toPush: Array<{ speaker: string; text: string; ts: number; source: string }> = [];
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    if (!s.speaker || !s.text) continue;
    const isNew = i >= lastPushedIndex.current;
    const changed = s.text !== lastPushedTexts.current[i];
    if (isNew || changed) {
      toPush.push({
        speaker: s.speaker,
        text: s.text,
        ts: s.timestamp,
        source: 'extension-cc',
      });
    }
  }
  if (toPush.length === 0) return;

  const serverUrl = await getServerUrl();
  await authFetch(`${serverUrl}/kb/live/${encodeURIComponent(sessionId)}/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ captions: toPush, meetingTitle: meetingTitle || '' }),
  });

  lastPushedIndex.current = segments.length;
  // Snapshot current text per index so the next push only re-sends real edits.
  lastPushedTexts.current = segments.map((s) => s.text || '');
}
