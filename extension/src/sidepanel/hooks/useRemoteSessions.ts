import { useEffect, useState, useCallback } from 'react';
import { authFetch, getServerUrl } from '../../lib/config';

export interface RemoteSession {
  sessionId: string;
  meetingTitle: string;
  startedAt: number;
  lastWrite: number;
  captionCount: number;
  sequence: number;
}

export function useRemoteSessions() {
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const url = await getServerUrl();
      const res = await authFetch(`${url}/kb/live/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Poll the JSON list endpoint on a short cadence. An SSE stream at
    // /kb/live/sessions/stream was attempted, but the server never implemented
    // one — its GET /kb/live/sessions prefix-match returned one-shot JSON, so
    // the reader parsed JSON as SSE, never saw a `data:` frame, and reconnected
    // forever (RemoteSessionBanner never got data). Polling is simpler and
    // fully covers a discovery banner's needs.
    const loop = async () => {
      if (!active) return;
      await refresh();
      if (active) timer = setTimeout(loop, 4000);
    };

    loop();

    // Refresh immediately when the panel becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') loop();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { sessions, loading, refresh };
}
