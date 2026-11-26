// SSH server folder picker: a modal over the shell that lists folders on the server, starting at the home folder. The
// view is a plain function over the model's state, so it renders to markup and its handlers are called in tests; the
// wrapper only creates the model and listens for Escape. Modal classes come from the Welcome page (wc-modal).
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import "../welcome/welcome.css";
import "./remote-folder.css";
import { useModel, useStore } from "../settings/context.tsx";
import { Button, ErrorText } from "@llmide/ui-kit";
import { breadcrumbsFor, FolderPickerModel, type PickerDeps, type PickerState, type RemoteProject, type WorkspaceIo } from "./model.ts";

export const OUTSIDE_HOME_TEXT = "Outside your home folder";

/** Escape closes the picker only when no open or create is running: closing mid-open would hide its outcome. */
export function pickerEscapeCloses(busy: boolean): boolean {
  return !busy;
}

export interface FolderPickerViewProps {
  state: PickerState;
  onGo(path: string): void;
  onEnter(name: string): void;
  onSelect(name: string): void;
  onToggleHidden(): void;
  onStartNew(): void;
  onCancelNew(): void;
  onNewName(value: string): void;
  onCreate(): void;
  onOpenSelected(): void;
  onOpenCurrent(): void;
  onStartNewProject(): void;
  onCancelNewProject(): void;
  onNewProjectName(value: string): void;
  onCreateProject(): void;
  onRetryRegistration(): void;
  onKeepPending(): void;
  onClose(): void;
  /** Takes the initial focus when the picker opens. */
  listRef?: RefObject<HTMLUListElement | null>;
}

