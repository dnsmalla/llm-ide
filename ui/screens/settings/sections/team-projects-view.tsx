// Presentational pieces for Settings → Team → project (ADR 0021 H1.3). Pure props in, markup out: the
// Team container owns loading, the selected project and the calls, so these views are render-tested
// without a live core.
import { Button, Field } from "../ui.tsx";
import {
  MAX_MODES, MAX_USD_CAP_MONTH, formatUsdCap, maxModeLabel, roleLabel, roleAtLeast, statusLabel,
} from "../team-model.ts";
import {
  addProjectMemberProblem, assignmentControl, assigneeChoices, canManageProject, grantableProjectRoles,
  projectMemberDraftProblem, projectMemberEditBlock, type AssignmentControl, type PlanTaskAssignee,
  type PlanTaskRow, type ProjectMember, type ProjectMemberDraft, type ProjectSummary, type TeamRole,
} from "../team-projects-model.ts";

export function ProjectPickerView({
  projects, selectedId, onSelect, busy = false,
}: {
  projects: readonly ProjectSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  busy?: boolean;
}) {
  if (projects.length === 0) {
    return <p className="st-hint">No projects are registered yet. Open a project on the desktop to register it.</p>;
  }
  return (
    <Field label="Project" hint="Roles are per project. A team member with no project role is a viewer on that project.">
      <select
        className="st-select"
        aria-label="Project"
        value={selectedId ?? ""}
        disabled={busy}
        onChange={(e) => onSelect(e.target.value)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </Field>
  );
}

/** The selected project's effective grant, so the caller can see what the core will allow. */
export function ProjectRoleNotice({ project }: { project: ProjectSummary | null }) {
  if (!project) return <p className="st-hint">Choose a project to see its members.</p>;
  return (
    <p className="st-hint" role="status">
      On <strong>{project.name}</strong> you are {roleLabel(project.role)} · {maxModeLabel(project.maxMode)} · {formatUsdCap(project.usdCapMonth)}.
      {project.role === "viewer" ? " A viewer can read and Ask only on this project." : ""}
    </p>
  );
}

export function ProjectAccessNotice({ role }: { role: TeamRole | null }) {
  if (canManageProject(role)) return null;
  return (
    <p className="st-hint" role="status">
      Only this project&apos;s owner and admins can see or change its members.
      {role ? ` Your project role is ${roleLabel(role)}.` : ""}
    </p>
  );
}

export function ProjectMemberRowView({
  member, actorRole, selfId, onEdit,
}: {
  member: ProjectMember;
  actorRole: TeamRole;
  selfId: string;
  onEdit: () => void;
}) {
  const blocked = projectMemberEditBlock(member, actorRole, selfId);
  return (
    <li className="st-team-row" role="listitem">
      <div className="st-item-text">
        <strong>{member.displayName || member.email}</strong>
        <span className="st-hint">{member.email}</span>
        <span className="st-hint">
          {roleLabel(member.role)} · {maxModeLabel(member.maxMode)} · {formatUsdCap(member.usdCapMonth)} · {statusLabel(member.status)}
        </span>
      </div>
      {blocked ? <p className="st-hint">{blocked}</p> : <Button onClick={onEdit} label={`Edit ${member.email}`}>Edit</Button>}
    </li>
  );
}

export function ProjectMemberEditorView({
  member, actorRole, selfId, draft, onChange, onSave, onCancel, onRemove, busy,
}: {
  member: ProjectMember;
  actorRole: TeamRole;
  selfId: string;
  draft: ProjectMemberDraft;
  onChange: (draft: ProjectMemberDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove?: () => void;
  busy: boolean;
}) {
  const problem = projectMemberDraftProblem(member, draft, actorRole, selfId);
  const canSave = !busy && problem === null && (
    draft.role !== member.role
    || draft.maxMode !== member.maxMode
    || Number(draft.usdCapMonth) !== Number(member.usdCapMonth)
  );
  return (
    <li className="st-team-row" role="listitem">
      <form
        className="st-stack st-grow"
        aria-label={`Edit ${member.email} on this project`}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) onSave();
        }}
      >
        <p className="st-label">Edit {member.email} on this project</p>
        <div className="st-team-fields">
          <Field label="Project role">
            <select
              className="st-select"
              value={draft.role}
              onChange={(e) => {
                const v = e.target.value;
                if (roleAtLeast(actorRole, v as TeamRole)) onChange({ ...draft, role: v as TeamRole });
              }}
            >
              {grantableProjectRoles(actorRole).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="Max mode">
            <select
              className="st-select"
              value={draft.maxMode}
              onChange={(e) => {
                const v = e.target.value;
                if ((MAX_MODES as readonly string[]).includes(v)) onChange({ ...draft, maxMode: v as ProjectMemberDraft["maxMode"] });
              }}
            >
              {MAX_MODES.map((m) => <option key={m} value={m}>{maxModeLabel(m)}</option>)}
            </select>
          </Field>
          <Field label="Monthly USD cap" hint="0 means no cap; up to 100000.">
            <input
              className="st-input"
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_USD_CAP_MONTH}
              step="0.01"
              value={draft.usdCapMonth}
              onChange={(e) => onChange({ ...draft, usdCapMonth: e.target.value })}
            />
          </Field>
        </div>
        {problem ? <p className="st-error" role="alert">{problem}</p> : null}
        <div className="st-row">
          <Button tone="primary" disabled={!canSave} onClick={onSave}>Save changes</Button>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          {onRemove ? <Button onClick={onRemove} disabled={busy}>Remove from project</Button> : null}
        </div>
      </form>
    </li>
  );
}

