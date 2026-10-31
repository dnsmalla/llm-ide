import { useCallback, useState } from "react";
import { call } from "../core-api.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { REPOS_TEXT, decodeRepos, repoTitle, sourcesError, type RepoEntry } from "../sources-model.ts";
import { Button, ErrorText } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/**
 * The Mac's "Repositories" group, local half: the per-user allow-list of folders the core may index, with a
 * native folder dialog to add one and a confirmed remove. PROVIDER TOKENS (GitHub/GitLab) and indexing stay in
 * Library → Connections; the note says so. The page never supplies a path the host did not return.
 */
export default function RepositoriesSection() {
  const { client, host } = useEnv();
  const [rows, setRows] = useState<RepoEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    call(client, "GET", "/auth/me/repos").then(
      (b) => { setRows(decodeRepos(b)); setError(null); },
      (e) => { setRows([]); setError(sourcesError(e)); },
    );
  }, [client]);
  useRefreshOnFocus(load);

  const add = async () => {
    if (!host.pickFolder) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const picked = await host.pickFolder("Choose a repository folder");
      if (!picked) return; // cancelled: nothing changes
      await call(client, "POST", "/auth/me/repos", { path: picked });
      setNotice("Added.");
      load();
    } catch (e) {
      setError(sourcesError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: RepoEntry) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call(client, "DELETE", `/auth/me/repos?path=${encodeURIComponent(r.path)}`);
      setConfirming(null);
      setNotice("Removed from the allow-list. Nothing was deleted.");
      load();
    } catch (e) {
      setError(sourcesError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-stack">
      <p className="st-hint">{REPOS_TEXT.hint}</p>
      <ErrorText text={error} />
      <div className="st-row">
        {host.pickFolder ? (
          <Button tone="primary" disabled={busy} onClick={() => void add()}>{REPOS_TEXT.add}</Button>
        ) : (
          <p className="st-hint">Adding a folder needs the desktop host.</p>
        )}
        <Button disabled={busy} onClick={load}>Refresh</Button>
      </div>
      {rows === null ? (
        <p className="st-hint" role="status">Loading repositories...</p>
      ) : rows.length === 0 ? (
        <p className="st-hint">{REPOS_TEXT.empty}</p>
      ) : (
        <ul className="st-stack" aria-label="Approved repositories">
          {rows.map((r) => (
            <li key={r.path} className="st-note">
              <div className="st-row"><strong>{repoTitle(r)}</strong></div>
              <p className="st-pre">{r.path}</p>
              {confirming === r.path ? (
                <div className="st-stack">
                  <p className="st-hint" role="alert">{REPOS_TEXT.removeConfirm}</p>
                  <div className="st-row">
                    <Button tone="danger" disabled={busy} onClick={() => void remove(r)}>{REPOS_TEXT.remove}</Button>
                    <Button disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="st-row">
                  <Button disabled={busy} onClick={() => setConfirming(r.path)}>{REPOS_TEXT.remove}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice ? <p className="st-ok" role="status">{notice}</p> : null}
      <PartialNote id="repositories" />
    </div>
  );
}
