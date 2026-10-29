import { useCallback, useEffect, useRef, useState } from 'react';
import { reconcileDrafts, resendDraft, listDrafts, type DraftReport } from '../../lib/capture-store';
import { chromeArea, httpLiveApi, lockRunner } from '../../lib/capture-live';

const POLL_MS = 15_000;
const runLocked = lockRunner('llmide-draft-release');

/**
 * Keeps a capture draft only until the server says the Mac acked it. Polls the
 * status of every draft; deletes none on an unreachable/unknown answer.
 * `activeSessionId` is the capture this panel is recording right now.
 */
export function useDraftRelease(activeSessionId: string | null, isRecording: boolean) {
  const [reports, setReports] = useState<DraftReport[]>([]);
  const busy = useRef(false);
  const activeRef = useRef<string | null>(null);
  activeRef.current = isRecording ? activeSessionId : null;

  const pass = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const out = await runLocked(async () =>
        reconcileDrafts(chromeArea(), httpLiveApi, {
          activeIds: activeRef.current ? new Set([activeRef.current]) : undefined,
        }),
      );
      if (out) setReports(out);
    } catch {
      /* storage hiccup: the drafts stay */
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void pass();
    const t = setInterval(() => void pass(), POLL_MS);
    return () => clearInterval(t);
  }, [pass]);

  // Re-check right after a recording stops.
  useEffect(() => {
    if (!isRecording) void pass();
  }, [isRecording, pass]);

  const resend = useCallback(
    async (id: string) => {
      const entry = (await listDrafts(chromeArea())).find((e) => e.draft.id === id);
      if (entry) await runLocked(() => resendDraft(chromeArea(), httpLiveApi, entry));
      await pass();
    },
    [pass],
  );

  return { reports, resend, refresh: pass };
}
