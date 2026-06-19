import React, { useCallback, useEffect, useState } from 'react';
import {
  connectGitRepo,
  connectGithubIssues,
  connectQA,
  getKBStats,
  type ConnectorResult,
  type KBStats,
} from '../../lib/kb';

// All connector inputs (paths, repo names, tokens) live in
// chrome.storage.local — never synced.  Tokens are only sent over the
// loopback HTTP boundary to our own server when the user clicks Index.
const STORAGE_KEYS = {
  repoPath: 'connector.git.path',
  ghRepo: 'connector.gh.repo',
  ghToken: 'connector.gh.token',
  ghState: 'connector.gh.state',
  qaSource: 'connector.qa.source',
} as const;

type Status = { kind: 'idle' | 'busy' | 'ok' | 'err'; message?: string };

function useStored(key: string, initial = '') {
  const [v, setV] = useState(initial);
  useEffect(() => {
    chrome.storage?.local
      ?.get(key)
      .then((r) => {
        const raw = r?.[key];
        if (typeof raw === 'string') setV(raw);
      })
      .catch(() => {});
  }, [key]);
  const update = useCallback(
    (next: string) => {
      setV(next);
      chrome.storage?.local?.set({ [key]: next }).catch(() => {});
    },
    [key],
  );
  return [v, update] as const;
}

function summarize(result: ConnectorResult): string {
  const bits: string[] = [];
  if ('filesIndexed' in result) bits.push(`${result.filesIndexed} files`);
  if ('chunks' in result) bits.push(`${result.chunks} chunks`);
  if ('count' in result) bits.push(`${result.count} tickets`);
  if ('failed' in result) bits.push(`${result.failed} failed`);
  if ('total' in result) bits.push(`${result.total} cases`);
  return bits.join(' · ') || 'OK';
}

export default function ConnectorsSettings() {
  const [stats, setStats] = useState<KBStats | null>(null);

  const [repoPath, setRepoPath] = useStored(STORAGE_KEYS.repoPath);
  const [ghRepo, setGhRepo] = useStored(STORAGE_KEYS.ghRepo);
  const [ghToken, setGhToken] = useStored(STORAGE_KEYS.ghToken);
  const [ghState, setGhState] = useStored(STORAGE_KEYS.ghState, 'all');
  const [qaSource, setQaSource] = useStored(STORAGE_KEYS.qaSource);
  const [showToken, setShowToken] = useState(false);

  const [gitStatus, setGitStatus] = useState<Status>({ kind: 'idle' });
  const [ghStatus, setGhStatus] = useState<Status>({ kind: 'idle' });
  const [qaStatus, setQaStatus] = useState<Status>({ kind: 'idle' });

  const refreshStats = useCallback(() => {
    getKBStats().then(setStats);
  }, []);
  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  const runGit = useCallback(async () => {
    if (!repoPath.trim()) return;
    setGitStatus({ kind: 'busy', message: 'Indexing…' });
    try {
      const r = await connectGitRepo(repoPath.trim());
      setGitStatus({ kind: 'ok', message: summarize(r) });
      refreshStats();
    } catch (err) {
      setGitStatus({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
    }
  }, [repoPath, refreshStats]);

  const runGithub = useCallback(async () => {
    if (!ghRepo.trim()) return;
    setGhStatus({ kind: 'busy', message: 'Fetching…' });
    try {
      const r = await connectGithubIssues({
        repo: ghRepo.trim(),
        token: ghToken.trim() || undefined,
        state: (ghState as 'open' | 'closed' | 'all') || 'all',
      });
      setGhStatus({ kind: 'ok', message: summarize(r) });
      refreshStats();
    } catch (err) {
      setGhStatus({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
    }
  }, [ghRepo, ghToken, ghState, refreshStats]);

  const runQA = useCallback(
    async (file: File) => {
      setQaStatus({ kind: 'busy', message: 'Parsing…' });
      try {
        const xml = await file.text();
        const r = await connectQA({ xml, source: qaSource.trim() || file.name });
        setQaStatus({ kind: 'ok', message: summarize(r) });
        refreshStats();
      } catch (err) {
        setQaStatus({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [qaSource, refreshStats],
  );

  return (
    <section className="connectors-settings">
      <h3 className="settings-section-title">Knowledge Base connectors</h3>
      {stats?.sources && (
        <p className="actions-hint">
          Indexed: {stats.sources.code} code · {stats.sources.ticket} ticket · {stats.sources.qa} qa
        </p>
      )}

      {/* --- Local repo ---------------------------------------- */}
      <div className="connector-block">
        <label className="connector-label">Local repository (absolute path)</label>
        <div className="connector-row">
          <input
            type="text"
            className="connector-input"
            value={repoPath}
            placeholder="/Users/you/projects/my-repo"
            onChange={(e) => setRepoPath(e.target.value)}
            spellCheck={false}
          />
          <button className="btn btn-sm" onClick={runGit} disabled={!repoPath.trim() || gitStatus.kind === 'busy'}>
            {gitStatus.kind === 'busy' ? 'Indexing…' : 'Index'}
          </button>
        </div>
        <StatusLine status={gitStatus} />
      </div>

      {/* --- GitHub issues ------------------------------------- */}
      <div className="connector-block">
        <label className="connector-label">GitHub issues + PRs</label>
        <div className="connector-row">
          <input
            type="text"
            className="connector-input"
            value={ghRepo}
            placeholder="owner/name"
            onChange={(e) => setGhRepo(e.target.value)}
            spellCheck={false}
          />
          <select
            className="connector-input connector-select"
            value={ghState}
            onChange={(e) => setGhState(e.target.value)}
          >
            <option value="all">all</option>
            <option value="open">open</option>
            <option value="closed">closed</option>
          </select>
        </div>
        <div className="connector-row">
          <input
            type={showToken ? 'text' : 'password'}
            className="connector-input"
            value={ghToken}
            placeholder="Personal access token (optional for public repos)"
            onChange={(e) => setGhToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowToken((v) => !v)}
            aria-label={showToken ? 'Hide token' : 'Show token'}
          >
            {showToken ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="connector-row">
          <span className="connector-hint">
            Token stays in <code>chrome.storage.local</code> and is only sent to your own 127.0.0.1 server.
          </span>
          <button className="btn btn-sm" onClick={runGithub} disabled={!ghRepo.trim() || ghStatus.kind === 'busy'}>
            {ghStatus.kind === 'busy' ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
        <StatusLine status={ghStatus} />
      </div>

      {/* --- QA results --------------------------------------- */}
      <div className="connector-block">
        <label className="connector-label">QA results (JUnit XML)</label>
        <div className="connector-row">
          <input
            type="text"
            className="connector-input"
            value={qaSource}
            placeholder="run id or label (optional)"
            onChange={(e) => setQaSource(e.target.value)}
            spellCheck={false}
          />
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            {qaStatus.kind === 'busy' ? 'Parsing…' : 'Choose XML…'}
            <input
              type="file"
              accept=".xml,application/xml,text/xml"
              style={{ display: 'none' }}
              disabled={qaStatus.kind === 'busy'}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) runQA(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <StatusLine status={qaStatus} />
      </div>
    </section>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  const className =
    status.kind === 'err'
      ? 'connector-status err'
      : status.kind === 'ok'
        ? 'connector-status ok'
        : 'connector-status busy';
  return (
    <div className={className} role="status">
      {status.message}
    </div>
  );
}
