import { useEffect, useRef, useState, type FormEvent } from "react";
import { FolderIcon, ChatIcon } from "@llmide/ui-kit";
import type { ProjectInfo, RecentEntry, RecentList } from "../shell/host";
import { safeText } from "../shell/safe-text";
import { GUIDE, NAME_MAX, PROJECT_EXPLAINER, validateProjectName } from "./model";

/** What the Welcome page needs from the shell. Every function is host- or core-backed in the app and a fake in tests. */
export interface WelcomeActions {
  createProject(name: string): Promise<ProjectInfo | null>;
  openFolder(): Promise<void>;
  openRecent(openIndex: number): Promise<void>;
  forgetRecent(entry: RecentEntry): Promise<void>;
  closeProject(): Promise<void>;
  /** Switch to the project home after a project was opened or created. */
  goHome(): void;
}

export interface WelcomeProps {
  project: ProjectInfo | null;
  recent: RecentList;
  /** Last store error (host text, untrusted). */
  error: string | null;
  actions: WelcomeActions;
  /** Bumps when something asks for the New project form (a "New project" button elsewhere). */
  focusNew?: number;
  /** Guide dialog initially open (tests). */
  guideOpen?: boolean;
  /** Bumps when something asks for the guide (the account menu's "Help & Guide"). */
  guideSignal?: number;
}

const dateless = (s: string, max: number) => safeText(s, max);

