import React, { useState, useCallback, useEffect } from 'react';
import type { AudioDevice } from '../hooks/useAudioDevices';
import type { Diagnostics } from '../hooks/useTranscript';
import ConnectorsSettings from './ConnectorsSettings';
import AgentPersonaSettings from './AgentPersonaSettings';
import UserAccountSettings from './UserAccountSettings';
import { searchKB, getKBStats, type KBSearchHit, type KBStats } from '../../lib/kb';

interface Props {
  devices: AudioDevice[];
  selectedDeviceId: string;
  onSelectDevice: (deviceId: string) => void;
  volume: number;
  onChangeVolume: (vol: number) => void;
  onRefreshDevices: () => void;
  diagnostics: Diagnostics;
  isRecording: boolean;
  captureMode: 'captions' | 'mic';
}

function formatAgo(ts: number): string {
  if (!ts) return 'never';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 2) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

export default function Settings({
  devices,
  selectedDeviceId,
  onSelectDevice,
  volume,
  onChangeVolume,
  onRefreshDevices,
  diagnostics,
  isRecording,
  captureMode,
}: Props) {
  return (
    <div className="settings">
      <div className="settings-section">
        <UserAccountSettings />
      </div>

      <div className="settings-section">
        <h3 className="settings-heading">Microphone</h3>
        <div className="settings-row">
          <select
            className="settings-select"
            value={selectedDeviceId}
            onChange={(e) => onSelectDevice(e.target.value)}
          >
            <option value="default">System Default</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={onRefreshDevices}>
            Refresh
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-heading">
          Volume Boost: {volume}%
        </h3>
        <input
          type="range"
          min="50"
          max="300"
          step="10"
          value={volume}
          onChange={(e) => onChangeVolume(Number(e.target.value))}
          className="settings-range"
        />
        <div className="settings-range-labels">
          <span>50%</span>
          <span>100%</span>
          <span>200%</span>
          <span>300%</span>
        </div>
        <p className="settings-hint">
          Boost mic sensitivity for quiet speakers. 100% = normal.
        </p>
      </div>

      <div className="settings-section">
        <h3 className="settings-heading">Diagnostics</h3>
        <dl className="diagnostics-grid">
          <dt>Recording</dt>
          <dd>{isRecording ? `yes (${captureMode})` : 'no'}</dd>
          <dt>Platform</dt>
          <dd>{diagnostics.platform || 'none detected'}</dd>
          <dt>Captions received</dt>
          <dd>{diagnostics.captionsReceived}</dd>
          <dt>Last caption</dt>
          <dd>{formatAgo(diagnostics.lastCaptionAt)}</dd>
        </dl>
        <p className="settings-hint">
          If captions aren't arriving: make sure CC is turned on in the meeting
          tab, that the tab is focused when you click Start, and that the
          extension is installed in the same browser profile as the meeting.
        </p>
      </div>

      <div className="settings-section">
        <h3 className="settings-heading">How it works</h3>
        <p className="settings-hint">
          1. Click Start Recording<br />
          2. Allow microphone access when prompted<br />
          3. Your mic captures all meeting audio<br />
          4. Click Generate Notes when done<br />
          5. Requires <code>node server.mjs</code> running locally
        </p>
      </div>

      <div className="settings-section">
        <AgentPersonaSettings />
      </div>

      <div className="settings-section">
        <ConnectorsSettings />
      </div>

      <div className="settings-section">
        <KBSearchPanel />
      </div>

      <div className="settings-section">
        <h3 className="settings-heading">About</h3>
        <p className="settings-hint">
          LLM IDE v{chrome.runtime?.getManifest?.().version || 'development'}
          <br />
          Captions and audio stay on your machine. Transcripts are sent only to
          your local server on <code>127.0.0.1:3456</code>, which uses your own
          Claude CLI authentication.
        </p>
      </div>
    </div>
  );
}

function KBSearchPanel() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | KBSearchHit['kind']>('all');
  const [results, setResults] = useState<KBSearchHit[]>([]);
  const [stats, setStats] = useState<KBStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { getKBStats().then(setStats); }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const hits = await searchKB({
        q: q.trim() || undefined,
        kind: kind === 'all' ? undefined : kind,
        limit: 30,
      });
      setResults(hits);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'KB unavailable');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [q, kind]);

  return (
    <section className="kb-search">
      <h3 className="settings-heading">Knowledge Base Search</h3>
      {stats && (
        <p className="actions-hint">
          {stats.meetings} meeting{stats.meetings === 1 ? '' : 's'} ·{' '}
          {stats.entities} item{stats.entities === 1 ? '' : 's'} indexed
        </p>
      )}
      <div className="kb-search-row">
        <input
          className="kb-search-input"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
          placeholder="Search past meetings, actions, decisions…"
          aria-label="Search the knowledge base"
        />
        <select
          className="kb-search-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          aria-label="Filter by kind"
        >
          <option value="all">All</option>
          <option value="meeting">Meetings</option>
          <option value="action">Actions</option>
          <option value="decision">Decisions</option>
          <option value="blocker">Blockers</option>
          <option value="code">Code</option>
          <option value="ticket">Tickets</option>
          <option value="qa">QA</option>
          <option value="plan">Plans</option>
          <option value="task">Plan tasks</option>
          <option value="outcome">Outcomes</option>
        </select>
        <button
          className="btn btn-sm"
          onClick={run}
          disabled={loading}
          aria-busy={loading}
          aria-label={loading ? 'Searching…' : 'Search knowledge base'}
        >
          {loading ? '…' : 'Search'}
        </button>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {loading ? 'Searching…'
          : err ? `Search error: ${err}`
          : q && results.length === 0 ? 'No matches found.'
          : results.length > 0 ? `${results.length} result${results.length === 1 ? '' : 's'} found.`
          : ''}
      </p>
      {err && <p className="error-message" role="alert">{err}</p>}
      {results.length > 0 && (
        <ul className="kb-results" aria-label={`${results.length} search result${results.length === 1 ? '' : 's'}`}>
          {results.map((r, i) => (
            <li key={`${r.kind}-${r.entityId || r.meetingId}-${i}`} className={`kb-hit kind-${r.kind}`}>
              <div className="kb-hit-head">
                <span className={`meta-chip kind-${r.kind}`} aria-label={`Type: ${r.kind}`}>{r.kind}</span>
                {r.meetingTitle && r.kind !== 'meeting' && (
                  <span className="kb-hit-meeting">{r.meetingTitle}</span>
                )}
                {r.date && <span className="kb-hit-date">{r.date.split('T')[0]}</span>}
              </div>
              <div className="kb-hit-title">{r.title}</div>
              {r.body && <div className="kb-hit-body">{r.body}</div>}
            </li>
          ))}
        </ul>
      )}
      {!loading && results.length === 0 && q && !err && (
        <p className="actions-hint">
          No matches for <strong>{q}</strong>{kind !== 'all' ? ` in ${kind}` : ''}.
        </p>
      )}
    </section>
  );
}
