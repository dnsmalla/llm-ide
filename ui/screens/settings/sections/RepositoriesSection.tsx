import { useCallback, useState } from "react";
import { call } from "../core-api.ts";
import { decodeSecretNames } from "../decoders.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import {
  REPO_OP_GROUPS,
  REPO_PROVIDERS,
  addSavedRepo,
  normalizeBase,
  readRepoConfig,
  removeSavedRepo,
  repoTitle,
  setActiveRepo,
  setPrimary,
  toggleAllowedOp,
  updateSavedRepo,
  validateRepoUrl,
  writeRepoConfig,
  type RepoConfig,
  type RepoProvider,
  type SavedRepo,
} from "../repo-config.ts";
import { REPOS_TEXT, decodeRepos, repoTitle as allowTitle, sourcesError, type RepoEntry } from "../sources-model.ts";
import { Button, ErrorText } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/**
 * The Mac's Repositories settings card: GitLab / GitHub tabs, a write-only access token per provider, the
 * per-provider automation allow-list, and the saved repositories. Everything except the token is local app config
 * (the Mac uses AppConfig); tokens go to the core vault and are never rendered back, only their names.
 *
 * Honest desktop gaps, stated in the card: the Mac's Save & verify and Clone need provider HTTP and a git clone
 * host; this card stores the token and the repository entry but does not verify or clone.
 */
