// Settings → Team → project (ADR 0021 H1.3): the project picker and per-project membership container.
// Mounted by TeamSection during the integration window; kept separate so the project routes and views
// are testable without the team admin panels.
import { useEffect, useRef, useState } from "react";
import { call } from "../core-api.ts";
import { describeError } from "../errors.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText } from "../ui.tsx";
import {
  assignPlanTask, canManageProject, canViewProjectTasks, decodeTeamIdentity, defaultProjectMemberDraft,
  addProjectMemberProblem, buildAddProjectMemberBody, buildProjectMemberPatch, listMyAssignments,
  listProjectMemberRows, listProjectPlanTasks, listProjects, unassignPlanTask,
  projectMemberDraftProblem, addProjectMember, patchProjectMember, removeProjectMember,
  type PlanTaskRow, type ProjectMember, type ProjectMemberDraft, type ProjectSummary, type TeamRole,
} from "../team-projects-model.ts";
import {
  MyAssignmentsView, ProjectAccessNotice, ProjectAddMemberView, ProjectMemberEditorView,
  ProjectMemberRowView, ProjectPickerView, ProjectPlanTasksView, ProjectRoleNotice,
} from "./team-projects-view.tsx";

type Gate =
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "ready"; selfId: string; teamRole: TeamRole };

interface AddDraft {
  email: string;
  role: TeamRole;
  maxMode: "none" | "read_only" | "execute";
  usdCapMonth: string;
}

const emptyAdd = (): AddDraft => ({ email: "", role: "member", maxMode: "execute", usdCapMonth: "20" });

