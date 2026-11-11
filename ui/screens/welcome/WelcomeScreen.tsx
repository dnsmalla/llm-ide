import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FolderIcon, ChatIcon } from "@llmide/ui-kit";
import type { ProjectInfo, RecentEntry, RecentList } from "../shell/host";
import { safeText } from "../shell/safe-text";
import { openedAgo } from "../shell/relative-time";
import { NAME_MAX, PROJECT_EXPLAINER, validateProjectName } from "./model";
import { HELP_GROUPS, HELP_TOPICS, type HelpTopic } from "./help";

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

function HelpDiagram({ kind }: { kind: NonNullable<HelpTopic["diagram"]> }) {
  const box = (x: number, y: number, w: number, h: number, text: string, accent = false) => (
    <g key={`${x}-${y}-${text}`}>
      <rect x={x} y={y} width={w} height={h} rx="8" fill={accent ? "color-mix(in srgb, var(--tok-color-accent) 18%, var(--tok-color-surface2))" : "var(--tok-color-surface2)"} stroke={accent ? "var(--tok-color-accent)" : "var(--tok-color-border)"} />
      <text x={x + w / 2} y={y + h / 2 + 4 - (text.split("\n").length - 1) * 7} textAnchor="middle" fontSize="11" fill={accent ? "var(--tok-color-accent)" : "var(--tok-color-text)"}>
        {text.split("\n").map((line, i) => <tspan key={line} x={x + w / 2} dy={i === 0 ? 0 : 14}>{line}</tspan>)}
      </text>
    </g>
  );
  const arrow = (x1: number, y1: number, x2: number, y2: number) => (
    <line key={`${x1}-${y1}-${x2}-${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--tok-color-text-muted)" strokeWidth="1.5" markerEnd="url(#help-arrow)" />
  );
  const frame = (label: string, children: ReactNode) => (
    <svg className="help-svg" viewBox="0 0 720 210" role="img" aria-label={label}>
      <defs><marker id="help-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 10 5 0 10z" fill="var(--tok-color-text-muted)" /></marker></defs>
      {children}
    </svg>
  );
  if (kind === "project") {
    return frame("Project folder layout: source, code, data, llm-doc and system", <>
      {box(20, 76, 120, 46, "project/", true)}
      {box(190, 16, 150, 40, "source/")}{box(190, 68, 150, 40, "code/")}{box(190, 120, 150, 40, "data/")}
      {box(390, 68, 190, 40, "llm-doc/ notes & plans", true)}{box(390, 120, 190, 40, "system/ settings", false)}
      {arrow(140, 99, 190, 36)}{arrow(140, 99, 190, 88)}{arrow(140, 99, 190, 140)}{arrow(340, 88, 390, 88)}
    </>);
  }
  if (kind === "factory") {
    const labels = ["Inbox", "Needs decision", "Working", "Needs you", "Ready to ship", "Shipped", "Done"];
    return frame("Factory flow: Inbox to Needs decision, Working, Needs you, Ready to ship, Shipped, Done", <>
      {labels.map((label, i) => box(16 + (i % 4) * 172, i < 4 ? 44 : 118, 150, 42, label, i === 6))}
      {[0, 1, 2, 3, 4, 5].map((i) => arrow(166 + (i % 4) * 172, (i < 4 ? 65 : 139), 188 + (i % 4) * 172, (i < 4 ? 65 : 139)))}
    </>);
  }
  if (kind === "settings") {
    return frame("App settings apply everywhere; project settings apply to this folder", <>
      {box(40, 40, 300, 130, "App settings\nworkspace · providers · models", true)}
      {box(380, 40, 300, 130, "Project settings\npaths · repos · memory · graph", false)}
      {arrow(340, 105, 380, 105)}
    </>);
  }
  if (kind === "issue") {
    return frame("Issue page: discussion on the left, editable settings on the right", <>
      {box(24, 28, 400, 152, "Issue\ncomments · description", true)}
      {box(470, 28, 220, 152, "Settings\nstatus · labels · milestone\nassignees · dates", false)}
      {arrow(424, 104, 470, 104)}
    </>);
  }
  if (kind === "terminal") {
    return frame("Terminal dock inside the project", <>
      <rect x="30" y="26" width="660" height="158" rx="10" fill="var(--tok-color-body)" stroke="var(--tok-color-border)" />
      <circle cx="52" cy="48" r="4" fill="var(--tok-color-danger)" /><circle cx="68" cy="48" r="4" fill="var(--tok-color-accent4)" /><circle cx="84" cy="48" r="4" fill="var(--tok-color-accent3)" />
      <text x="48" y="92" fontFamily="var(--tok-type-mono-family)" fontSize="13" fill="var(--tok-color-text)">$ npm test</text>
      <text x="48" y="118" fontFamily="var(--tok-type-mono-family)" fontSize="13" fill="var(--tok-color-accent3)">✓ 397 tests passed</text>
      <text x="48" y="158" fontFamily="var(--tok-type-mono-family)" fontSize="12" fill="var(--tok-color-text-muted)">$ █</text>
    </>);
  }
  return frame("Workspace flow: project to Library and Explorer, to Chat, Graph and Issues, to Loop and Factory", <>
    {box(18, 80, 120, 46, "Project", true)}
    {box(180, 80, 160, 46, "Library / Explorer")}
    {box(382, 80, 160, 46, "Chat · Graph · Issues")}
    {box(584, 80, 118, 46, "Loop · Factory", false)}
    {arrow(138, 103, 180, 103)}{arrow(340, 103, 382, 103)}{arrow(542, 103, 584, 103)}
  </>);
}

export function GuideDialog({ onClose, onNavigate }: { onClose: () => void; onNavigate?: (target: NonNullable<HelpTopic["target"]>, settingsGroup?: string) => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(HELP_TOPICS[0]!.id);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const q = query.trim().toLowerCase();
  const topics = q === "" ? HELP_TOPICS : HELP_TOPICS.filter((t) => `${t.title} ${t.what} ${t.steps.join(" ")} ${t.example ?? ""}`.toLowerCase().includes(q));
  const active = topics.find((t) => t.id === activeId) ?? topics[0] ?? null;
  return (
    <div className="wc-modal" role="dialog" aria-modal="true" aria-labelledby="wc-guide-title" data-testid="guide">
      <div className="wc-modal-card help-card">
        <div className="wc-modal-head">
          <div>
            <h2 id="wc-guide-title" className="wc-h2">Help &amp; Support</h2>
            <p className="help-sub">Every screen and every setting, in beginner steps.</p>
          </div>
          <button ref={close} type="button" className="sh-button" onClick={onClose}>Close</button>
        </div>
        <div className="help-search">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search screens, settings or a recipe…" aria-label="Search help" autoComplete="off" />
        </div>
        <div className="help-body">
          <nav className="help-nav" aria-label="Help topics">
            {HELP_GROUPS.map((group) => {
              const list = HELP_TOPICS.filter((t) => t.group === group);
              if (list.length === 0 || (q !== "" && !list.some((t) => topics.includes(t)))) return null;
              return (
                <section key={group}>
                  <h3 className="help-nav-title">{group}</h3>
                  <ul>
                    {list.filter((t) => topics.includes(t)).map((t) => (
                      <li key={t.id} className="help-nav-row">
                        <button type="button" className="help-nav-item" aria-current={active?.id === t.id ? "page" : undefined} onClick={() => setActiveId(t.id)}>{t.title}</button>
                        {t.target && onNavigate ? <button type="button" className="help-nav-go" aria-label={`Open ${t.title}`} title={`Open ${t.title}`} onClick={() => onNavigate(t.target!, t.settingsGroup)}>↗</button> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {topics.length === 0 ? <p className="help-empty">No topic matches “{query.trim()}”.</p> : null}
          </nav>
          <article className="help-content" aria-live="polite">
            {active ? (
              <>
                <p className="help-kicker">{active.group}</p>
                <h3 className="help-title">{active.title}</h3>
                <p className="help-what">{active.what}</p>
                {active.diagram ? <HelpDiagram kind={active.diagram} /> : null}
                <h4 className="help-h4">Try it</h4>
                <ol className="help-steps">{active.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
                {active.example ? <p className="help-example"><strong>Example:</strong> {active.example}</p> : null}
                {active.target && onNavigate ? <button type="button" className="help-open" onClick={() => onNavigate(active.target!, active.settingsGroup)}>{active.group === "Settings" ? "Open Settings" : `Open ${active.title}`} →</button> : null}
              </>
            ) : null}
          </article>
        </div>
      </div>
    </div>
  );
}

function RecentRow({ entry, busy, onOpen, onForget }: { entry: RecentEntry; busy: boolean; onOpen: () => void; onForget: () => void }) {
  const name = dateless(entry.name, 60) || "project";
  const ok = entry.status === "ok";
  const reason = ok ? null : dateless(entry.reason ?? "This folder cannot be opened.", 160);
  // "" when the entry has no time (stored before times were kept) or the time does not parse: then nothing shows.
  const ago = openedAgo(entry.openedAt);
  return (
    <li className="wc-recent" data-status={entry.status}>
      <button type="button" className="wc-recent-open" disabled={!ok || busy} aria-disabled={!ok || busy} onClick={onOpen} title={ok ? `Open ${name}` : (reason ?? undefined)}>
        <span className="wc-recent-icon" aria-hidden="true"><FolderIcon /></span>
        <span className="wc-recent-text">
          <span className="wc-recent-name">{name}</span>
          <span className="wc-recent-path" title={dateless(entry.root, 400)}>{dateless(entry.root, 300)}</span>
          {reason && <span className="wc-recent-reason" role="note">{reason}</span>}
        </span>
        {ago && <span className="wc-recent-ago" title={`Last opened ${ago}`}>{ago}</span>}
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
          <div className="wc-features" aria-label="What the workspace includes">
            <span>Meetings & notes</span><span>Code & graph</span><span>AI runs & factory</span>
          </div>
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
