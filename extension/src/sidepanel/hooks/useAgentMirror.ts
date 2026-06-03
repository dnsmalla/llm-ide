// Reads the agent's contributions out of /kb/live/<sessionId> so the
// side panel can render them next to the user's own transcript.
//
// The Mac app does this via LiveSessionMirror.swift; the extension
// previously only PUSHED into /kb/live/* (via useLiveSync) and never
// read back, so a Chrome-only user would see the "Agent attached"
// status line but never the actual questions.  This hook closes
// that gap.
//
// We poll the same endpoint the Mac app polls, filter to
// source ∈ {agent-system, agent-question}, and expose a feedback
// helper that the popover wires up.

import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch, getServerUrl } from '../../lib/config';

export interface AgentCaptionMeta {
  planTaskId?: string;
  score?: number;
  reason?: string;
}

export interface AgentCaption {
  seq: number;
  speaker: string;
  text: string;
  ts: number;                     // ms epoch
  source: string;                 // 'agent-system' | 'agent-question' | 'captions' | etc.
  meta?: AgentCaptionMeta;
}

const POLL_MS = 1500;
const MAX_CAPTIONS = 2000;

export function useAgentMirror({
  sessionId, isAttached, includeHuman = false,
}: {
  sessionId: string;
  /** Only poll while the agent is actually attached to this session OR
   *  while in mirror mode (includeHuman = true).
   *  Otherwise we burn an authed GET every 1.5s for no captions. */
  isAttached: boolean;
  includeHuman?: boolean;
}) {
  const [captions, setCaptions] = useState<AgentCaption[]>([]);
  const sinceRef = useRef(0);
  const cancelledRef = useRef(false);

  // Reset when the session changes — a new attach means the seq
  // counter restarts on the server.
  useEffect(() => {
    sinceRef.current = 0;
    setCaptions([]);
  }, [sessionId]);

  useEffect(() => {
    cancelledRef.current = false;
    if (!sessionId || (!isAttached && !includeHuman)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    async function tick() {
      try {
        const url = await getServerUrl();
        const r = await authFetch(`${url}/kb/live/${encodeURIComponent(sessionId)}?since=${sinceRef.current}`);
        if (r.ok) {
          consecutiveFailures = 0;
          const j = await r.json();
          const rows: AgentCaption[] = (j.captions || []).filter(
            (c: { source?: string }) => {
              if (includeHuman) return true;
              return c.source === 'agent-system' || c.source === 'agent-question';
            },
          );
          if (!cancelledRef.current && rows.length > 0) {
            setCaptions((prev) => {
              const merged = prev.concat(rows);
              return merged.length > MAX_CAPTIONS ? merged.slice(-MAX_CAPTIONS) : merged;
            });
          }
          if (typeof j.sequence === 'number') sinceRef.current = j.sequence;
        } else {
          consecutiveFailures += 1;
        }
      } catch {
        consecutiveFailures += 1;
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
    };
  }, [sessionId, isAttached, includeHuman]);

  const submitFeedback = useCallback(
    async (seq: number, verdict: 'useful' | 'noise' | 'later', meta?: AgentCaptionMeta) => {
      try {
        const url = await getServerUrl();
        await authFetch(`${url}/kb/agent/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            captionSeq: seq,
            verdict,
            planTaskId: meta?.planTaskId,
            score: meta?.score,
          }),
        });
      } catch {
        // Caller treats absence-of-throw as success; if it failed, the
        // popover state will revert when it doesn't get a thumbs-up.
      }
    },
    [sessionId],
  );

  return { captions, submitFeedback };
}