export default function RepositoriesSection() {
  const { client, host } = useEnv();
  const [cfg, setCfg] = useState<RepoConfig>(() => readRepoConfig());
  const [tab, setTab] = useState<RepoProvider>("gitlab");
  const [secrets, setSecrets] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  // The core allow-list (a desktop/security feature, not part of the Mac's Repositories card).
  const [rows, setRows] = useState<RepoEntry[] | null>(null);
  const [repoBusy, setRepoBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const edit = (fn: (c: RepoConfig) => RepoConfig) => {
    setCfg((prev) => {
      const next = fn(prev);
      writeRepoConfig(next);
      return next;
    });
  };

  const loadSecrets = useCallback(() => {
    call(client, "GET", "/auth/me/secrets").then(
      (b) => {
        try {
          setSecrets(new Set(decodeSecretNames(b)));
          setError(null);
        } catch (e) {
          setSecrets(new Set());
          setError(sourcesError(e));
        }
      },
      (e) => {
        setSecrets(new Set());
        setError(sourcesError(e));
      },
    );
  }, [client]);
  useRefreshOnFocus(loadSecrets);

  const loadRepos = useCallback(() => {
    call(client, "GET", "/auth/me/repos").then(
      (b) => setRows(decodeRepos(b)),
      (e) => { setRows([]); setError(sourcesError(e)); },
    );
  }, [client]);
  useRefreshOnFocus(loadRepos);

  const provider = REPO_PROVIDERS.find((p) => p.id === tab)!;
  const connected = secrets?.has(provider.tokenKey) ?? false;
  const both = (secrets?.has("gitlab.token") ?? false) && (secrets?.has("github.token") ?? false);
  const saved = cfg.saved[provider.id];
  const ops = cfg.operations[provider.id];

  const saveToken = async () => {
    const value = draft.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await call(client, "POST", "/auth/me/secrets", { key: provider.tokenKey, value });
      edit((c) => ({ ...c, gitlabBaseUrl: normalizeBase(c.gitlabBaseUrl) }));
      setDraft("");
      setVisible(false);
      setStatus("Token saved.");
      loadSecrets();
    } catch (e) {
      setError(sourcesError(e));
    } finally {
      setBusy(false);
    }
  };

  const clearToken = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await call(client, "POST", "/auth/me/secrets", { key: provider.tokenKey, value: null });
      setDraft("");
      setStatus("Token cleared. Saved repositories kept.");
      loadSecrets();
    } catch (e) {
      setError(sourcesError(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- core allow-list actions ---------------------------------------------------------------
  const addAllow = async () => {
    if (!host.pickFolder) return;
    setRepoBusy(true);
    try {
      const picked = await host.pickFolder("Choose a repository folder");
      if (!picked) return;
      await call(client, "POST", "/auth/me/repos", { path: picked });
      loadRepos();
    } catch (e) {
      setError(sourcesError(e));
    } finally {
      setRepoBusy(false);
    }
  };

  const removeAllow = async (r: RepoEntry) => {
    setRepoBusy(true);
    try {
      await call(client, "DELETE", `/auth/me/repos?path=${encodeURIComponent(r.path)}`);
      setConfirming(null);
      loadRepos();
    } catch (e) {
      setError(sourcesError(e));
    } finally {
      setRepoBusy(false);
    }
  };

  const patchRepo = (r: SavedRepo, patch: Partial<SavedRepo>) => edit((c) => updateSavedRepo(c, provider.id, r.id, patch));
  const urlError = (r: SavedRepo): string | null => (r.url.trim() ? validateRepoUrl(r.url) : null);

  return (
    <div className="st-stack">
      <div className="st-tabs" role="tablist" aria-label="Repository provider">
        {REPO_PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`repos-tab-${p.id}`}
            aria-selected={tab === p.id}
            aria-controls={`repos-pane-${p.id}`}
            className="st-tab"
            onClick={() => { setTab(p.id); setStatus(null); setError(null); setDraft(""); setVisible(false); }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`repos-pane-${tab}`} aria-labelledby={`repos-tab-${tab}`} className="st-stack">
        {both ? (
          <div className="st-note">
            <label className="st-row">
              <input
                type="checkbox"
                checked={cfg.primary === provider.id}
                disabled={busy}
                onChange={(e) => edit((c) => setPrimary(c, e.target.checked ? provider.id : null))}
              />
              <span>Set as primary provider</span>
            </label>
            {cfg.primary === provider.id ? (
              <p className="st-hint" role="status">
                Issues, Gantt, and code workflows will use {provider.label} as the primary provider.
              </p>
            ) : null}
          </div>
        ) : null}

        {provider.id === "gitlab" ? (
          <label className="st-field">
            <span className="st-label">Instance URL</span>
            <input
              className="st-input"
              value={cfg.gitlabBaseUrl}
              spellCheck={false}
              onChange={(e) => edit((c) => ({ ...c, gitlabBaseUrl: e.target.value }))}
              onBlur={() => edit((c) => ({ ...c, gitlabBaseUrl: normalizeBase(c.gitlabBaseUrl) }))}
              placeholder="https://gitlab.com"
              aria-label="GitLab instance URL"
            />
            <span className="st-hint">The host this token is for. The path is kept, so a GitLab under /gitlab works.</span>
          </label>
        ) : null}

        <label className="st-field">
          <span className="st-label">Access Token</span>
          <div className="st-row">
            <input
              className="st-input"
              type={visible ? "text" : "password"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={connected ? "Saved — paste a new token to replace it" : provider.placeholder}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={`${provider.label} access token`}
            />
            {draft ? (
              <Button onClick={() => setVisible((v) => !v)}>{visible ? "Hide" : "Show"}</Button>
            ) : null}
            <Button tone="primary" disabled={busy || draft.trim() === ""} onClick={() => void saveToken()}>{busy ? "Saving…" : "Save token"}</Button>
            {connected ? <Button tone="danger" disabled={busy} onClick={() => void clearToken()}>Clear token</Button> : null}
          </div>
          <span className="st-hint">
            Stored write-only in the core vault; the saved value is never shown again. {REPOS_TEXT.saveOnly}
          </span>
        </label>
        {connected ? <p className="st-ok" role="status">Connected · {provider.id === "gitlab" ? hostOf(cfg.gitlabBaseUrl) : "github.com"}</p> : null}
        {status ? <p className="st-ok" role="status">{status}</p> : null}

        <div className="st-stack">
          <span className="st-label">Automation &amp; actions</span>
          <p className="st-hint">Unchecked operations are skipped automatically and disabled in the UI.</p>
          {REPO_OP_GROUPS.map((g) => (
            <fieldset key={g.title} className="st-op-group">
              <legend className="st-label">{g.title}</legend>
              {g.ops.map((op) => (
                <label key={op.id} className="st-row">
                  <input
                    type="checkbox"
                    checked={ops.includes(op.id)}
                    onChange={(e) => edit((c) => toggleAllowedOp(c, provider.id, op.id, e.target.checked))}
                  />
                  <span>{op.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>

        <div className="st-stack">
          <div className="st-row">
            <span className="st-label">Repositories</span>
            <Button disabled={!connected} onClick={() => edit((c) => addSavedRepo(c, provider.id))}>Add repository</Button>
          </div>
          {saved.length === 0 ? (
            <p className="st-hint">No repositories added yet.{connected ? "" : ` Add a ${provider.label} token first.`}</p>
          ) : (
            <ul className="st-stack" aria-label={`${provider.label} repositories`}>
              {saved.map((r) => (
                <li key={r.id} className="st-note">
                  <div className="st-row">
                    <label className="st-row">
                      <input type="radio" name={`active-${provider.id}`} checked={r.active} onChange={() => edit((c) => setActiveRepo(c, provider.id, r.id))} />
                      <span>Active</span>
                    </label>
                    <span className="st-hint">{repoTitle(r)}</span>
                    <span className="st-spacer" />
                    <Button tone="danger" onClick={() => edit((c) => removeSavedRepo(c, provider.id, r.id))}>Remove</Button>
                  </div>
                  <label className="st-field">
                    <span className="st-label">Display name</span>
                    <input className="st-input" value={r.displayName} placeholder={repoTitle(r)} onChange={(e) => patchRepo(r, { displayName: e.target.value })} />
                  </label>
                  <label className="st-field">
                    <span className="st-label">Repository URL or owner/repo</span>
                    <input
                      className="st-input"
                      value={r.url}
                      placeholder={provider.id === "gitlab" ? "https://gitlab.com/owner/repo" : "https://github.com/owner/repo"}
                      spellCheck={false}
                      aria-invalid={urlError(r) !== null}
                      onChange={(e) => patchRepo(r, { url: e.target.value })}
                    />
                    {urlError(r) ? <span className="st-hint" role="alert">{urlError(r)}</span> : null}
                  </label>
                  <label className="st-field">
                    <span className="st-label">Clone path (optional)</span>
                    <input className="st-input" value={r.clonePath} placeholder="Where the Mac would clone it; not used yet" spellCheck={false} onChange={(e) => patchRepo(r, { clonePath: e.target.value })} />
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="st-hint">{REPOS_TEXT.cloneGap}</p>
        </div>

        <details className="st-stack">
          <summary className="st-label">Core index allow-list (desktop-only)</summary>
          <p className="st-hint">
            Folders the core may read for git and issues. This is not part of the Mac's Repositories card; it is shown
            here so the core's own safety list is reachable.
          </p>
          <div className="st-row">
            {host.pickFolder ? <Button disabled={repoBusy} onClick={() => void addAllow()}>Add folder…</Button> : <span className="st-hint">Adding a folder needs the desktop host.</span>}
            <Button disabled={repoBusy} onClick={loadRepos}>Refresh</Button>
          </div>
          {rows === null ? <p className="st-hint" role="status">Loading…</p> : rows.length === 0 ? (
            <p className="st-hint">{REPOS_TEXT.empty}</p>
          ) : (
            <ul className="st-stack" aria-label="Approved repositories">
              {rows.map((r) => (
                <li key={r.path} className="st-note">
                  <strong>{allowTitle(r)}</strong>
                  <p className="st-pre">{r.path}</p>
                  {confirming === r.path ? (
                    <div className="st-row">
                      <span className="st-hint" role="alert">{REPOS_TEXT.removeConfirm}</span>
                      <Button tone="danger" disabled={repoBusy} onClick={() => void removeAllow(r)}>Remove</Button>
                      <Button disabled={repoBusy} onClick={() => setConfirming(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="st-row"><Button disabled={repoBusy} onClick={() => setConfirming(r.path)}>Remove</Button></div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>

      <ErrorText text={error} />
      <PartialNote id="repositories" />
    </div>
  );
}

/** The host of a GitLab instance URL, for the "Connected · host" row; never throws. */
function hostOf(raw: string): string {
  try {
    return new URL(normalizeBase(raw)).host || "gitlab.com";
  } catch {
    return "gitlab.com";
  }
}
