import { useCallback, useEffect, useRef, useState } from "react";
import { shellBus } from "../../shell/bus";
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
  shouldProvision,
  toggleAllowedOp,
  updateSavedRepo,
  repoKeyOf,
  repoPathOf,
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
 * Tokens are stored write-only; Check token verifies the saved one through the core. Clone goes through the host.
 * The remaining gaps (pull/re-sync, the Mac's resolve step) are stated in the card.
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
  const [checking, setChecking] = useState(false);
  // Tokens saved in this session live only in memory; the vault never returns them. They make Clone one click.
  const [memoryTokens, setMemoryTokens] = useState<Record<RepoProvider, string | null>>({ gitlab: null, github: null });
  const [cloneFor, setCloneFor] = useState<string | null>(null);
  const [cloneToken, setCloneToken] = useState("");
  const [cloning, setCloning] = useState<string | null>(null);
  const [cloneNotice, setCloneNotice] = useState<string | null>(null);
  // Keyed by owner/repo, not by saved-repo id: a corrected URL is a new repository and must still import.
  const imported = useRef(new Set<string>());

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
  const gitlabHost = hostOf(cfg.gitlabBaseUrl);
  const checkSupported = provider.id === "github" || (gitlabHost !== "" && /^https:\/\//i.test(normalizeBase(cfg.gitlabBaseUrl)));
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
      setMemoryTokens((m) => ({ ...m, [provider.id]: value }));
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

  const checkToken = async () => {
    setChecking(true);
    setError(null);
    setStatus(null);
    try {
      const body = await call(client, "POST", "/kb/repos/check-token", {
        provider: provider.id,
        ...(provider.id === "gitlab" ? { baseUrl: normalizeBase(cfg.gitlabBaseUrl) } : {}),
      });
      const b = body && typeof body === "object" ? body as { login?: unknown; name?: unknown; scopes?: unknown } : {};
      const login = typeof b.login === "string" ? b.login : "";
      const scopes = Array.isArray(b.scopes) ? b.scopes.filter((x): x is string => typeof x === "string") : [];
      setStatus(`Token works${login ? ` for @${login}` : ""}${scopes.length ? ` · ${scopes.join(", ")}` : ""}.`);
    } catch (e) {
      setError(sourcesError(e));
    } finally {
      setChecking(false);
    }
  };

  const clearToken = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await call(client, "POST", "/auth/me/secrets", { key: provider.tokenKey, value: null });
      setMemoryTokens((m) => ({ ...m, [provider.id]: null }));
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
    // The folder is the project's last path segment (GitLab: group/sub/project clones into code/project).
    const path = repoPathOf(r.url);
    if (path) return path.split("/").pop()!;
    const name = r.displayName.trim();
    return name ? name.replace(/[^A-Za-z0-9._-]+/g, "-") : null;
  };
  const cloneDestination = (r: SavedRepo): string | null => {
    if (r.clonePath.trim()) return r.clonePath.trim();
    const name = repoFolderName(r);
    return codeDir && name ? `${codeDir}/${name}` : null;
  };
  const addRepo = () => edit((c) => addSavedRepo(c, provider.id));

  /** Import a repository's open issues into the core cache, so Issues and Gantt show them with no extra step. */
  const importIssuesFor = async (r: SavedRepo, quiet: boolean): Promise<number | null> => {
    // GitLab projects can sit in nested groups, so they keep their full path; GitHub is owner/name.
    const slug = repoKeyOf(provider.id, r.url);
    const key = `${provider.id}:${slug}`;
    if (!slug || imported.current.has(key) || !connected) return null;
    imported.current.add(key);
    try {
      const body = await call(client, "POST", "/kb/connect-github-issues", { provider: provider.id, repo: slug, state: "open" });
      const n = body && typeof body === "object" && typeof (body as { count?: unknown }).count === "number" ? (body as { count: number }).count : null;
      shellBus.publish({ type: "project-changed" });
      if (!quiet) setStatus(n === null ? `Imported ${slug} issues.` : `Imported ${n} issue${n === 1 ? "" : "s"} from ${slug}.`);
      return n;
    } catch (e) {
      imported.current.delete(key);
      if (!quiet) setError(sourcesError(e));
      return null;
    }
  };

  /**
   * Clones one repository. `quiet`: an existing folder counts as success. `silent`: a failure is not shown in the banner
   * (an automatic attempt on blur); the explicit Clone action still reports it.
   */
  const doClone = async (r: SavedRepo, token: string, opts: { quiet?: boolean; silent?: boolean } = {}): Promise<boolean> => {
    if (!host.cloneRepository) return false;
    const dest = cloneDestination(r);
    if (!dest) {
      setError("Save a repository URL first.");
      return false;
    }
    setCloning(r.id);
    setError(null);
    setCloneNotice(null);
    try {
      const result = await host.cloneRepository({ provider: provider.id, url: r.url, token: token.trim() || undefined });
      edit((c) => updateSavedRepo(c, provider.id, r.id, { clonePath: result.path }));
      // Register the clone with the core so issues/graph may read it; Library → Sources owns this allow-list.
      await call(client, "POST", "/auth/me/repos", { path: result.path }).catch(() => undefined);
      setCloneFor(null);
      setCloneToken("");
      shellBus.publish({ type: "project-changed" });
      setCloneNotice(`Cloned ${result.name} into code/. Open Library or Explorer to browse it.`);
      // Make the same repository visible in Issues/Gantt: import its open issues into the core cache.
      await importIssuesFor(r, true);
      return true;
    } catch (e) {
      const msg = sourcesError(e);
      if (opts.quiet && /already exists/i.test(msg)) return true;
      if (!opts.silent) setError(msg);
      return false;
    } finally {
      setCloning(null);
    }
  };

  /**
   * Adding/finishing a repository URL makes its code and issues appear without another trip to Settings. Only a
   * finished, valid URL triggers it (on blur): while typing, "owner/re" is a valid-looking partial name.
   */
  const autoProvision = (r: SavedRepo) => {
    void importIssuesFor(r, true);
    // Attempt the clone even without a session token: public repositories clone that way; a private one
    // reports the auth failure and the explicit Clone prompt still accepts a token.
    if (host.cloneRepository && codeDir && !cloning) void doClone(r, memoryTokens[provider.id] ?? "", { quiet: true, silent: true });
  };
  const startClone = (r: SavedRepo) => {
    // A clone already running (blur-triggered, or a double click) owns the attempt; a second one would race it.
    if (cloning) return;
    setError(null);
    // Public repositories clone on the first click; only an auth failure reveals the token prompt.
    void doClone(r, memoryTokens[provider.id] ?? "", { quiet: true }).then((ok) => {
      if (!ok) { setCloneFor(r.id); setCloneToken(""); }
    });
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
            {connected ? <Button disabled={busy || checking || !checkSupported} label={checkSupported ? "Check token" : "Enter a valid GitLab instance URL first"} onClick={() => void checkToken()}>{checking ? "Checking…" : "Check token"}</Button> : null}
            {connected ? <Button tone="danger" disabled={busy || checking} onClick={() => void clearToken()}>Clear token</Button> : null}
          </div>
          <span className="st-hint">
            Stored write-only in the core vault; the saved value is never shown again. {REPOS_TEXT.saveOnly}
          </span>
        </label>
        {connected ? <p className="st-ok" role="status">Connected · {provider.id === "gitlab" ? hostOf(cfg.gitlabBaseUrl) || "custom instance" : "github.com"}</p> : null}
        {status ? <p className="st-ok" role="status">{status}</p> : null}
        {cloneNotice ? <p className="st-ok" role="status">{cloneNotice} <Button onClick={() => shellBus.publish({ type: "goto-section", section: "library" })}>Open Library</Button></p> : null}

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
                      onBlur={() => { if (shouldProvision(r)) autoProvision(r); }}
                    />
                    {urlError(r) ? <span className="st-hint" role="alert">{urlError(r)}</span> : null}
                  </label>
                  <div className="st-field">
                    <span className="st-label">Local clone</span>
                    <span className="st-pre">{r.clonePath.trim() || "Not cloned"}</span>
                    {codeDir && cloneDestination(r) ? <span className="st-hint">Clone destination: <code>{cloneDestination(r)}</code></span> : null}
                  </div>
                  {host.cloneRepository && codeDir && cloneDestination(r) ? (
                    cloneFor === r.id ? (
                      <div className="st-row">
                        <input
                          className="st-input st-grow"
                          type="password"
                          value={cloneToken}
                          placeholder={memoryTokens[provider.id] ? "Saved token will be used" : "Token (optional for public repositories)"}
                          onChange={(e) => setCloneToken(e.target.value)}
                          aria-label={`${provider.label} token for clone`}
                        />
                        <Button tone="primary" disabled={cloning !== null} onClick={() => void doClone(r, cloneToken || memoryTokens[provider.id] || "")}>
                          {cloning === r.id ? "Cloning…" : "Clone"}
                        </Button>
                        <Button disabled={cloning !== null} onClick={() => setCloneFor(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <div className="st-row">
                        <Button disabled={cloning !== null || !r.url.trim()} onClick={() => startClone(r)}>{cloning === r.id ? "Cloning…" : "Clone repository"}</Button>
                        {memoryTokens[provider.id] ? <span className="st-hint">Uses the token saved in this session.</span> : null}
                      </div>
                    )
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
    return new URL(normalizeBase(raw)).host || "";
  } catch {
    return "";
  }
}
