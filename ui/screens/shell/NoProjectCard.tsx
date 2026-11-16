// The one "this screen needs a project" card every project-dependent screen shows instead of a disabled or empty
// pane. Two clear paths, like the Welcome page: create a project (opens Welcome at the name field) or open one.
import { shellBus } from "./bus";
import { inSshMode } from "./host";
import { projectStore } from "./project-store";
import { serverFolderHandler } from "./server-folder";
import { safeText } from "./safe-text";

export interface NoProjectCardProps {
  /** Finishes "Open or create a project to ...", e.g. "chat", "browse files". */
  what?: string;
  /** Replaces the whole title, for a screen that cannot create or pick a local project (SSH server folders). */
  title?: string;
  /** Extra sentence under the title. */
  hint?: string;
}

/**
 * Plain actions, injectable for tests. An action that is left out is not shown: a screen that has no local dialog
 * (SSH server mode) offers only the action it can perform.
 */
export interface NoProjectActions {
  newProject?(): void;
  openProject?(): void;
  /** Label of the open button; the default is the local folder dialog's wording. */
  openLabel?: string;
}

export const defaultNoProjectActions: NoProjectActions = {
  newProject: () => shellBus.publish({ type: "goto-section", section: "welcome", anchor: "new" }),
  openProject: () => void projectStore.openFolder(),
};

/**
 * The card's actions for a mode. This computer's local dialogs (New project, the native folder dialog) are offered only
 * outside ssh mode; in ssh mode the one action is the server folder picker, and only when the shell has one.
 */
export function noProjectActionsFor(ssh: boolean, openServerFolder: (() => void) | null): NoProjectActions {
  if (ssh) return openServerFolder ? { openProject: openServerFolder, openLabel: "Open server folder…" } : {};
  return defaultNoProjectActions;
}

export function NoProjectCard({ what = "get started", title, hint, actions }: NoProjectCardProps & { actions?: NoProjectActions }) {
  const resolved = actions ?? noProjectActionsFor(inSshMode(), serverFolderHandler());
  const heading = title !== undefined ? safeText(title, 120) : `Open or create a project to ${safeText(what, 60)}`;
  return (
    <div className="np" role="region" aria-label="No project open" data-testid="no-project">
      <div className="np-card">
        <h2 className="np-title">{heading}</h2>
        <p className="np-text">{hint ? safeText(hint, 200) : "A project is a folder that keeps your notes, files and chats together. Nothing here works until one is open."}</p>
        <div className="np-actions">
          {resolved.newProject ? <button type="button" className="sh-button sh-button-primary" onClick={resolved.newProject}>New project…</button> : null}
          {resolved.openProject ? <button type="button" className="sh-button" onClick={resolved.openProject}>{resolved.openLabel ?? "Open existing project…"}</button> : null}
        </div>
      </div>
    </div>
  );
}
