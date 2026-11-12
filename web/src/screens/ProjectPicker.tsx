import type { ProjectsState, ProjectRefusalCode } from "../projects/controller.ts";
import { Skeleton } from "../ui/index.ts";

const REFUSAL: Record<ProjectRefusalCode, string> = {
  PROJECT_REQUIRED: "A project is required.",
  PROJECT_DENIED: "The desktop refused this project.",
  PROJECT_MISMATCH: "This project doesn't match the desktop.",
};

export interface ProjectPickerProps {
  state: ProjectsState;
  /** Disable only the control, never the reason: the picker stays usable after a refusal. */
  disabled?: boolean;
  onSelect: (id: string) => void;
}

/** Project name + the caller's role, persisted by the controller. Host text is rendered as text. */
export function ProjectPicker({ state, disabled = false, onSelect }: ProjectPickerProps) {
  const selected = state.projects.find((p) => p.id === state.selectedId) ?? null;
  if (!state.loaded) {
    return <div className="web-project-picker" role="status"><Skeleton width={140} height={36} /><span className="ui-sr-only web-project-loading">Loading projects…</span></div>;
  }
  if (state.projects.length === 0) {
    if (state.error) {
      return <div className="web-project-picker web-project-empty" role="alert">Could not load projects. {state.error}</div>;
    }
    return (
      <div className="web-project-picker web-project-empty" role="status">
        <span>No projects are available to this account.</span>
      </div>
    );
  }
  return (
    <div className="web-project-picker">
      <label htmlFor="web-project-select" className="ui-sr-only">Project</label>
      <select id="web-project-select" className="web-select" value={selected?.id ?? ""} disabled={disabled || state.loading}
        onChange={(e) => { const id = e.currentTarget.value; if (id) onSelect(id); }}>
        {state.loading && <option value="">Loading projects…</option>}
        {!state.loading && !selected && <option value="">Choose a project…</option>}
        {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
      </select>
      {selected && <span className="web-project-role" data-role={selected.role}>{selected.role}</span>}
      {state.error && <span className="web-project-error" role="alert">{state.error}</span>}
      {state.refusal && (
        <span className="web-project-error" role="alert">
          {REFUSAL[state.refusal.code]} {state.refusal.message}
        </span>
      )}
    </div>
  );
}