export function FolderPickerView(p: FolderPickerViewProps): ReactNode {
  const s = p.state;
  const busy = s.busy;
  const crumbs = s.path === null ? [] : breadcrumbsFor(s.path, s.home);
  const selectedEntry = s.entries.find((e) => e.name === s.selected) ?? null;
  // A created project whose registration warned is open already: the other actions wait for Try again or Continue.
  const pending = s.pending ?? null;
  return (
    <div className="wc-modal rf-modal">
      <div className="wc-modal-card rf-card" role="dialog" aria-modal="true" aria-labelledby="rf-title">
        <div className="wc-modal-head">
          <h2 id="rf-title" className="wc-h2">Open a folder on this server</h2>
        </div>
        <div className="wc-modal-body rf-body">
          {/* st-root gives the settings scale (gaps, rows, buttons). It sets height: 100%, so it is only used here, on an inner wrapper that remote-folder.css resets. */}
          <div className="st-root rf-inner">
            <nav className="rf-crumbs" aria-label="Folder path">
              {crumbs.map((c, i) => (
                <span key={c.path} className="rf-crumb">
                  {i > 0 ? <span className="rf-sep" aria-hidden="true">/</span> : null}
                  <button type="button" className="wc-link" disabled={busy || c.path === s.path} onClick={() => p.onGo(c.path)}>{c.label}</button>
                </span>
              ))}
            </nav>

            <div className="rf-toolbar">
              <label className="rf-check">
                <input type="checkbox" checked={s.showHidden} disabled={busy} onChange={() => p.onToggleHidden()} />
                <span>Show hidden</span>
              </label>
              <div className="rf-actions-row">
                <Button disabled={busy || s.path === null || s.creating || pending !== null} onClick={p.onStartNew}>New folder</Button>
                <Button disabled={busy || s.path === null || s.creatingProject || pending !== null} onClick={p.onStartNewProject}>New project…</Button>
              </div>
            </div>

            {s.creating ? (
              <form className="rf-new" onSubmit={(e) => { e.preventDefault(); p.onCreate(); }} noValidate>
                <label className="st-field">
                  <span className="st-label">Folder name</span>
                  <input
                    className="st-input"
                    aria-label="New folder name"
                    value={s.newName}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={s.newNameError ? true : undefined}
                    onChange={(e) => p.onNewName(e.currentTarget.value)}
                  />
                </label>
                <ErrorText text={s.newNameError} />
                <div className="st-row">
                  <Button tone="primary" disabled={busy} onClick={p.onCreate}>Create</Button>
                  <Button disabled={busy} onClick={p.onCancelNew}>Cancel</Button>
                </div>
              </form>
            ) : null}

            {s.creatingProject ? (
              <form className="rf-new" onSubmit={(e) => { e.preventDefault(); p.onCreateProject(); }} noValidate>
                <p className="rf-status">The project is created in {s.path ?? "this folder"} and opened.</p>
                <label className="st-field">
                  <span className="st-label">Project name</span>
                  <input
                    className="st-input"
                    aria-label="New project name"
                    value={s.newProjectName ?? ""}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={s.newProjectError ? true : undefined}
                    onChange={(e) => p.onNewProjectName(e.currentTarget.value)}
                  />
                </label>
                <ErrorText text={s.newProjectError ?? null} />
                <div className="st-row">
                  <Button tone="primary" disabled={busy} onClick={p.onCreateProject}>Create project</Button>
                  <Button disabled={busy} onClick={p.onCancelNewProject}>Cancel</Button>
                </div>
              </form>
            ) : null}

            {pending ? (
              <div className="rf-pending" role="status">
                <p className="rf-status">Project {pending.project.name} is open. It is not fully set up yet:</p>
                <ul className="rf-warnings">
                  {pending.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
                <div className="st-row">
                  <Button tone="primary" disabled={busy} onClick={p.onRetryRegistration}>Try again</Button>
                  <Button disabled={busy} onClick={p.onKeepPending}>Continue</Button>
                </div>
              </div>
            ) : null}

            <ErrorText text={s.error} />
            {s.loading ? <p className="rf-status" role="status">Loading…</p> : null}

            <ul ref={p.listRef} tabIndex={-1} className="rf-list" aria-label="Folders">
              {s.entries.map((e) => (
                <li key={e.name} className="rf-item">
                  <button
                    type="button"
                    className="rf-entry"
                    data-entry={e.name}
                    aria-selected={s.selected === e.name}
                    aria-disabled={e.outsideHome ? true : undefined}
                    disabled={e.outsideHome || busy}
                    title={e.outsideHome ? OUTSIDE_HOME_TEXT : undefined}
                    onClick={() => p.onSelect(e.name)}
                    onDoubleClick={e.outsideHome ? undefined : () => p.onEnter(e.name)}
                  >
                    <span className="rf-name">{e.name}</span>
                    {e.isLink ? <span className="rf-tag">link</span> : null}
                  </button>
                </li>
              ))}
              {!s.loading && s.path !== null && s.entries.length === 0 ? <li className="rf-empty">No folders here.</li> : null}
            </ul>
          </div>
        </div>
        <div className="wc-modal-foot rf-foot">
          <div className="st-root rf-actions">
            <Button disabled={busy || pending !== null || selectedEntry === null || selectedEntry.outsideHome} onClick={p.onOpenSelected}>Open</Button>
            {/* The home folder is not a project: the host refuses it, so the button is off there rather than failing. */}
            <Button tone="primary" disabled={busy || pending !== null || s.path === null || s.path === s.home} onClick={p.onOpenCurrent}>Open this folder</Button>
            <Button disabled={busy || pending !== null} onClick={p.onClose}>Cancel</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface FolderPickerProps {
  io: WorkspaceIo;
  deps: PickerDeps;
  /** The folder is open as the project; the shell closes the picker and goes home. */
  onOpened(project: RemoteProject): void;
  onClose(): void;
}

export function FolderPicker({ io, deps, onOpened, onClose }: FolderPickerProps): ReactNode {
  const m = useModel(() => new FolderPickerModel(io, deps));
  const s = useStore(m);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    void m.start();
    listRef.current?.focus();
  }, [m]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pickerEscapeCloses(s.busy || s.pending !== null)) onClose();
    };
    globalThis.addEventListener?.("keydown", onKey);
    return () => globalThis.removeEventListener?.("keydown", onKey);
  }, [onClose, s.busy, s.pending]);
  return (
    <FolderPickerView
      state={s}
      onGo={(path) => void m.goTo(path)}
      onEnter={(name) => void m.enter(name)}
      onSelect={(name) => m.select(name)}
      onToggleHidden={() => void m.toggleHidden()}
      onStartNew={() => m.startNewFolder()}
      onCancelNew={() => m.cancelNewFolder()}
      onNewName={(value) => m.setNewName(value)}
      onCreate={() => void m.createFolder()}
      onOpenSelected={() => void m.openSelected().then((project) => { if (project) onOpened(project); })}
      onOpenCurrent={() => void m.openCurrent().then((project) => { if (project) onOpened(project); })}
      onStartNewProject={() => m.startNewProject()}
      onCancelNewProject={() => m.cancelNewProject()}
      onNewProjectName={(value) => m.setNewProjectName(value)}
      onCreateProject={() => void m.createProject().then((project) => { if (project) onOpened(project); })}
      onRetryRegistration={() => void m.retryRegistration().then((project) => { if (project) onOpened(project); })}
      onKeepPending={() => { const project = m.keepPendingProject(); if (project) onOpened(project); }}
      onClose={onClose}
      listRef={listRef}
    />
  );
}
