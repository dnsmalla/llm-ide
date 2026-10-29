import { useCallback, useEffect, useRef, useState } from 'react';
import {
  reconcileDrafts,
  resendDraft,
  listDrafts,
  deleteDraft,
  exportDraftJson,
  type Draft,
  type DraftReport,
} from '../../lib/capture-store';
import { chromeArea, httpLiveApi, lockRunner, PANEL_ID } from '../../lib/capture-live';

const POLL_MS = 15_000;
const runLocked = lockRunner('llmide-draft-release');

/**
 * Keeps a capture draft only until the server says the Mac acked it. Polls the
 * status of every draft; deletes none on an unreachable/unknown answer.
 * `activeSessionId` is the capture this panel is recording right now.
 */
export function useDraftRelease(activeSessionId: string | null, isRecording: boolean) {
  const [reports, setReports] = useState<DraftReport[]>([]);
  // Drafts the user has to manage by hand (kept for good): retained or too large.
  const [kept, setKept] = useState<Draft[]>([]);
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
          panelId: PANEL_ID,
        }),
      );
      if (out) {
        setReports(out);
        const manual = new Set(out.filter((r) => r.outcome === 'retained' || r.outcome === 'too-large').map((r) => r.id));
        setKept((await listDrafts(chromeArea())).map((e) => e.draft).filter((d) => manual.has(d.id)));
      }
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
      if (entry) await runLocked(() => resendDraft(chromeArea(), httpLiveApi, entry, { panelId: PANEL_ID }));
      await pass();
    },
    [pass],
  );

  /** Download a kept draft as JSON (the way out when the store is full). */
  const exportKept = useCallback((d: Draft) => {
    const url = URL.createObjectURL(new Blob([exportDraftJson(d)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `capture-${d.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  /** Delete one kept draft: only on the user's explicit confirmation. */
  const deleteKept = useCallback(
    async (d: Draft) => {
      if (!window.confirm(`Delete the local copy of "${d.meetingTitle}"? It cannot be recovered.`)) return;
      await deleteDraft(chromeArea(), d.id);
      await pass();
    },
    [pass],
  );

  return { reports, kept, resend, exportKept, deleteKept, refresh: pass };
}
