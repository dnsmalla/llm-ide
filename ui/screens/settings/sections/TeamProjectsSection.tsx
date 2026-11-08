// Settings → Team → project (ADR 0021 H1.3): the project picker and per-project membership container.
// Mounted by TeamSection during the integration window; kept separate so the project routes and views
// are testable without the team admin panels.
import { useState } from "react";
import { call } from "../core-api.ts";
import { describeError } from "../errors.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText } from "../ui.tsx";
import {
  canManageProject, decodeTeamIdentity, defaultProjectMemberDraft, addProjectMemberProblem,
  buildAddProjectMemberBody, buildProjectMemberPatch, listProjectMemberRows, listProjects,
  projectMemberDraftProblem, addProjectMember, patchProjectMember, removeProjectMember,
  type ProjectMember, type ProjectMemberDraft, type ProjectSummary, type TeamRole,
} from "../team-projects-model.ts";
import {
  ProjectAccessNotice, ProjectAddMemberView, ProjectMemberEditorView, ProjectMemberRowView,
  ProjectPickerView, ProjectRoleNotice,
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

  const selected = projects?.find((p) => p.id === selectedId) ?? null;

  const loadMembers = async (projectId: string): Promise<void> => {
    try {
      const out = await listProjectMemberRows(client, projectId);
      setMembers(out.members);
      setMemberError(null);
    } catch (e) {
      setMembers(null);
      setMemberError(describeError(e));
    }
  };

  const load = async (): Promise<void> => {
    let me: unknown;
    let list: ProjectSummary[];
    try {
      [me, list] = await Promise.all([call(client, "GET", "/auth/me"), listProjects(client)]);
    } catch (e) {
      setGate({ kind: "error", message: describeError(e) });
      return;
    }
    const identity = decodeTeamIdentity(me);
    if (!identity) {
      setGate({ kind: "error", message: "Your account has no team role yet. Ask a team owner to assign one." });
      return;
    }
    setGate({ kind: "ready", selfId: identity.id, teamRole: identity.teamRole });
    setProjects(list);
    const keep = selectedId && list.some((p) => p.id === selectedId) ? selectedId : (list[0]?.id ?? null);
    setSelectedId(keep);
    const project = list.find((p) => p.id === keep) ?? null;
    if (project && canManageProject(project.role)) await loadMembers(project.id);
    else {
      setMembers(null);
      setMemberError(null);
    }
  };

  useRefreshOnFocus(() => {
    void load();
  });

  const selectProject = (id: string): void => {
    setSelectedId(id);
    setEditingId(null);
    setDraft(null);
    setActionError(null);
    setMembers(null);
    setMemberError(null);
    const project = projects?.find((p) => p.id === id);
    if (project && canManageProject(project.role)) void loadMembers(id);
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
    try {
      const updated = await patchProjectMember(client, selected.id, member.userId, patch);
      setMembers((prev) => (prev ? prev.map((m) => (m.userId === updated.userId ? updated : m)) : prev));
      setEditingId(null);
      setDraft(null);
      void loadMembers(selected.id);
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member: ProjectMember): Promise<void> => {
    if (gate.kind !== "ready" || !selected || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await removeProjectMember(client, selected.id, member.userId);
      setMembers((prev) => (prev ? prev.filter((m) => m.userId !== member.userId) : prev));
      setEditingId(null);
      setDraft(null);
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (): Promise<void> => {
    if (gate.kind !== "ready" || !selected || busy) return;
    if (addProjectMemberProblem(add.email, add.role, add.maxMode, add.usdCapMonth) !== null) return;
    const body = buildAddProjectMemberBody(add.email, add.role, add.maxMode, add.usdCapMonth);
    if (body === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const member = await addProjectMember(client, selected.id, body);
      setMembers((prev) => (prev ? [...prev, member] : [member]));
      setAdd(emptyAdd());
      void loadMembers(selected.id);
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
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
        </>
      )}
    </section>
  );
}