export default function TeamProjectsSection() {
  const { client } = useEnv();
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectMemberDraft | null>(null);
  const [add, setAdd] = useState<AddDraft>(emptyAdd);
  const [myAssignments, setMyAssignments] = useState<PlanTaskRow[] | null>(null);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  const [planTasks, setPlanTasks] = useState<PlanTaskRow[] | null>(null);
  const [planTasksError, setPlanTasksError] = useState<string | null>(null);
  // R-020 #9: every request gets a signal; a slow earlier load can never write another project's members.
  const membersAc = useRef<AbortController | null>(null);
  const loadAc = useRef<AbortController | null>(null);
  const mutateAc = useRef<AbortController | null>(null);
  const planTasksAc = useRef<AbortController | null>(null);
  const taskMutateAc = useRef<AbortController | null>(null);
  const loadToken = useRef(0);
  const planTasksToken = useRef(0);

  const selected = projects?.find((p) => p.id === selectedId) ?? null;

  useEffect(() => () => {
    membersAc.current?.abort();
    loadAc.current?.abort();
    mutateAc.current?.abort();
    planTasksAc.current?.abort();
    taskMutateAc.current?.abort();
  }, []);

  const loadMyAssignments = async (): Promise<void> => {
    try {
      const rows = await listMyAssignments(client);
      setMyAssignments(rows);
      setAssignmentsError(null);
    } catch (e) {
      setMyAssignments(null);
      setAssignmentsError(describeError(e));
    }
  };

  const loadPlanTasks = async (projectId: string): Promise<void> => {
    const token = ++planTasksToken.current;
    planTasksAc.current?.abort();
    const controller = new AbortController();
    planTasksAc.current = controller;
    setPlanTasks(null);
    setPlanTasksError(null);
    try {
      const out = await listProjectPlanTasks(client, projectId, controller.signal);
      if (token !== planTasksToken.current || controller.signal.aborted) return;
      setPlanTasks(out.tasks);
    } catch (e) {
      if (token !== planTasksToken.current || controller.signal.aborted) return;
      setPlanTasks(null);
      setPlanTasksError(describeError(e));
    }
  };

  const loadMembers = async (projectId: string): Promise<void> => {
    const token = ++loadToken.current;
    membersAc.current?.abort();
    const controller = new AbortController();
    membersAc.current = controller;
    try {
      const out = await listProjectMemberRows(client, projectId, controller.signal);
      if (token !== loadToken.current || controller.signal.aborted) return;
      setMembers(out.members);
      setMemberError(null);
    } catch (e) {
      if (token !== loadToken.current || controller.signal.aborted) return;
      setMembers(null);
      setMemberError(describeError(e));
    }
  };

  const load = async (): Promise<void> => {
    loadAc.current?.abort();
    const controller = new AbortController();
    loadAc.current = controller;
    loadToken.current += 1; // a members load for the previous selection is stale now
    membersAc.current?.abort();
    let me: unknown;
    let list: ProjectSummary[];
    try {
      [me, list] = await Promise.all([call(client, "GET", "/auth/me", undefined, controller.signal), listProjects(client, controller.signal)]);
    } catch (e) {
      if (controller.signal.aborted) return;
      setGate({ kind: "error", message: describeError(e) });
      return;
    }
    if (controller.signal.aborted) return;
    const identity = decodeTeamIdentity(me);
    if (!identity) {
      setGate({ kind: "error", message: "Your account has no team role yet. Ask a team owner to assign one." });
      return;
    }
    setGate({ kind: "ready", selfId: identity.id, teamRole: identity.teamRole });
    setProjects(list);
    void loadMyAssignments();
    const keep = selectedId && list.some((p) => p.id === selectedId) ? selectedId : (list[0]?.id ?? null);
    setSelectedId(keep);
    const project = list.find((p) => p.id === keep) ?? null;
    if (project && canManageProject(project.role)) await loadMembers(project.id);
    else {
      setMembers(null);
      setMemberError(null);
    }
    if (project && canViewProjectTasks(project.role)) await loadPlanTasks(project.id);
    else {
      setPlanTasks(null);
      setPlanTasksError(null);
    }
  };

  useRefreshOnFocus(() => {
    void load();
  });

  const selectProject = (id: string): void => {
    loadToken.current += 1;
    membersAc.current?.abort();
    planTasksToken.current += 1;
    planTasksAc.current?.abort();
    setSelectedId(id);
    setEditingId(null);
    setDraft(null);
    setActionError(null);
    setMembers(null);
    setMemberError(null);
    setPlanTasks(null);
    setPlanTasksError(null);
    const project = projects?.find((p) => p.id === id);
    if (project && canManageProject(project.role)) void loadMembers(id);
    if (project && canViewProjectTasks(project.role)) void loadPlanTasks(id);
  };

  const startEdit = (member: ProjectMember): void => {
    setEditingId(member.userId);
    setDraft(defaultProjectMemberDraft(member));
    setActionError(null);
  };

  const saveMember = async (): Promise<void> => {
    if (gate.kind !== "ready" || !selected || editingId === null || draft === null || busy) return;
    const member = members?.find((m) => m.userId === editingId);
    if (!member) return;
    const problem = projectMemberDraftProblem(member, draft, selected.role, gate.selfId);
    if (problem !== null) {
      setActionError(problem);
      return;
    }
    const patch = buildProjectMemberPatch(member, draft);
    if (patch === null) return;
    setBusy(true);
    setActionError(null);
    mutateAc.current?.abort();
    const controller = new AbortController();
    mutateAc.current = controller;
    try {
      const updated = await patchProjectMember(client, selected.id, member.userId, patch, controller.signal);
      if (controller.signal.aborted) return;
      setMembers((prev) => (prev ? prev.map((m) => (m.userId === updated.userId ? updated : m)) : prev));
      setEditingId(null);
      setDraft(null);
      void loadMembers(selected.id);
    } catch (e) {
      if (!controller.signal.aborted) setActionError(describeError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const removeMember = async (member: ProjectMember): Promise<void> => {
    if (gate.kind !== "ready" || !selected || busy) return;
    setBusy(true);
    setActionError(null);
    mutateAc.current?.abort();
    const controller = new AbortController();
    mutateAc.current = controller;
    try {
      await removeProjectMember(client, selected.id, member.userId, controller.signal);
      if (controller.signal.aborted) return;
      setMembers((prev) => (prev ? prev.filter((m) => m.userId !== member.userId) : prev));
      setEditingId(null);
      setDraft(null);
    } catch (e) {
      if (!controller.signal.aborted) setActionError(describeError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const addMember = async (): Promise<void> => {
    if (gate.kind !== "ready" || !selected || busy) return;
    if (addProjectMemberProblem(add.email, add.role, add.maxMode, add.usdCapMonth) !== null) return;
    const body = buildAddProjectMemberBody(add.email, add.role, add.maxMode, add.usdCapMonth);
    if (body === null) return;
    setBusy(true);
    setActionError(null);
    mutateAc.current?.abort();
    const controller = new AbortController();
    mutateAc.current = controller;
    try {
      const member = await addProjectMember(client, selected.id, body, controller.signal);
      if (controller.signal.aborted) return;
      setMembers((prev) => (prev ? [...prev, member] : [member]));
      setAdd(emptyAdd());
      void loadMembers(selected.id);
    } catch (e) {
      if (!controller.signal.aborted) setActionError(describeError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  // One mutation for assign, reassign and unassign. `userId === null` on an assign means "me";
  // `clear` (the picker's Unassigned option, or Release) removes the row instead.
  const applyAssignment = async (taskId: string, userId: string | null, clear = false): Promise<void> => {
    if (gate.kind !== "ready" || !selected || busy) return;
    setBusy(true);
    setPlanTasksError(null);
    taskMutateAc.current?.abort();
    const controller = new AbortController();
    taskMutateAc.current = controller;
    try {
      if (clear) await unassignPlanTask(client, taskId, controller.signal);
      else await assignPlanTask(client, taskId, userId, controller.signal);
      if (controller.signal.aborted) return;
      void loadMyAssignments();
      await loadPlanTasks(selected.id);
    } catch (e) {
      if (!controller.signal.aborted) setPlanTasksError(describeError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  if (gate.kind === "checking") return <p className="st-hint" role="status">Checking your projects…</p>;
  if (gate.kind === "error") {
    return (
      <div className="st-stack">
        <ErrorText text={gate.message} />
        <div className="st-row"><Button onClick={() => void load()}>Retry</Button></div>
      </div>
    );
  }

  const canManage = selected !== null && canManageProject(selected.role);
  return (
    <section className="st-stack" aria-label="Project team">
      <MyAssignmentsView
        rows={myAssignments ?? []}
        loaded={myAssignments !== null}
        error={assignmentsError}
        onRetry={() => void loadMyAssignments()}
      />
      <ProjectPickerView
        projects={projects ?? []}
        selectedId={selectedId}
        onSelect={selectProject}
        busy={busy}
      />
      {projects !== null && projects.length === 0 ? null : (
        <>
          <ProjectRoleNotice project={selected} />
          <ErrorText text={actionError} />
          {selected === null ? null : canManage ? (
            <>
              {memberError ? (
                <div className="st-stack">
                  <ErrorText text={memberError} />
                  <div className="st-row"><Button onClick={() => void loadMembers(selected.id)}>Retry</Button></div>
                </div>
              ) : members === null ? (
                <p className="st-hint" role="status">Loading project members…</p>
              ) : members.length === 0 ? (
                <p className="st-hint">No explicit members yet; every active team member is an implicit viewer on this project.</p>
              ) : (
                <ul className="st-team-list" aria-label="Project members">
                  {members.map((m) => editingId === m.userId && draft !== null ? (
                    <ProjectMemberEditorView
                      key={m.userId}
                      member={m}
                      actorRole={selected.role}
                      selfId={gate.selfId}
                      draft={draft}
                      onChange={setDraft}
                      onSave={() => void saveMember()}
                      onCancel={() => { setEditingId(null); setDraft(null); }}
                      onRemove={() => void removeMember(m)}
                      busy={busy}
                    />
                  ) : (
                    <ProjectMemberRowView
                      key={m.userId}
                      member={m}
                      actorRole={selected.role}
                      selfId={gate.selfId}
                      onEdit={() => startEdit(m)}
                    />
                  ))}
                </ul>
              )}
              <ProjectAddMemberView
                email={add.email}
                role={add.role}
                maxMode={add.maxMode}
                usdCapMonth={add.usdCapMonth}
                actorRole={selected.role}
                busy={busy}
                onChange={setAdd}
                onSubmit={() => void addMember()}
              />
            </>
          ) : (
            <ProjectAccessNotice role={selected.role} />
          )}
          {selected !== null && canViewProjectTasks(selected.role) ? (
            <ProjectPlanTasksView
              tasks={planTasks}
              members={members ?? []}
              role={selected.role}
              selfId={gate.selfId}
              busy={busy}
              error={planTasksError}
              onAssign={(taskId, userId) => void applyAssignment(taskId, userId, false)}
              onUnassign={(taskId) => void applyAssignment(taskId, null, true)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