export function ProjectAddMemberView({
  email, role, maxMode, usdCapMonth, actorRole, busy, onChange, onSubmit,
}: {
  email: string;
  role: TeamRole;
  maxMode: ProjectMemberDraft["maxMode"];
  usdCapMonth: string;
  actorRole: TeamRole;
  busy: boolean;
  onChange: (next: { email: string; role: TeamRole; maxMode: ProjectMemberDraft["maxMode"]; usdCapMonth: string }) => void;
  onSubmit: () => void;
}) {
  const problem = addProjectMemberProblem(email, role, maxMode, usdCapMonth);
  return (
    <form
      className="st-stack"
      aria-label="Add a project member"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && problem === null) onSubmit();
      }}
    >
      <p className="st-label">Add a team member</p>
      <Field label="Email" hint="An existing account. A new member joins through a team invite first.">
        <input
          className="st-input"
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          value={email}
          onChange={(e) => onChange({ email: e.target.value, role, maxMode, usdCapMonth })}
        />
      </Field>
      <div className="st-team-fields">
        <Field label="Project role">
          <select
            className="st-select"
            value={role}
            onChange={(e) => onChange({ email, role: e.target.value as TeamRole, maxMode, usdCapMonth })}
          >
            {grantableProjectRoles(actorRole).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Max mode">
          <select
            className="st-select"
            value={maxMode}
            onChange={(e) => onChange({ email, role, maxMode: e.target.value as ProjectMemberDraft["maxMode"], usdCapMonth })}
          >
            {MAX_MODES.map((m) => <option key={m} value={m}>{maxModeLabel(m)}</option>)}
          </select>
        </Field>
        <Field label="Monthly USD cap" hint="0 means no cap.">
          <input
            className="st-input"
            type="number"
            inputMode="decimal"
            min={0}
            max={MAX_USD_CAP_MONTH}
            step="0.01"
            value={usdCapMonth}
            onChange={(e) => onChange({ email, role, maxMode, usdCapMonth: e.target.value })}
          />
        </Field>
      </div>
      {problem ? <p className="st-error" role="alert">{problem}</p> : null}
      <div className="st-row">
        <Button tone="primary" disabled={busy || problem !== null} onClick={onSubmit}>Add to project</Button>
      </div>
    </form>
  );
}

// ---- plan-task assignments -------------------------------------------------------------------------

const assigneeName = (a: PlanTaskAssignee | null): string => {
  if (!a) return "Unassigned";
  return a.displayName || a.email || "A team member";
};