export function GuideDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="wc-modal" role="dialog" aria-modal="true" aria-labelledby="wc-guide-title" data-testid="guide">
      <div className="wc-modal-card">
        <div className="wc-modal-head">
          <h2 id="wc-guide-title" className="wc-h2">How LLM-IDE works</h2>
          <button ref={close} type="button" className="sh-button" onClick={onClose}>Close</button>
        </div>
        <div className="wc-modal-body">
          {GUIDE.map((g) => (
            <section key={g.id} aria-labelledby={`wc-g-${g.id}`}>
              <h3 id={`wc-g-${g.id}`} className="wc-h3">{g.title}</h3>
              {g.paragraphs.map((p, i) => <p key={i} className="wc-text">{p}</p>)}
              {g.steps && <ol className="wc-steps">{g.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function RecentRow({ entry, busy, onOpen, onForget }: { entry: RecentEntry; busy: boolean; onOpen: () => void; onForget: () => void }) {
  const name = dateless(entry.name, 60) || "project";
  const ok = entry.status === "ok";
  const reason = ok ? null : dateless(entry.reason ?? "This folder cannot be opened.", 160);
  return (
    <li className="wc-recent" data-status={entry.status}>
      <button type="button" className="wc-recent-open" disabled={!ok || busy} aria-disabled={!ok || busy} onClick={onOpen} title={ok ? `Open ${name}` : (reason ?? undefined)}>
        <span className="wc-recent-icon" aria-hidden="true"><FolderIcon /></span>
        <span className="wc-recent-text">
          <span className="wc-recent-name">{name}</span>
          <span className="wc-recent-path" title={dateless(entry.root, 400)}>{dateless(entry.root, 300)}</span>
          {reason && <span className="wc-recent-reason" role="note">{reason}</span>}
        </span>
      </button>
      <button type="button" className="sh-button wc-forget" disabled={busy} aria-label={`Remove ${name} from the recent list. Your files are not deleted.`} title="Remove from this list. Your files are not deleted." onClick={onForget}>
        Forget
      </button>
    </li>
  );
}

export function WelcomeScreen({ project, recent, error, actions, focusNew = 0, guideOpen = false, guideSignal = 0 }: WelcomeProps) {
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "open" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [guide, setGuide] = useState(guideOpen);
  const [resetDismissed, setResetDismissed] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (focusNew > 0) nameInput.current?.focus();
  }, [focusNew]);
  useEffect(() => {
    if (guideSignal > 0) setGuide(true);
  }, [guideSignal]);

  const run = async (kind: "create" | "open", fn: () => Promise<boolean>) => {
    setBusy(kind);
    setLocalError(null);
    try {
      if (await fn()) actions.goHome();
    } catch (e) {
      if (alive.current) setLocalError(safeText(e instanceof Error ? e.message : String(e), 240));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    const check = validateProjectName(name);
    if (!check.ok) {
      setNameError(check.error);
      nameInput.current?.focus();
      return;
    }
    setNameError(null);
    void run("create", async () => (await actions.createProject(check.name)) !== null);
  };

  const shownError = localError ?? (error ? safeText(error, 240) : null);
  const disabled = busy !== null;
  return (
    <div className="wc" data-testid="welcome">
      <div className="wc-inner">
        <header className="wc-hero">
          <span className="wc-logo" aria-hidden="true"><ChatIcon /></span>
          <h1 className="wc-h1">LLM-IDE</h1>
          <p className="wc-lead">Meeting intelligence and project control. Each project lives in its own folder: meetings, notes, plans and code, side by side.</p>
        </header>

        {recent.reset && !resetDismissed && (
          <div className="wc-banner" role="status" data-kind="reset">
            <div>
              <strong>The recent-projects list was reset</strong>
              <p className="wc-text">The saved list could not be read, so it was ignored. Your project folders are untouched: reopen them with Open existing project.</p>
            </div>
            <button type="button" className="sh-button" onClick={() => setResetDismissed(true)}>Dismiss</button>
          </div>
        )}
        {shownError && <div className="wc-banner" role="alert" data-kind="error"><p className="wc-text">{shownError}</p></div>}

        {project && (
          <section className="wc-current" aria-label="Current project">
            <div className="wc-current-text">
              <span className="wc-eyebrow">Current project</span>
              <strong className="wc-recent-name">{safeText(project.name, 60)}</strong>
              <span className="wc-recent-path" title={safeText(project.root, 400)}>{safeText(project.root, 300)}</span>
            </div>
            <div className="wc-current-actions">
              <button type="button" className="sh-button sh-button-primary" onClick={() => actions.goHome()}>Continue</button>
              <button type="button" className="sh-button" disabled={disabled} title="Close the project. Nothing is deleted." onClick={() => void run("open", async () => { await actions.closeProject(); return false; })}>Close project</button>
            </div>
          </section>
        )}

        <div className="wc-cards">
          <form className="wc-card" onSubmit={onCreate} aria-labelledby="wc-new-title" aria-busy={busy === "create"} noValidate>
            <h2 id="wc-new-title" className="wc-h2">New project</h2>
            <p className="wc-text wc-muted">Name it, then choose where it should live. LLM-IDE creates the folder and sets up the workspace in it.</p>
            <label className="sh-field">
              <span>Project name</span>
              <input ref={nameInput} name="projectName" type="text" value={name} maxLength={NAME_MAX + 20} autoComplete="off" spellCheck={false} disabled={disabled}
                aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? "wc-name-error" : undefined}
                onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null); }} placeholder="My project" />
            </label>
            {nameError && <div id="wc-name-error" role="alert" className="sh-form-error">{nameError}</div>}
            <button type="submit" className="sh-button sh-button-primary" disabled={disabled}>{busy === "create" ? "Creating…" : "Choose location…"}</button>
          </form>

          <section className="wc-card" aria-labelledby="wc-open-title">
            <h2 id="wc-open-title" className="wc-h2">Open existing project</h2>
            <p className="wc-text wc-muted">Resume an LLM-IDE project, or adopt a folder you have already, such as a cloned repository.</p>
            <button type="button" className="sh-button sh-button-primary" disabled={disabled} onClick={() => void run("open", async () => { await actions.openFolder(); return true; })}>
              {busy === "open" ? "Opening…" : "Open folder…"}
            </button>
          </section>
        </div>

        <aside className="wc-explainer" aria-label="What is a project">
          <strong>What counts as a project folder?</strong>
          <p className="wc-text wc-muted">{PROJECT_EXPLAINER}</p>
        </aside>

        <section className="wc-recents" aria-labelledby="wc-recent-title">
          <div className="wc-recents-head">
            <h2 id="wc-recent-title" className="wc-eyebrow">Recent projects</h2>
            <span className="wc-muted">{recent.entries.length}</span>
          </div>
          {recent.entries.length === 0 ? (
            <p className="wc-text wc-muted">No recent projects yet.</p>
          ) : (
            <ul className="wc-recent-list">
              {recent.entries.map((e) => (
                <RecentRow key={`${e.storedIndex}:${e.root}`} entry={e} busy={disabled}
                  onOpen={() => e.openIndex !== null && void run("open", async () => { await actions.openRecent(e.openIndex!); return true; })}
                  onForget={() => void actions.forgetRecent(e).catch((err: unknown) => setLocalError(safeText(err instanceof Error ? err.message : String(err), 240)))} />
              ))}
            </ul>
          )}
        </section>

        <p className="wc-guide-link">
          <button type="button" className="wc-link" onClick={() => setGuide(true)}>New here? Open the guide</button>
        </p>
      </div>
      {guide && <GuideDialog onClose={() => setGuide(false)} />}
    </div>
  );
}
