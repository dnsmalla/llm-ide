import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  readLegacyTranscripts,
  importLegacyTranscripts,
  expectedCapture,
  toCaptions,
  type LegacyReport,
  type LegacyTranscript,
} from '../../lib/capture-store';
import { chromeArea, httpLiveApi, lockRunner } from '../../lib/capture-live';

const runLocked = lockRunner('llmide-legacy-import');

const OUTCOME_TEXT: Record<LegacyReport['outcome'], string> = {
  copied: 'copied to the Mac, local copy removed',
  waiting: 'sent; waiting for the Mac app to confirm (run again later)',
  'kept-merged': 'copied, local copy kept',
  'skipped-large': 'too large for a verified copy, kept here',
  'skipped-empty': 'empty, kept here',
  'no-ack-protocol': 'this server cannot confirm copies; nothing was sent or deleted',
  unreachable: 'Mac app not running; nothing deleted',
  mismatch: 'the server did not hold the same lines; nothing deleted',
  busy: 'another import is running',
  error: 'failed; nothing deleted',
};

/**
 * Read-only list of the meetings the extension saved locally before it stopped
 * keeping history, with an explicit "Copy to Mac" action. A local copy is
 * deleted only after the Mac app confirms it holds the copy.
 */
export default function LegacyTranscriptsPanel() {
  const [items, setItems] = useState<LegacyTranscript[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [reports, setReports] = useState<LegacyReport[]>([]);
  const runningRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setItems(await readLegacyTranscripts(chromeArea()));
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const copy = useCallback(async () => {
    if (runningRef.current) return; // double click
    const chosen = items.filter((t) => selected.has(t.id));
    if (chosen.length === 0) return;
    runningRef.current = true;
    setRunning(true);
    setReports([]);
    try {
      await importLegacyTranscripts(chromeArea(), httpLiveApi, chosen, {
        withLock: runLocked,
        onProgress: (r) => setReports((prev) => [...prev, r]),
      });
    } finally {
      runningRef.current = false;
      setRunning(false);
      setSelected(new Set());
      await load();
    }
  }, [items, selected, load]);

  if (items.length === 0 && reports.length === 0) return null;

  return (
    <section className="legacy-transcripts">
      <h3 className="settings-heading">Meetings saved in this browser (old)</h3>
      <p className="settings-hint">
        The extension no longer keeps a meeting history. These were saved before. Copy them to the Mac app; each local
        copy is removed only after the Mac app confirms it has the copy. Nothing is sent until you press the button.
      </p>
      <ul className="kb-results">
        {items.map((t) => {
          const e = expectedCapture(toCaptions(t.segments));
          return (
            <li key={t.id} className="kb-hit">
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(t.id)}
                  disabled={running}
                  onChange={() => toggle(t.id)}
                  aria-label={`Select ${t.meetingTitle || 'Untitled meeting'}`}
                />{' '}
                {t.meetingTitle || 'Untitled meeting'} · {(t.date || '').split('T')[0]} · {e.valid} lines
              </label>
            </li>
          );
        })}
      </ul>
      <div className="settings-row">
        <button className="btn btn-sm" disabled={running || selected.size === 0} onClick={copy}>
          {running ? 'Copying…' : `Copy ${selected.size || ''} to Mac`}
        </button>
        <button
          className="btn btn-sm"
          disabled={running}
          onClick={() => setSelected(new Set(items.map((t) => t.id)))}
        >
          Select all
        </button>
      </div>
      {reports.length > 0 && (
        <ul className="actions-hint" role="status">
          {reports.map((r, i) => (
            <li key={`${r.id}-${i}`}>
              {r.title}: {OUTCOME_TEXT[r.outcome]}
              {r.detail ? ` (${r.detail})` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
