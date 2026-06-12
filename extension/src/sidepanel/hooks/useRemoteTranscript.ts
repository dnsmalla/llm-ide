import { useEffect, useRef, useState } from 'react';
import { authFetch, getServerUrl } from '../../lib/config';
import { TranscriptSegment } from './useTranscript';
import { AgentCaption } from './useAgentMirror';

const POLL_MS = 1500;
const MAX_SEGMENTS = 5000;
const MAX_AGENT_CAPTIONS = 2000;

export function useRemoteTranscript({
  sessionId, isMirroring,
}: {
  sessionId: string;
  isMirroring: boolean;
}) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [agentCaptions, setAgentCaptions] = useState<AgentCaption[]>([]);
  const sinceRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    sinceRef.current = 0;
    setSegments([]);
    setAgentCaptions([]);
  }, [sessionId]);

  useEffect(() => {
    cancelledRef.current = false;
    if (!sessionId || !isMirroring) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let consecutiveFailures = 0;

    async function tick() {
      try {
        const url = await getServerUrl();
        const r = await authFetch(`${url}/kb/live/${encodeURIComponent(sessionId)}/stream?since=${sinceRef.current}`);
        if (!r.ok || !r.body || cancelledRef.current) return;

        reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        consecutiveFailures = 0;

        while (!cancelledRef.current) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 2);

            if (chunk.startsWith('data: ')) {
              try {
                const j = JSON.parse(chunk.slice(6));
                const raw = j.captions || [];
                const newSegments: TranscriptSegment[] = [];
                const newAgent: AgentCaption[] = [];

                for (const c of raw) {
                  if (c.source === 'captions' || c.source === 'mic' || c.source === 'extension-cc') {
                    newSegments.push({
                      speaker: c.speaker,
                      text: c.text,
                      timestamp: c.ts,
                      isFinal: true,
                    });
                  } else if (c.source.startsWith('agent-')) {
                    newAgent.push(c);
                  }
                }

                if (!cancelledRef.current) {
                  if (newSegments.length > 0) setSegments((prev: TranscriptSegment[]) => {
                    const merged = prev.concat(newSegments);
                    return merged.length > MAX_SEGMENTS ? merged.slice(-MAX_SEGMENTS) : merged;
                  });
                  if (newAgent.length > 0) setAgentCaptions((prev: AgentCaption[]) => {
                    const merged = prev.concat(newAgent);
                    return merged.length > MAX_AGENT_CAPTIONS ? merged.slice(-MAX_AGENT_CAPTIONS) : merged;
                  });
                }

                if (typeof j.sequence === 'number') sinceRef.current = j.sequence;
              } catch { /* ignore JSON parse error on chunk */ }
            }
          }
        }
      } catch {
        consecutiveFailures++;
      }

      if (!cancelledRef.current) {
        const backoff = Math.min(POLL_MS * Math.pow(2, consecutiveFailures), 30_000);
        timer = setTimeout(tick, backoff);
      }
    }

    tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
      if (reader) {
        try { reader.cancel().catch(() => {}); } catch { /* reader already closed */ }
      }
    };
  }, [sessionId, isMirroring]);

  return { segments, agentCaptions };
}
