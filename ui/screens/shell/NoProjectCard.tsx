// The one "this screen needs a project" card every project-dependent screen shows instead of a disabled or empty
// pane. Two clear paths, like the Welcome page: create a project (opens Welcome at the name field) or open one.
import { shellBus } from "./bus";
import { projectStore } from "./project-store";
import { safeText } from "./safe-text";

export interface NoProjectCardProps {
  /** Finishes "Open or create a project to ...", e.g. "chat", "browse files". */
  what?: string;
  /** Extra sentence under the title. */
  hint?: string;
}

/** Plain actions, injectable for tests. */
export interface NoProjectActions {
  newProject(): void;
  openProject(): void;
}

export const defaultNoProjectActions: NoProjectActions = {
  newProject: () => shellBus.publish({ type: "goto-section", section: "welcome", anchor: "new" }),
  openProject: () => void projectStore.openFolder(),
};

export function NoProjectCard({ what = "get started", hint, actions = defaultNoProjectActions }: NoProjectCardProps & { actions?: NoProjectActions }) {
  return (
    <div className="np" role="region" aria-label="No project open" data-testid="no-project">
      <div className="np-card">
        <h2 className="np-title">Open or create a project to {safeText(what, 60)}</h2>
        <p className="np-text">{hint ? safeText(hint, 200) : "A project is a folder that keeps your notes, files and chats together. Nothing here works until one is open."}</p>
        <div className="np-actions">
          <button type="button" className="sh-button sh-button-primary" onClick={actions.newProject}>New project…</button>
          <button type="button" className="sh-button" onClick={actions.openProject}>Open existing project…</button>
        </div>
      </div>
    </div>
  );
}
