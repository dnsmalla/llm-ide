// Hook for the meeting-agent feature — co-pilot mode.
//
// "Send agent" attaches the server-side question loop to whichever
// live capture session the user already has running (the extension
// is pushing captions to /kb/live/<sessionId>/append; the agent
// reads from and writes back to that same stream).  No bot, no
// third-party transport — just an LLM watching the transcript.

import { useCallback, useEffect, useState } from 'react';
import { authFetch, getServerUrl } from '../../lib/config';
import { isSupportedUrl } from '../../lib/platforms';

export interface AgentDecision {
  reason: string;
  score: number | null;
  asked: boolean;
}

export interface AgentRun {
  sessionId: string;
  planId: string | null;
  startedAt: number;
  lastTickAt: number | null;
  lastDecision: AgentDecision | null;
}

export interface AgentDispatchResponse {
  sessionId: string;
  planId: string | null;
  attached: boolean;
  reason?: string;
}

// Platform URL detection is now centralized in platforms.ts.
// isSupportedUrl handles null/undefined and malformed URLs.

export function useAgent({
  isRecording, language, sessionId,
}: {
  isRecording: boolean;
  language?: string;
  /** The extension's own session id — passed on every dispatch so the
   *  agent attaches even before useLiveSync has had time to push the
   *  first caption (which is what creates the server-side session). */
  sessionId?: string;
}) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeMeetingUrl, setActiveMeetingUrl] = useState<string | null>(null);

  // Watch the foreground tab to detect if we are in a meeting.
  // This helps the UI decide which labels to show (Attach Assistant
  // vs Start Co-pilot).
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (cancelled) return;
        setActiveMeetingUrl(isSupportedUrl(tab?.url) ? tab!.url! : null);
      } catch {
        if (!cancelled) setActiveMeetingUrl(null);
      }
    }
    refresh();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, 300);
    };
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(debouncedRefresh);
    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(debouncedRefresh);
    };
  }, []);

  // Lightweight poll — every 4s while at least one run is in
  // flight, every 10s otherwise.  Cheap (single GET).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    async function tick() {
      try {
        const serverUrl = await getServerUrl();
        const r = await authFetch(`${serverUrl}/kb/agent/runs`);
        if (!r.ok) throw new Error(`runs ${r.status}`);
        const json = await r.json();
        if (cancelled) return;
        setRuns(Array.isArray(json.runs) ? json.runs : []);
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
      }
      if (!cancelled) {
        const baseMs = runs.length > 0 ? 4000 : 10000;
        const backoff = Math.min(baseMs * Math.pow(2, consecutiveFailures), 30_000);
        timer = setTimeout(tick, backoff);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runs.length]);

  const dispatch = useCallback(async (
    planId: string | null = null,
    /** Override the auto-detected meeting URL.  When undefined we
     *  use whatever chrome.tabs.query found.  When explicitly null,
     *  send no URL (forces co-pilot mode).  When a string, that
     *  exact value is sent — the editor uses this. */
    meetingUrlOverride?: string | null,
  ): Promise<AgentDispatchResponse | null> => {
    if (!isRecording) {
      setError('Start recording first — the agent attaches to your live capture.');
      return null;
    }
    const meetingUrlToSend = meetingUrlOverride === undefined
      ? (activeMeetingUrl || undefined)
      : (meetingUrlOverride || undefined);
    setBusy(true);
    setError(null);
    try {
      const serverUrl = await getServerUrl();
      // No sessionId in the body — the server picks the user's most
      // recently-active live session, which is the one the extension
      // is currently writing to.
      const r = await authFetch(`${serverUrl}/kb/agent/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId || undefined,
          planId,
          language: language || 'en',
          meetingUrl: meetingUrlToSend,
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`dispatch ${r.status}: ${text.slice(0, 200)}`);
      }
      const json: AgentDispatchResponse = await r.json();
      setRuns((prev) => [
        ...prev,
        {
          sessionId: json.sessionId, planId,
          startedAt: Date.now(),
          lastTickAt: null,
          lastDecision: null,
        },
      ]);
      if (meetingUrlToSend && !json.attached) {
        setError('Co-pilot failed to attach to this meeting.');
      }
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'dispatch failed');
      return null;
    } finally {
      setBusy(false);
    }
  }, [isRecording, language, sessionId, activeMeetingUrl]);

  const stop = useCallback(async (sessionId: string) => {
    setBusy(true);
    try {
      const serverUrl = await getServerUrl();
      const r = await authFetch(`${serverUrl}/kb/agent/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (!r.ok) throw new Error(`stop ${r.status}`);
      setRuns((prev) => prev.filter((x) => x.sessionId !== sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'stop failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    canDispatch: isRecording && !busy,
    isRecording,
    activeMeetingUrl,                  // null when no Meet/Teams/Zoom tab focused
    runs,
    busy,
    error,
    dispatch,
    stop,
    clearError: () => setError(null),
  };
}
