// The Connections panes of the Library: Email, Slack, Box, Repositories and the connector catalog (with
// MCP-backed connectors such as Miro). Each pane is a form over the typed actions in source-actions.ts and the
// ingest runners in ingest.ts; secrets are write-only fields that go straight to the core's vault.
//
// Rules the panes keep:
//  - A secret typed here is sent once and cleared; it is never shown again, never stored in page state after
//    the request, never put in localStorage (only non-secret settings are, see source-config.ts).
//  - Every long action shows progress and has a Stop button; an error is shown in our words (source-core.ts).
//  - Destructive actions (disconnect, remove) ask first and say exactly what is and is not deleted.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { LibraryExtension } from "../LibraryNav";
import { Dialog } from "../write/Dialog";
import type { WriteHost } from "../write/write-host.ts";
import { fetchEmail, fetchMcp, fetchMessage, fetchSlack, IDLE_FETCH, startEmailFromNow, type FetchProgress } from "./ingest.ts";
import {
  addRepo, indexBox, indexGithubIssues, indexRepo, listCatalog, listRepos, mcpStart, mcpStatus, mcpTest, pollUntil, removeRepo, selectConnector, slackConversations, slackStart, slackStatus, testBox, testEmail, testSlack,
  type CatalogEntry, type RepoEntry,
} from "./source-actions.ts";
import {
  browserStorage, DEFAULT_BOX, DEFAULT_EMAIL, DEFAULT_GITHUB, DEFAULT_SLACK, loadConfigs, saveConfigs, secretProblem, validateBox, validateEmail, validateGithub, validateSlack, validateSlackChannelId,
  type BoxConfig, type EmailConfig, type GithubIssuesConfig, type KeyValueStorage, type SecretKind, type SlackChannel, type SlackConfig, type SourceConfigs,
} from "./source-config.ts";
import { linkState, linkStateText, listSecretKeys, mapThrown, saveSecret, SourceError, sourceErrorText, type LinkState, type SourceSecretKey, type SourcesCore } from "./source-core.ts";
import * as T from "./source-text.ts";
import { GooglePane } from "./google/GooglePane";
import { GuideCard } from "./google/GuideCard";
import * as EZ from "./google/easy.ts";

export interface PaneEnv {
  core: SourcesCore;
  /** Where fetched notes are created (wrapped so the list updates without a rescan). */
  write: WriteHost;
  storage?: KeyValueStorage | null;
  /** Opens an allowlisted https URL in the system browser through the host. */
  openExternal: (url: string) => Promise<void>;
  /** Native folder dialog for repositories; null when not in the desktop app. */
  pickFolder: (() => Promise<{ path: string; name: string } | null>) | null;
  now?: () => number;
  /** Opens a Google sign-in address through the host opener; false when the user declined its prompt. Falls back to `openExternal`. */
  openAuth?: (url: string) => Promise<boolean>;
  /** True when a notes folder is chosen (Gmail notes cannot be saved without one). Unset: not checked. */
  hasNotesRoot?: () => Promise<boolean>;
}

// ---- shared pieces ---------------------------------------------------------------------------

interface Task {
  busy: boolean;
  error: SourceError | null;
  /** Runs `fn` with a fresh abort signal; at most one at a time. Resolves undefined on failure or cancel. */
  run: <R>(fn: (signal: AbortSignal) => Promise<R>) => Promise<R | undefined>;
  stop: () => void;
  clear: () => void;
}