/** The cross-project "Assigned to me" list with a count badge. Read-only: a task is reassigned on its project board. */
export function MyAssignmentsView({
  rows, loaded, error, onRetry,
}: {
  rows: readonly PlanTaskRow[];
  loaded: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <section className="st-stack" aria-label="Assigned to me">
      <p className="st-label">
        Assigned to me <span className="st-badge" aria-label={`${rows.length} assignments`}>{rows.length}</span>
      </p>
      <p className="st-hint">Plan tasks across every project you belong to. Change an assignee on the project board below.</p>
      {error ? (
        <div className="st-stack">
          <p className="st-error" role="alert">{error}</p>
          {onRetry ? <div className="st-row"><Button onClick={onRetry}>Retry</Button></div> : null}
        </div>
      ) : !loaded ? (
        <p className="st-hint" role="status">Loading your assignments…</p>
      ) : rows.length === 0 ? (
        <p className="st-hint">No plan tasks are assigned to you.</p>
      ) : (
        <ul className="st-team-list" aria-label="My plan tasks">
          {rows.map((row) => (
            <li className="st-team-row" key={row.taskId} role="listitem">
              <div className="st-item-text">
                <strong>{row.title}</strong>
                <span className="st-hint">{row.projectName ?? row.projectId} · {row.planTitle}</span>
                <span className="st-hint">
                  {row.status}{row.due ? ` · due ${row.due}` : ""}{row.milestone ? ` · ${row.milestone}` : ""}
                  {row.owner ? ` · plan owner: ${row.owner}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One project's plan tasks: assignee, and the control the caller may use on it. */
export function ProjectPlanTasksView({
  tasks, members, role, selfId, busy, error, onAssign, onUnassign,
}: {
  tasks: readonly PlanTaskRow[] | null;
  members: readonly ProjectMember[];
  role: TeamRole;
  selfId: string;
  busy: boolean;
  error: string | null;
  onAssign: (taskId: string, userId: string | null) => void;
  onUnassign: (taskId: string) => void;
}) {
  return (
    <section className="st-stack" aria-label="Project plan tasks">
      <p className="st-label">Plan tasks</p>
      {error ? <p className="st-error" role="alert">{error}</p> : null}
      {tasks === null ? (
        <p className="st-hint" role="status">Loading plan tasks…</p>
      ) : tasks.length === 0 ? (
        <p className="st-hint">No plan tasks are tagged with this project yet. A plan with <code>meta.projectId</code> set appears here.</p>
      ) : (
        <ul className="st-team-list" aria-label="Plan tasks">
          {tasks.map((row) => {
            const control: AssignmentControl = assignmentControl(row, role, selfId);
            const label = `Assignee for ${row.title}`;
            return (
              <li className="st-team-row" key={row.taskId} role="listitem">
                <div className="st-item-text">
                  <strong>{row.title}</strong>
                  <span className="st-hint">{row.planTitle} · {row.status}{row.due ? ` · due ${row.due}` : ""}{row.milestone ? ` · ${row.milestone}` : ""}</span>
                  <span className="st-hint" data-testid={`assignee-${row.taskId}`}>Assignee: {assigneeName(row.assignee)}</span>
                  {control === "readonly" && row.assignee ? (
                    <span className="st-hint">Only a project owner or admin can change this assignment.</span>
                  ) : null}
                </div>
                {control === "manage" ? (
                  <select
                    className="st-select"
                    aria-label={label}
                    value={row.assignee?.userId ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value) onAssign(row.taskId, value);
                      else onUnassign(row.taskId);
                    }}
                  >
                    {assigneeChoices(members, row.assignee).map((c) => (
                      <option key={c.userId || "none"} value={c.userId}>{c.label}</option>
                    ))}
                  </select>
                ) : control === "claim" ? (
                  <Button disabled={busy} onClick={() => onAssign(row.taskId, null)} label={`Assign ${row.title} to me`}>Assign to me</Button>
                ) : control === "release" ? (
                  <Button disabled={busy} onClick={() => onUnassign(row.taskId)} label={`Release ${row.title}`}>Release</Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
