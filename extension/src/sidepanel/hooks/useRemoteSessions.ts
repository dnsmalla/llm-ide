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
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    let reconnectAttempts = 0;
    async function connect() {
      try {
        const url = await getServerUrl();
        const res = await authFetch(`${url}/kb/live/sessions/stream`);
        if (!res.ok || !res.body || !active) return;

        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        reconnectAttempts = 0;

        setLoading(false);

        while (active) {
          if (!reader) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 2);
            if (chunk.startsWith('data: ')) {
              try {
                const payload = JSON.parse(chunk.slice(6));
                if (active) setSessions(payload.sessions || []);
              } catch {
                /* ignore parse errors */
              }
            }
          }
        }
      } catch {
        reconnectAttempts += 1;
      } finally {
        if (active) {
          const delay = Math.min(3000 * Math.pow(2, reconnectAttempts - 1), 30_000);
          setTimeout(() => {
            if (active) connect();
          }, delay);
        }
      }
    }

    connect();

    return () => {
      active = false;
      try {
        reader?.cancel().catch(() => {});
      } catch {
        /* reader already closed */
      }
    };
  }, []);

  return { sessions, loading, refresh };
}