function useTask(): Task {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SourceError | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const run = useCallback(async <R,>(fn: (signal: AbortSignal) => Promise<R>): Promise<R | undefined> => {
    if (abort.current) return undefined;
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setError(null);
    try {
      return await fn(ac.signal);
    } catch (e) {
      const err = mapThrown(e, ac.signal);
      if (err.code !== "cancelled") setError(err);
      return undefined;
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }, []);
  return useMemo(() => ({ busy, error, run, stop: () => abort.current?.abort(), clear: () => setError(null) }), [busy, error, run]);
}

function ErrorLine({ task, what }: { task: Task; what: string }): ReactNode {
  if (!task.error) return null;
  return (
    <StatusBanner severity={task.error.code === "cancelled" ? "info" : "error"} message={`${sourceErrorText(task.error.code, what)}${task.error.serverCode ? ` (${task.error.serverCode})` : ""}`} onDismiss={task.clear} />
  );
}

function Badge({ state }: { state: LinkState }): ReactNode {
  return (
    <span className="lib-badge" data-state={state === "linked" ? "ok" : "off"}>
      {linkStateText(state)}
    </span>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }): ReactNode {
  return (
    <label className="lib-field">
      <span>{label}</span>
      {children}
      {error && (
        <span className="lib-muted" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, busy }: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy: boolean }): ReactNode {
  return (
    <Dialog title={title} onClose={onClose} role="alertdialog" busy={busy}>
      <div className="lib-form">
        <p>{message}</p>
        <div className="lib-modal-actions">
          <button type="button" className="lib-btn" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="button" className="lib-btn lib-btn-danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** A credential input that can only be written: it saves to the vault, clears itself and never shows the value. */
export function SecretField({ env, label, secretKey, kind, saved, onSaved, onTest }: { env: PaneEnv; label: string; secretKey: SourceSecretKey; kind: SecretKind; saved: boolean; onSaved: () => void; onTest?: (typed: string, signal: AbortSignal) => Promise<string> }): ReactNode {
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const task = useTask();
  const problem = value === "" ? null : secretProblem(kind, value);
  const save = (): void => {
    const pr = secretProblem(kind, value);
    if (pr) return setNote(pr);
    void task.run(async (signal) => {
      await saveSecret(env.core, secretKey, value, signal);
      setValue("");
      setNote("Saved in the core's vault. The value is not shown again.");
      onSaved();
    });
  };
  const test = (): void => {
    if (!onTest) return;
    void task.run(async (signal) => {
      setNote(await onTest(value, signal));
      setValue("");
    });
  };
  return (
    <div className="lib-field">
      <label htmlFor={`secret-${secretKey}`}>
        <span>
          {label} {saved && <span className="lib-badge" data-state="ok">Saved in vault</span>}
        </span>
      </label>
      <div className="lib-editor-bar">
        <input id={`secret-${secretKey}`} type="password" autoComplete="off" spellCheck={false} value={value} placeholder={saved ? "Saved. Type to replace." : "Paste the value"} onChange={(e) => { setValue(e.target.value); setNote(null); }} aria-invalid={problem !== null} />
        <button type="button" className="lib-btn" onClick={save} disabled={task.busy || value === ""}>
          {saved ? "Replace" : "Save"}
        </button>
        {onTest && (
          <button type="button" className="lib-btn" onClick={test} disabled={task.busy || value === ""} title="Tries the typed value without saving it">
            Test without saving
          </button>
        )}
      </div>
      {problem && (
        <span className="lib-muted" role="alert">
          {problem}
        </span>
      )}
      {note && (
        <span className="lib-muted" role="status">
          {note}
        </span>
      )}
      <ErrorLine task={task} what="this credential" />
    </div>
  );
}

function FetchStatus({ p, onStop, busy }: { p: FetchProgress; onStop: () => void; busy: boolean }): ReactNode {
  if (p.phase === "idle") return null;
  if (p.phase === "error") return null;
  return (
    <div role="status" aria-live="polite" className="lib-editor-bar">
      <span>{fetchMessage(p)}</span>
      {busy && (
        <button type="button" className="lib-link-btn" onClick={onStop}>
          Stop
        </button>
      )}
    </div>
  );
}

function usePersisted(env: PaneEnv): { configs: SourceConfigs; update: (patch: Partial<SourceConfigs>) => void; persisted: boolean } {
  const storage = env.storage === undefined ? browserStorage() : env.storage;
  const [configs, setConfigs] = useState<SourceConfigs>(() => loadConfigs(storage));
  const [persisted, setPersisted] = useState(true);
  const update = useCallback(
    (patch: Partial<SourceConfigs>) => {
      // Merge into what is stored NOW, so saving one source never overwrites another's settings.
      const next = { ...loadConfigs(storage), ...patch };
      setConfigs(next);
      setPersisted(saveConfigs(storage, next));
    },
    [storage],
  );
  return { configs, update, persisted };
}

function useVaultKeys(env: PaneEnv): { keys: ReadonlySet<string>; refresh: () => void; failed: boolean } {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    listSecretKeys(env.core, ac.signal).then(
      (k) => {
        setKeys(k);
        setFailed(false);
      },
      () => !ac.signal.aborted && setFailed(true),
    );
    return () => ac.abort();
  }, [env.core, n]);
  return { keys, refresh: () => setN((x) => x + 1), failed };
}

function PersistNote({ persisted }: { persisted: boolean }): ReactNode {
  return persisted ? null : <StatusBanner severity="warning" message="These settings could not be remembered on this computer (browser storage is blocked). You will need to enter them again next time." />;
}

// ---- Email -----------------------------------------------------------------------------------

export function EmailPane({ env }: { env: PaneEnv }): ReactNode {
  const { configs, update, persisted } = usePersisted(env);
  const vault = useVaultKeys(env);
  const legacyGoogle = configs.email?.authMethod === "google";
  // The old Gmail-over-IMAP sign-in (full-mailbox scope) is not offered here any more: the Google pane replaces it.
  const [cfg, setCfg] = useState<EmailConfig>(configs.email ? { ...configs.email, authMethod: "password" } : DEFAULT_EMAIL);
  const [saved, setSaved] = useState(configs.email !== null && !legacyGoogle);
  const [info, setInfo] = useState<string | null>(null);
  const [progress, setProgress] = useState<FetchProgress>(IDLE_FETCH);
  const [disconnect, setDisconnect] = useState(false);
  const task = useTask();
  const problems = validateEmail(cfg);
  const valid = Object.keys(problems).length === 0;
  const set = <K extends keyof EmailConfig>(k: K, v: EmailConfig[K]): void => {
    setCfg((c) => ({ ...c, [k]: v }));
    setSaved(false);
  };
  const state = linkState(configs.email !== null, vault.keys, ["email.imapPassword"]);
  const saveSettings = (): void => {
    if (!valid) return;
    update({ email: cfg });
    setSaved(true);
    setInfo("Settings saved.");
  };
  const connectFromNow = (): void => {
    void task.run(async (signal) => {
      await startEmailFromNow(env.core, signal, (env.now ?? Date.now)());
      setInfo("From now on, new mail will be imported when you fetch.");
    });
  };
  return (
    <div className="lib-pane" role="region" aria-label="Email source">
      <h2>
        Email <Badge state={state} />
      </h2>
      <p className="lib-muted">{T.EMAIL_INTRO}</p>
      <p className="lib-muted">{T.PATTERN_B}</p>
      <PersistNote persisted={persisted} />
      <section className="lib-pane-section" aria-label="Mailbox settings">
        <h3>Mailbox</h3>
        <Field label="IMAP server" error={problems.host}>
          <input type="text" value={cfg.host} onChange={(e) => set("host", e.target.value)} aria-invalid={!!problems.host} />
        </Field>
        <div className="lib-editor-bar">
          <Field label="Port" error={problems.port}>
            <input type="number" value={cfg.port} min={1} max={65535} onChange={(e) => set("port", Number(e.target.value))} />
          </Field>
          <label className="lib-check">
            <input type="checkbox" checked={cfg.secure} onChange={(e) => set("secure", e.target.checked)} /> Encrypted connection (TLS)
          </label>
        </div>
        <Field label="User name" error={problems.user}>
          <input type="text" autoComplete="off" value={cfg.user} onChange={(e) => set("user", e.target.value)} aria-invalid={!!problems.user} />
        </Field>
        <Field label="Mailbox" error={problems.mailbox}>
          <input type="text" value={cfg.mailbox} onChange={(e) => set("mailbox", e.target.value)} />
        </Field>
        <Field label="Days to look back on each fetch" error={problems.lookbackDays}>
          <input type="number" min={1} max={90} value={cfg.lookbackDays} onChange={(e) => set("lookbackDays", Number(e.target.value))} />
        </Field>
        <Field label="Only from (optional)" error={problems.fromFilter}>
          <input type="text" value={cfg.fromFilter} onChange={(e) => set("fromFilter", e.target.value)} />
        </Field>
        <label className="lib-check">
          <input type="checkbox" checked={cfg.unreadOnly} onChange={(e) => set("unreadOnly", e.target.checked)} /> Unread messages only
        </label>
        <label className="lib-check">
          <input type="checkbox" checked={cfg.markRead} onChange={(e) => set("markRead", e.target.checked)} /> Mark fetched messages as read
        </label>
        {cfg.markRead && <p className="lib-muted">{T.EMAIL_MARK_READ}</p>}
        {legacyGoogle && <StatusBanner severity="warning" message={T.EMAIL_GOOGLE_MOVED} />}
        <p className="lib-muted">{T.EMAIL_APP_PASSWORD}</p>
        <SecretField
          env={env}
          label="App password"
          secretKey="email.imapPassword"
          kind="email"
          saved={vault.keys.has("email.imapPassword")}
          onSaved={vault.refresh}
          onTest={async (typed, signal) => {
            const r = await testEmail(env.core, cfg, typed, signal);
            return `Connected to ${r.mailbox || "the mailbox"}: ${r.total.toLocaleString()} messages, ${r.recent.toLocaleString()} recent. The value was not saved.`;
          }}
        />
        <p className="lib-muted">{T.EMAIL_GOOGLE_POINTER}</p>
        <div className="lib-editor-bar">
          <button type="button" className="lib-btn lib-btn-primary" onClick={saveSettings} disabled={!valid || saved}>
            Save settings
          </button>
          <button
            type="button"
            className="lib-btn"
            disabled={!valid || task.busy}
            onClick={() =>
              void task.run(async (signal) => {
                const r = await testEmail(env.core, cfg, null, signal);
                setInfo(`Connected to ${r.mailbox || "the mailbox"}: ${r.total.toLocaleString()} messages, ${r.recent.toLocaleString()} recent.`);
              })
            }
          >
            Test connection
          </button>
        </div>
      </section>
      <section className="lib-pane-section" aria-label="Fetch">
        <h3>Fetch</h3>
        <div className="lib-editor-bar">
          <button
            type="button"
            className="lib-btn lib-btn-primary"
            disabled={!saved || !valid || task.busy}
            onClick={() =>
              void task.run(async (signal) => {
                setProgress({ ...IDLE_FETCH, phase: "fetching" });
                setProgress(await fetchEmail(cfg, { core: env.core, write: env.write, signal, onProgress: setProgress, now: env.now }));
              })
            }
          >
            Fetch new mail
          </button>
          <button type="button" className="lib-btn" disabled={!saved || task.busy} onClick={connectFromNow} title="Skip everything already in the mailbox; import only mail that arrives from now on.">
            Start from now
          </button>
        </div>
        <FetchStatus p={progress} onStop={task.stop} busy={task.busy} />
        {progress.phase === "error" && progress.error && <StatusBanner severity="error" message={`${sourceErrorText(progress.error, "the mailbox")}${progress.serverCode ? ` (${progress.serverCode})` : ""}`} />}
      </section>
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      <ErrorLine task={task} what="the mailbox" />
      {vault.failed && <StatusBanner severity="warning" message="The saved-credential status could not be read from the core." />}
      {configs.email !== null && (
        <div>
          <button type="button" className="lib-btn lib-btn-danger" onClick={() => setDisconnect(true)}>
            Disconnect…
          </button>
        </div>
      )}
      {disconnect && (
        <ConfirmDialog
          title="Disconnect Email?"
          message={T.DISCONNECT_TEXT.email}
          confirmLabel="Disconnect"
          busy={task.busy}
          onClose={() => setDisconnect(false)}
          onConfirm={() =>
            void task.run(async (signal) => {
              await saveSecret(env.core, "email.imapPassword", null, signal);
              update({ email: null });
              setCfg(DEFAULT_EMAIL);
              setSaved(false);
              setDisconnect(false);
              vault.refresh();
            })
          }
        />
      )}
    </div>
  );
}

// ---- Gmail easy card (app password over IMAP; the Email pane's routes, fewer fields) ----------

/** Gmail with an app password: address + write-only app password, then Save / Fetch. Reuses the Email source's
 *  settings, vault key (`email.imapPassword`), test route and fetch runner, so the Email pane shows the same mailbox. */
export function GmailEasyCard({ env }: { env: PaneEnv }): ReactNode {
  const { configs, update, persisted } = usePersisted(env);
  const vault = useVaultKeys(env);
  const existing = configs.email;
  const [address, setAddress] = useState(existing && /@(gmail|googlemail)\.com$/i.test(existing.user) ? existing.user : "");
  const [saved, setSaved] = useState(existing !== null && existing.host === "imap.gmail.com");
  const [info, setInfo] = useState<string | null>(null);
  const [progress, setProgress] = useState<FetchProgress>(IDLE_FETCH);
  const task = useTask();
  const addrProblem = address === "" ? null : EZ.validateGmailAddress(address);
  const cfg: EmailConfig = { ...DEFAULT_EMAIL, ...(existing && existing.host === "imap.gmail.com" ? existing : null), host: "imap.gmail.com", port: 993, secure: true, user: address.trim(), authMethod: "password" };
  const state = linkState(saved, vault.keys, ["email.imapPassword"]);
  return (
    <section className="lib-pane-section" aria-label="Easy setup: Gmail">
      <h3>
        Gmail <Badge state={state} />
      </h3>
      <GuideCard guide={EZ.GMAIL_GUIDE} notes={EZ.GMAIL_NOTES} />
      <p className="lib-muted">
        Where to find it: {EZ.GMAIL_WHERE}.{" "}
        <button type="button" className="lib-link-btn" onClick={() => EZ.isGoogleAccountHome(EZ.GOOGLE_ACCOUNT_HOME) && void env.openExternal(EZ.GOOGLE_ACCOUNT_HOME).catch(() => setInfo("Opening links is not available yet."))}>
          Open your Google Account
        </button>
      </p>
      <PersistNote persisted={persisted} />
      <Field label="Gmail address" error={addrProblem ?? undefined}>
        <input type="text" autoComplete="off" spellCheck={false} value={address} onChange={(e) => { setAddress(e.target.value); setSaved(false); }} aria-invalid={addrProblem !== null} />
      </Field>
      <SecretField
        env={env}
        label="App password"
        secretKey="email.imapPassword"
        kind="email"
        saved={vault.keys.has("email.imapPassword")}
        onSaved={vault.refresh}
        onTest={async (typed, signal) => {
          const r = await testEmail(env.core, cfg, typed, signal);
          return `Connected to ${r.mailbox || "the mailbox"}: ${r.total.toLocaleString()} messages. The value was not saved.`;
        }}
      />
      <div className="lib-editor-bar">
        <button
          type="button"
          className="lib-btn lib-btn-primary"
          disabled={address === "" || addrProblem !== null || saved}
          onClick={() => {
            update({ email: cfg });
            setSaved(true);
            setInfo("Saved. Press Fetch new mail, or Start from now to import only mail that arrives from now on.");
          }}
        >
          Save address
        </button>
        <button
          type="button"
          className="lib-btn"
          disabled={!saved || task.busy}
          onClick={() =>
            void task.run(async (signal) => {
              setProgress({ ...IDLE_FETCH, phase: "fetching" });
              setProgress(await fetchEmail(cfg, { core: env.core, write: env.write, signal, onProgress: setProgress, now: env.now }));
            })
          }
        >
          Fetch new mail
        </button>
        <button type="button" className="lib-btn" disabled={!saved || task.busy} onClick={() => void task.run(async (signal) => { await startEmailFromNow(env.core, signal, (env.now ?? Date.now)()); setInfo("From now on, new mail will be imported when you fetch."); })}>
          Start from now
        </button>
      </div>
      <FetchStatus p={progress} onStop={task.stop} busy={task.busy} />
      {progress.phase === "error" && progress.error && <StatusBanner severity="error" message={`${sourceErrorText(progress.error, "the mailbox")}${progress.serverCode ? ` (${progress.serverCode})` : ""}`} />}
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      <ErrorLine task={task} what="Gmail" />
    </section>
  );
}

// ---- Slack -----------------------------------------------------------------------------------

export function SlackPane({ env }: { env: PaneEnv }): ReactNode {
  const { configs, update, persisted } = usePersisted(env);
  const vault = useVaultKeys(env);
  const [cfg, setCfg] = useState<SlackConfig>(configs.slack ?? DEFAULT_SLACK);
  const [saved, setSaved] = useState(configs.slack !== null);
  const [available, setAvailable] = useState<SlackChannel[] | null>(null);
  const [complete, setComplete] = useState(true);
  const [manual, setManual] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [progress, setProgress] = useState<FetchProgress>(IDLE_FETCH);
  const [disconnect, setDisconnect] = useState(false);
  const task = useTask();
  const problems = validateSlack(cfg);
  const valid = Object.keys(problems).length === 0;
  const state = linkState(configs.slack !== null, vault.keys, ["slack.userToken", "slack.botToken"]);
  const chosen = new Set(cfg.channels.map((c) => c.id));
  const toggle = (c: SlackChannel): void => {
    setCfg((x) => ({ ...x, channels: chosen.has(c.id) ? x.channels.filter((y) => y.id !== c.id) : [...x.channels, c].slice(0, 100) }));
    setSaved(false);
  };
  const connect = (): void => {
    void task.run(async (signal) => {
      const s = await slackStart(env.core, signal);
      await env.openExternal(s.authUrl);
      setInfo("Approve LLM-IDE in Slack in your browser. This window waits for up to 5 minutes.");
      const st = await pollUntil(async () => {
        const r = await slackStatus(env.core, s.state, signal);
        if (r.status === "error" || r.status === "unknown") throw new SourceError("upstream_auth");
        return r.status === "complete" ? r : null;
      }, { intervalMs: 2000, maxMs: 300_000, signal });
      setInfo(`Connected${st.account ? ` to ${st.account}` : ""}. Load your channels next.`);
      vault.refresh();
      const conv = await slackConversations(env.core, signal);
      setAvailable(conv.channels);
      setComplete(conv.complete);
    });
  };
  return (
    <div className="lib-pane" role="region" aria-label="Slack source">
      <h2>
        Slack <Badge state={state} />
      </h2>
      <p className="lib-muted">{T.SLACK_INTRO}</p>
      <p className="lib-muted">{T.PATTERN_B}</p>
      <PersistNote persisted={persisted} />
      <section className="lib-pane-section" aria-label="Connection">
        <h3>Connection</h3>
        <div className="lib-editor-bar">
          <button type="button" className="lib-btn lib-btn-primary" onClick={connect} disabled={task.busy}>
            Connect Slack
          </button>
          {task.busy && (
            <button type="button" className="lib-link-btn" onClick={task.stop}>
              Stop waiting
            </button>
          )}
        </div>
        <p className="lib-muted">{T.SLACK_TOKEN_NOTE}</p>
        <SecretField
          env={env}
          label="Slack token (optional)"
          secretKey="slack.botToken"
          kind="slack"
          saved={vault.keys.has("slack.botToken")}
          onSaved={vault.refresh}
          onTest={async (typed, signal) => {
            const r = await testSlack(env.core, typed, signal);
            return `Token works for ${r.team || "the workspace"} as ${r.user || "the bot"}. The value was not saved.`;
          }}
        />
        <button
          type="button"
          className="lib-btn"
          disabled={task.busy || state === "not_configured"}
          onClick={() =>
            void task.run(async (signal) => {
              const r = await testSlack(env.core, null, signal);
              setInfo(`Connected to ${r.team || "the workspace"} as ${r.user || "the bot"}.`);
            })
          }
        >
          Test saved connection
        </button>
      </section>
      <section className="lib-pane-section" aria-label="Channels">
        <h3>Channels</h3>
        <div className="lib-editor-bar">
          <button
            type="button"
            className="lib-btn"
            disabled={task.busy}
            onClick={() =>
              void task.run(async (signal) => {
                const conv = await slackConversations(env.core, signal);
                setAvailable(conv.channels);
                setComplete(conv.complete);
              })
            }
          >
            Load my channels
          </button>
        </div>
        {!complete && <StatusBanner severity="warning" message="The channel list is incomplete (Slack rate-limited the request). Load it again, or add a channel by its id." />}
        {available && (
          <ul className="lib-items" aria-label="Channels you can import" style={{ maxHeight: 240, overflow: "auto" }}>
            {available.map((c) => (
              <li key={c.id}>
                <label className="lib-check">
                  <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c)} /> #{c.name || c.id}
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="lib-editor-bar">
          <Field label="Add a channel by id" error={manual !== "" && !validateSlackChannelId(manual) ? "Channel ids start with C, G or D (open the channel's details in Slack)." : undefined}>
            <input type="text" value={manual} onChange={(e) => setManual(e.target.value.toUpperCase())} />
          </Field>
          <button
            type="button"
            className="lib-btn"
            disabled={!validateSlackChannelId(manual) || chosen.has(manual.trim())}
            onClick={() => {
              toggle({ id: manual.trim(), name: "" });
              setManual("");
            }}
          >
            Add
          </button>
        </div>
        <p className="lib-muted" aria-live="polite">
          {cfg.channels.length === 0 ? "No channels chosen." : `Chosen: ${cfg.channels.map((c) => `#${c.name || c.id}`).join(", ")}`}
        </p>
        {problems.channels && cfg.channels.length > 0 && <span className="lib-muted">{problems.channels}</span>}
        <Field label="Days to look back on each fetch" error={problems.lookbackDays}>
          <input type="number" min={1} max={90} value={cfg.lookbackDays} onChange={(e) => { setCfg((x) => ({ ...x, lookbackDays: Number(e.target.value) })); setSaved(false); }} />
        </Field>
        <button type="button" className="lib-btn lib-btn-primary" disabled={!valid || saved} onClick={() => { update({ slack: cfg }); setSaved(true); setInfo("Settings saved."); }}>
          Save settings
        </button>
      </section>
      <section className="lib-pane-section" aria-label="Fetch">
        <h3>Fetch</h3>
        <button
          type="button"
          className="lib-btn lib-btn-primary"
          disabled={!saved || !valid || task.busy}
          onClick={() =>
            void task.run(async (signal) => {
              setProgress({ ...IDLE_FETCH, phase: "fetching" });
              setProgress(await fetchSlack(cfg.channels, cfg.lookbackDays, { core: env.core, write: env.write, signal, onProgress: setProgress, now: env.now }));
            })
          }
        >
          Fetch new messages
        </button>
        <FetchStatus p={progress} onStop={task.stop} busy={task.busy} />
        {progress.phase === "error" && progress.error && <StatusBanner severity="error" message={`${sourceErrorText(progress.error, "Slack")}${progress.serverCode ? ` (${progress.serverCode})` : ""}`} />}
      </section>
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      <ErrorLine task={task} what="Slack" />
      {configs.slack !== null && (
        <div>
          <button type="button" className="lib-btn lib-btn-danger" onClick={() => setDisconnect(true)}>
            Disconnect…
          </button>
        </div>
      )}
      {disconnect && (
        <ConfirmDialog
          title="Disconnect Slack?"
          message={T.DISCONNECT_TEXT.slack}
          confirmLabel="Disconnect"
          busy={task.busy}
          onClose={() => setDisconnect(false)}
          onConfirm={() =>
            void task.run(async (signal) => {
              await saveSecret(env.core, "slack.botToken", null, signal);
              await saveSecret(env.core, "slack.userToken", null, signal);
              update({ slack: null });
              setCfg(DEFAULT_SLACK);
              setSaved(false);
              setDisconnect(false);
              vault.refresh();
            })
          }
        />
      )}
    </div>
  );
}

// ---- Box -------------------------------------------------------------------------------------

export function BoxPane({ env }: { env: PaneEnv }): ReactNode {
  const { configs, update, persisted } = usePersisted(env);
  const vault = useVaultKeys(env);
  const [cfg, setCfg] = useState<BoxConfig>(configs.box ?? DEFAULT_BOX);
  const [saved, setSaved] = useState(configs.box !== null);
  const [info, setInfo] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState(false);
  const task = useTask();
  const problems = validateBox(cfg);
  const valid = Object.keys(problems).length === 0;
  const state = linkState(configs.box !== null, vault.keys, ["box.clientSecret"]);
  const set = <K extends keyof BoxConfig>(k: K, v: BoxConfig[K]): void => {
    setCfg((c) => ({ ...c, [k]: v }));
    setSaved(false);
  };
  return (
    <div className="lib-pane" role="region" aria-label="Box source">
      <h2>
        Box <Badge state={state} />
      </h2>
      <p className="lib-muted">{T.BOX_INTRO}</p>
      <PersistNote persisted={persisted} />
      <section className="lib-pane-section" aria-label="Box settings">
        <h3>Folder and app</h3>
        <Field label="Client ID" error={problems.clientId}>
          <input type="text" autoComplete="off" value={cfg.clientId} onChange={(e) => set("clientId", e.target.value)} aria-invalid={!!problems.clientId} />
        </Field>
        <SecretField env={env} label="Client secret" secretKey="box.clientSecret" kind="box" saved={vault.keys.has("box.clientSecret")} onSaved={vault.refresh} />
        <fieldset className="lib-field lib-radio">
          <legend>The app acts for</legend>
          <label>
            <input type="radio" name="box-subject" checked={cfg.subjectType === "enterprise"} onChange={() => set("subjectType", "enterprise")} /> Enterprise
          </label>
          <label>
            <input type="radio" name="box-subject" checked={cfg.subjectType === "user"} onChange={() => set("subjectType", "user")} /> User
          </label>
        </fieldset>
        <Field label={cfg.subjectType === "enterprise" ? "Enterprise ID" : "User ID"} error={problems.subjectId}>
          <input type="text" inputMode="numeric" value={cfg.subjectId} onChange={(e) => set("subjectId", e.target.value)} />
        </Field>
        <Field label="Folder ID" error={problems.folderId}>
          <input type="text" inputMode="numeric" value={cfg.folderId} onChange={(e) => set("folderId", e.target.value)} />
        </Field>
        <div className="lib-editor-bar">
          <button type="button" className="lib-btn lib-btn-primary" disabled={!valid || saved} onClick={() => { update({ box: cfg }); setSaved(true); setInfo("Settings saved."); }}>
            Save settings
          </button>
          <button
            type="button"
            className="lib-btn"
            disabled={!valid || task.busy}
            onClick={() =>
              void task.run(async (signal) => {
                const r = await testBox(env.core, cfg, signal);
                setInfo(`Folder "${r.folderName}" found with ${r.itemCount.toLocaleString()} items.`);
              })
            }
          >
            Test connection
          </button>
        </div>
      </section>
      <section className="lib-pane-section" aria-label="Index">
        <h3>Index</h3>
        <div className="lib-editor-bar">
          <button
            type="button"
            className="lib-btn lib-btn-primary"
            disabled={!saved || !valid || task.busy}
            onClick={() =>
              void task.run(async (signal) => {
                setInfo("Indexing the folder. This can take several minutes for a large folder.");
                const r = await indexBox(env.core, cfg, signal);
                setInfo(`Indexed ${r.files.toLocaleString()} files (${r.indexed.toLocaleString()} passages)${r.skipped ? `; ${r.skipped.toLocaleString()} had no readable text` : ""}${r.truncated ? ". The folder was larger than the core's limit, so only part of it was indexed." : "."}`);
              })
            }
          >
            Index folder now
          </button>
          {task.busy && (
            <button type="button" className="lib-link-btn" onClick={task.stop}>
              Stop waiting
            </button>
          )}
        </div>
        <p className="lib-muted">{T.BOX_STOP_NOTE}</p>
      </section>
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      <ErrorLine task={task} what="Box" />
      {configs.box !== null && (
        <div>
          <button type="button" className="lib-btn lib-btn-danger" onClick={() => setDisconnect(true)}>
            Disconnect…
          </button>
        </div>
      )}
      {disconnect && (
        <ConfirmDialog
          title="Disconnect Box?"
          message={T.DISCONNECT_TEXT.box}
          confirmLabel="Disconnect"
          busy={task.busy}
          onClose={() => setDisconnect(false)}
          onConfirm={() =>
            void task.run(async (signal) => {
              await saveSecret(env.core, "box.clientSecret", null, signal);
              update({ box: null });
              setCfg(DEFAULT_BOX);
              setSaved(false);
              setDisconnect(false);
              vault.refresh();
            })
          }
        />
      )}
    </div>
  );
}

// ---- Repositories ----------------------------------------------------------------------------

export function ReposPane({ env }: { env: PaneEnv }): ReactNode {
  const { configs, update, persisted } = usePersisted(env);
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [n, setN] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RepoEntry | null>(null);
  const [gh, setGh] = useState<GithubIssuesConfig>(configs.github ?? DEFAULT_GITHUB);
  const task = useTask();
  const loadTask = useTask();
  useEffect(() => {
    void loadTask.run(async (signal) => setRepos(await listRepos(env.core, signal)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.core, n]);
  const ghProblems = validateGithub(gh);
  const describe = (c: Record<string, number>): string => {
    const parts = Object.entries(c).map(([k, v]) => `${v.toLocaleString()} ${k.replace(/_/g, " ")}`);
    return parts.length ? parts.join(", ") : "done";
  };
  return (
    <div className="lib-pane" role="region" aria-label="Repositories source">
      <h2>Repositories</h2>
      <p className="lib-muted">{T.REPOS_INTRO}</p>
      <section className="lib-pane-section" aria-label="Approved repositories">
        <h3>Approved repositories</h3>
        {env.pickFolder ? (
          <div className="lib-editor-bar">
            <button
              type="button"
              className="lib-btn lib-btn-primary"
              disabled={task.busy}
              onClick={() =>
                void task.run(async (signal) => {
                  const picked = await env.pickFolder!();
                  if (!picked) return;
                  const path = await addRepo(env.core, picked.path, picked.name, signal);
                  setInfo(`Approved ${path}.`);
                  setN((x) => x + 1);
                })
              }
            >
              Add a repository…
            </button>
          </div>
        ) : (
          <StatusBanner severity="info" message="Choosing a folder is only possible inside the desktop app." />
        )}
        {repos === null && !loadTask.error && <p className="lib-muted" role="status">Loading…</p>}
        <ErrorLine task={loadTask} what="the repository list" />
        {repos && repos.length === 0 && <p className="lib-muted">No repositories approved yet.</p>}
        {repos && repos.length > 0 && (
          <ul className="lib-items" aria-label="Approved repositories">
            {repos.map((r) => (
              <li key={r.path}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{r.label ?? r.path.slice(r.path.lastIndexOf("/") + 1)}</strong> <span className="lib-muted lib-path">{r.path}</span>
                </span>
                <button
                  type="button"
                  className="lib-btn"
                  disabled={task.busy}
                  onClick={() =>
                    void task.run(async (signal) => {
                      setInfo(`Indexing ${r.path}…`);
                      const res = await indexRepo(env.core, r.path, signal);
                      setInfo(`Indexed ${r.path}: ${describe(res.counts)}.`);
                    })
                  }
                >
                  Index
                </button>
                <button type="button" className="lib-btn lib-btn-danger" disabled={task.busy} onClick={() => setRemoving(r)}>
                  Remove…
                </button>
              </li>
            ))}
          </ul>
        )}
        {task.busy && (
          <button type="button" className="lib-link-btn" onClick={task.stop}>
            Stop waiting
          </button>
        )}
      </section>
      <section className="lib-pane-section" aria-label="GitHub issues">
        <h3>GitHub issues</h3>
        <p className="lib-muted">{T.GITHUB_NOTE}</p>
        <Field label="Repository (owner/name)" error={gh.repo !== "" ? ghProblems.repo : undefined}>
          <input type="text" value={gh.repo} onChange={(e) => setGh((g) => ({ ...g, repo: e.target.value }))} />
        </Field>
        <Field label="Issues">
          <select value={gh.state} onChange={(e) => setGh((g) => ({ ...g, state: e.target.value as GithubIssuesConfig["state"] }))}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </Field>
        <button
          type="button"
          className="lib-btn"
          disabled={Object.keys(ghProblems).length > 0 || task.busy}
          onClick={() =>
            void task.run(async (signal) => {
              update({ github: gh });
              const res = await indexGithubIssues(env.core, gh, signal);
              setInfo(`Indexed issues of ${gh.repo}: ${describe(res.counts)}.`);
            })
          }
        >
          Index issues
        </button>
      </section>
      <PersistNote persisted={persisted} />
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      <ErrorLine task={task} what="the repository" />
      {removing && (
        <ConfirmDialog
          title="Remove this repository?"
          message={`${removing.path} is removed from your approved list, so the core can no longer index or change it. The folder and its files are not touched.`}
          confirmLabel="Remove"
          busy={task.busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            void task.run(async (signal) => {
              await removeRepo(env.core, removing.path, signal);
              setRemoving(null);
              setN((x) => x + 1);
            })
          }
        />
      )}
    </div>
  );
}

// ---- Connector catalog (MCP-backed) ----------------------------------------------------------

export function ConnectorsPane({ env }: { env: PaneEnv }): ReactNode {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [n, setN] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, FetchProgress>>({});
  const [tools, setTools] = useState<Record<string, string[]>>({});
  const [removing, setRemoving] = useState<CatalogEntry | null>(null);
  const task = useTask();
  const load = useTask();
  useEffect(() => {
    void load.run(async (signal) => setCatalog(await listCatalog(env.core, signal)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.core, n]);
  const connect = (e: CatalogEntry): void => {
    void task.run(async (signal) => {
      const s = await mcpStart(env.core, e.id, signal);
      if (!s.alreadyConnected && s.authUrl) {
        await env.openExternal(s.authUrl);
        setInfo(`Finish signing in to ${e.name} in your browser. This window waits for up to 5 minutes.`);
        await pollUntil(async () => ((await mcpStatus(env.core, e.id, s.state, signal)).connected ? true : null), { intervalMs: 2000, maxMs: 300_000, signal });
      }
      setInfo(`Connected to ${e.name}.`);
    });
  };
  return (
    <div className="lib-pane" role="region" aria-label="Connector catalog">
      <h2>Connectors</h2>
      <p className="lib-muted">{T.CATALOG_INTRO}</p>
      <p className="lib-muted">{T.CATALOG_SELECTION_NOTE}</p>
      {catalog === null && !load.error && <p className="lib-muted" role="status">Loading…</p>}
      <ErrorLine task={load} what="the connector list" />
      {catalog && (
        <ul className="lib-items" aria-label="Connectors" style={{ gap: "var(--tok-space-md)" }}>
          {catalog.map((e) => {
            const p = progress[e.id];
            const mcpReady = e.pipelineReady && /oauth/.test(e.authKind) && e.id !== "box" && e.id !== "slack";
            return (
              <li key={e.id} style={{ display: "block", width: "100%" }}>
                <section className="lib-pane-section" aria-label={e.name}>
                  <h3>
                    {e.name} <span className="lib-badge" data-state={e.selected ? "ok" : "off"}>{e.selected ? "Shown" : "Hidden"}</span>
                  </h3>
                  <p>{e.description}</p>
                  {e.docsUrl && (
                    <button type="button" className="lib-link-btn" onClick={() => void env.openExternal(e.docsUrl!).catch(() => setInfo("Opening links is not available yet."))}>
                      Documentation
                    </button>
                  )}
                  {!e.pipelineReady && <p className="lib-muted">{T.NOT_READY}</p>}
                  {e.id === "box" && <p className="lib-muted">Set up in the Box pane.</p>}
                  {e.id === "slack" && <p className="lib-muted">Set up in the Slack pane.</p>}
                  <div className="lib-editor-bar">
                    {e.selected ? (
                      <button type="button" className="lib-btn" disabled={task.busy} onClick={() => setRemoving(e)}>
                        Remove from Library…
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="lib-btn"
                        disabled={task.busy}
                        onClick={() =>
                          void task.run(async (signal) => {
                            await selectConnector(env.core, e.id, true, signal);
                            setN((x) => x + 1);
                          })
                        }
                      >
                        Add to Library
                      </button>
                    )}
                    {e.selected && mcpReady && (
                      <>
                        <button type="button" className="lib-btn" disabled={task.busy} onClick={() => connect(e)}>
                          Connect
                        </button>
                        <button
                          type="button"
                          className="lib-btn"
                          disabled={task.busy}
                          onClick={() =>
                            void task.run(async (signal) => {
                              const r = await mcpTest(env.core, e.id, signal);
                              setTools((t) => ({ ...t, [e.id]: r.tools }));
                            })
                          }
                        >
                          Test connection
                        </button>
                        <button
                          type="button"
                          className="lib-btn lib-btn-primary"
                          disabled={task.busy}
                          onClick={() =>
                            void task.run(async (signal) => {
                              const set = (pp: FetchProgress): void => setProgress((m) => ({ ...m, [e.id]: pp }));
                              set(await fetchMcp(e.id, { core: env.core, write: env.write, signal, onProgress: set, now: env.now }));
                            })
                          }
                        >
                          Fetch now
                        </button>
                      </>
                    )}
                  </div>
                  {e.selected && mcpReady && <p className="lib-muted">{T.MCP_UNVERIFIED}</p>}
                  {tools[e.id] && (
                    <p className="lib-muted" role="status">
                      Tools offered: {tools[e.id]!.length === 0 ? "none reported" : tools[e.id]!.join(", ")}
                    </p>
                  )}
                  {p && p.phase !== "idle" && <FetchStatus p={p} onStop={task.stop} busy={task.busy} />}
                  {p?.phase === "error" && p.error && <StatusBanner severity="error" message={`${sourceErrorText(p.error, e.name)}${p.serverCode ? ` (${p.serverCode})` : ""}`} />}
                </section>
              </li>
            );
          })}
        </ul>
      )}
      {task.busy && (
        <button type="button" className="lib-link-btn" onClick={task.stop}>
          Stop
        </button>
      )}
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      <ErrorLine task={task} what="the connector" />
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name} from your Library?`}
          message={T.CATALOG_SELECTION_NOTE}
          confirmLabel="Remove from Library"
          busy={task.busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            void task.run(async (signal) => {
              await selectConnector(env.core, removing.id, false, signal);
              setRemoving(null);
              setN((x) => x + 1);
            })
          }
        />
      )}
    </div>
  );
}

// ---- entry list ------------------------------------------------------------------------------

/** The "Connections" group of the Library sidebar. */
export function sourceConnections(env: PaneEnv): LibraryExtension[] {
  return [
    { id: "src-email", label: "Email", render: () => <EmailPane env={env} /> },
    { id: "src-google", label: "Google", render: () => <GooglePane env={env} gmailCard={<GmailEasyCard env={env} />} /> },
    { id: "src-slack", label: "Slack", render: () => <SlackPane env={env} /> },
    { id: "src-box", label: "Box", render: () => <BoxPane env={env} /> },
    { id: "src-repos", label: "Repositories", render: () => <ReposPane env={env} /> },
    { id: "src-connectors", label: "Connectors", render: () => <ConnectorsPane env={env} /> },
  ];
}
