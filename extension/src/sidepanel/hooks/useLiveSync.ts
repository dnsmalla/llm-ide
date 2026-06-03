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

export function useLiveSync({
  isRecording, sessionId, meetingTitle, segments,
}: LiveSyncState): LiveSyncResult {
  const lastPushedIndex = useRef(0);
  const lastPushedTextForLast = useRef('');
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
      pushPendingSegments(sid, segs, title, lastPushedIndex, lastPushedTextForLast)
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
        pushPendingSegments(sid, segs, title, lastPushedIndex, lastPushedTextForLast)
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
      lastPushedTextForLast.current = '';
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
      pushPendingSegments(sessionId, segments, meetingTitle, lastPushedIndex, lastPushedTextForLast)
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
    pushPendingSegments(sessionId, segments, meetingTitle, lastPushedIndex, lastPushedTextForLast)
      .catch(() => {})
      .finally(async () => {
        try {
          const serverUrl = await getServerUrl();
          await authFetch(`${serverUrl}/kb/live/${encodeURIComponent(sessionId)}/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
        } catch { /* ignore */ }
        setSyncStatus('idle');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  lastPushedTextForLast: { current: string },
) {
  if (!sessionId || segments.length === 0) return;

  // What's new: every segment from lastPushedIndex onward, PLUS the
  // current last segment if its text changed since we last pushed it
  // (that handles the in-progress utterance whose text grows in
  // place).  We dedupe by (speaker, text) on the server, but keeping
  // the client side cheap means fewer wasted requests.
  const toPush: Array<{ speaker: string; text: string; ts: number; source: string }> = [];
  for (let i = lastPushedIndex.current; i < segments.length; i += 1) {
    const s = segments[i];
    if (!s.speaker || !s.text) continue;
    toPush.push({
      speaker: s.speaker,
      text: s.text,
      ts: s.timestamp,
      source: 'extension-cc',
    });
  }
  // If no new index but the last segment's text grew, push that too.
  if (toPush.length === 0 && segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last.text && last.text !== lastPushedTextForLast.current) {
      toPush.push({
        speaker: last.speaker || 'Unknown',
        text: last.text,
        ts: last.timestamp,
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
  if (segments.length > 0) {
    lastPushedTextForLast.current = segments[segments.length - 1].text || '';
  }
}
