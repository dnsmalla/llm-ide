import { useCallback, useEffect, useState } from "react";
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
import { REPOS_TEXT, sourcesError } from "../sources-model.ts";
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

  // The project's own code/ path (Settings → Paths); saved repos default their clone destination here.
  const [codeDir, setCodeDir] = useState<string | null>(null);

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

  useEffect(() => {
    host.projectPaths?.().then(
      (p) => {
        const code = p.folders.find((f) => f.name === "code");
        if (code) setCodeDir(`${p.root.replace(/\/+$/, "")}/code`);
      },
      () => setCodeDir(null),
    );
  }, [host]);

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

  const repoFolderName = (r: SavedRepo): string | null => {
    const fromUrl = /^(?:https?:\/\/[^/]+\/)?([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(r.url.trim())?.[1];
    if (fromUrl) return fromUrl.split("/")[1]!;
    const name = r.displayName.trim();
    return name ? name.replace(/[^A-Za-z0-9._-]+/g, "-") : null;
  };
  const cloneDestination = (r: SavedRepo): string | null => {
    if (r.clonePath.trim()) return r.clonePath.trim();
    const name = repoFolderName(r);
    return codeDir && name ? `${codeDir}/${name}` : null;
  };
  const addRepo = () => edit((c) => addSavedRepo(c, provider.id));
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
            <Button disabled={!connected} onClick={addRepo}>Add repository</Button>
          </div>
          <p className="st-hint">
            {codeDir
              ? <>Clone destination: <code>{codeDir}/&lt;repo&gt;</code> — the <code>code/</code> path from Settings → Paths.</>
              : "Open a project to use its code/ folder as the clone destination."}
          </p>
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
                    <input className="st-input" value={r.clonePath} placeholder={cloneDestination(r) ?? "Where the Mac would clone it; not used yet"} spellCheck={false} onChange={(e) => patchRepo(r, { clonePath: e.target.value })} />
                  </label>
                  {codeDir && cloneDestination(r) ? (
                    <p className="st-hint">
                      Clone destination: <code>{cloneDestination(r)}</code>{" "}
                      {r.clonePath.trim() ? null : <Button onClick={() => patchRepo(r, { clonePath: cloneDestination(r) ?? "" })}>Use project code folder</Button>}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="st-hint">{REPOS_TEXT.cloneGap}</p>
        </div>

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
