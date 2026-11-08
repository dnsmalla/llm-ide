// Settings → Team → project picker (ADR 0021 H1.3): decoders, role gating and form logic for the
// project list and per-project membership routes (GET /projects, /projects/:id/members). Pure: no React,
// no DOM. The selected project's effective role — not the global team role — decides what the UI shows;
// the core re-checks every call.
import { ApiError, call, type CoreClient } from "./core-api.ts";
import {
  MAX_MODES, MAX_USD_CAP_MONTH, ROLE_RANK, TEAM_ROLES, canManageTeam, isMaxMode, isTeamRole,
  roleAtLeast, type MaxMode, type TeamMember, type TeamRole,
} from "./team-model.ts";

// The project picker speaks the same role vocabulary as the team screen; re-export so its sections import one module.
export type { TeamRole };

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const badResponse = (): never => {
  throw new ApiError(0, "BAD_RESPONSE");
};

const readStr = (v: unknown): string => (typeof v === "string" ? v : badResponse());

const readCap = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_USD_CAP_MONTH) return badResponse();
  return v;
};

/** The project roles, in the same order as the team roles. */
export const PROJECT_ROLES = TEAM_ROLES;
export const PROJECT_ROLE_RANK = ROLE_RANK;

export interface ProjectSummary {
  id: string;
  name: string;
  /** The caller's effective role on this project (unassigned = viewer). */
  role: TeamRole;
  maxMode: MaxMode;
  usdCapMonth: number;
  /** Action classes the core says this project role may use (cap not applied). */
  permissions: string[];
}

export interface ProjectMember {
  userId: string;
  email: string;
  displayName: string;
  status: string;
  role: TeamRole;
  maxMode: MaxMode;
  usdCapMonth: number;
  updatedAt: string;
}

export interface ProjectMemberDraft {
  role: TeamRole;
  maxMode: MaxMode;
  usdCapMonth: string;
}

export interface ProjectMemberPatch {
  role?: TeamRole;
  maxMode?: MaxMode;
  usdCapMonth?: number;
}

export interface AddProjectMemberBody {
  email: string;
  role: TeamRole;
  maxMode: MaxMode;
  usdCapMonth: number;
}

const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isProjectId(v: unknown): v is string {
  return typeof v === "string" && PROJECT_ID.test(v);
}

export function decodeProject(v: unknown): ProjectSummary {
  if (!isRec(v)) return badResponse();
  if (!isProjectId(v.id)) return badResponse();
  if (typeof v.name !== "string" || v.name.length === 0) return badResponse();
  if (!isTeamRole(v.role)) return badResponse();
  if (!isMaxMode(v.maxMode)) return badResponse();
  if (!Array.isArray(v.permissions)) return badResponse();
  return {
    id: v.id,
    name: v.name,
    role: v.role,
    maxMode: v.maxMode,
    usdCapMonth: readCap(v.usdCapMonth),
    permissions: v.permissions.filter((p): p is string => typeof p === "string"),
  };
}

export function decodeProjects(v: unknown): ProjectSummary[] {
  if (!isRec(v) || !Array.isArray(v.projects)) return badResponse();
  return v.projects.map(decodeProject);
}

export function decodeProjectMember(v: unknown): ProjectMember {
  if (!isRec(v)) return badResponse();
  if (!isTeamRole(v.role)) return badResponse();
  if (!isMaxMode(v.maxMode)) return badResponse();
  return {
    userId: readStr(v.userId),
    email: readStr(v.email),
    displayName: readStr(v.displayName),
    status: readStr(v.status),
    role: v.role,
    maxMode: v.maxMode,
    usdCapMonth: readCap(v.usdCapMonth),
    updatedAt: readStr(v.updatedAt),
  };
}

export function decodeProjectMembers(v: unknown): { project: { id: string; name: string }; members: ProjectMember[] } {
  if (!isRec(v) || !isRec(v.project) || !Array.isArray(v.members)) return badResponse();
  if (!isProjectId(v.project.id) || typeof v.project.name !== "string") return badResponse();
  return { project: { id: v.project.id, name: v.project.name }, members: v.members.map(decodeProjectMember) };
}

export function decodeProjectMemberResponse(v: unknown): ProjectMember {
  if (!isRec(v)) return badResponse();
  return decodeProjectMember(v.member);
}

export function decodeProjectRemoved(v: unknown): boolean {
  if (!isRec(v) || typeof v.removed !== "boolean") return badResponse();
  return v.removed;
}

/** `/auth/me.projects` (API 126), or null for an older core that does not report project roles. */
export function projectsFromMe(v: unknown): ProjectSummary[] | null {
  if (!isRec(v) || !Array.isArray(v.projects)) return null;
  try {
    return v.projects.map(decodeProject);
  } catch {
    return null;
  }
}

/** The caller's project row from `/auth/me.projects`, or null when unassigned/absent. */
export function projectFromMe(v: unknown, projectId: string | null | undefined): ProjectSummary | null {
  if (!projectId) return null;
  return projectsFromMe(v)?.find((p) => p.id === projectId) ?? null;
}

/** A project admin/owner may manage that project; the core re-checks. */
export function canManageProject(role: TeamRole | null | undefined): role is "admin" | "owner" {
  return role === "admin" || role === "owner";
}

/** Project roles this actor may grant: never above their own (a global team admin/owner maps to owner). */
export function grantableProjectRoles(actorRole: TeamRole): TeamRole[] {
  return PROJECT_ROLES.filter((r) => roleAtLeast(actorRole, r));
}

/** What the selected project allows: a viewer sees Ask only, an engineer sees every mode. */
export function projectPermissions(project: ProjectSummary | null): ReadonlySet<string> | null {
  if (!project) return null;
  return new Set(project.permissions);
}

/** Why this member row cannot be edited by this actor, or null. Mirrors the core's hierarchy rules. */
export function projectMemberEditBlock(member: ProjectMember, actorRole: TeamRole | null, selfId: string): string | null {
  if (!canManageProject(actorRole)) return "Only a project owner or admin can change project members.";
  if (member.userId === selfId) return "You cannot change your own project role.";
  if (!roleAtLeast(actorRole, member.role)) return "Only a project owner can change a project owner.";
  return null;
}

export function defaultProjectMemberDraft(member: ProjectMember): ProjectMemberDraft {
  return { role: member.role, maxMode: member.maxMode, usdCapMonth: String(member.usdCapMonth) };
}

export function projectMemberDraftProblem(
  member: ProjectMember,
  draft: ProjectMemberDraft,
  actorRole: TeamRole | null,
  selfId: string,
): string | null {
  const blocked = projectMemberEditBlock(member, actorRole, selfId);
  if (blocked !== null) return blocked;
  if (!isTeamRole(draft.role)) return "Choose a project role.";
  if (!isMaxMode(draft.maxMode)) return "Choose a max mode.";
  if (!roleAtLeast(actorRole ?? "viewer", draft.role)) return "You cannot grant a role above your own.";
  return capProblem(draft.usdCapMonth);
}

export function buildProjectMemberPatch(member: ProjectMember, draft: ProjectMemberDraft): ProjectMemberPatch | null {
  const patch: ProjectMemberPatch = {};
  if (draft.role !== member.role) patch.role = draft.role;
  if (draft.maxMode !== member.maxMode) patch.maxMode = draft.maxMode;
  if (Number(draft.usdCapMonth) !== Number(member.usdCapMonth)) patch.usdCapMonth = Number(draft.usdCapMonth);
  return Object.keys(patch).length === 0 ? null : patch;
}

function capProblem(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return "Enter a monthly USD cap, or 0 for no cap.";
  const n = Number(t);
  if (!Number.isFinite(n)) return "The monthly USD cap must be a number.";
  if (n < 0 || n > MAX_USD_CAP_MONTH) return `The monthly USD cap must be between 0 and ${MAX_USD_CAP_MONTH}.`;
  return null;
}

export function addProjectMemberProblem(email: string, role: string, maxMode: string, usdCapMonth: string): string | null {
  const e = email.trim();
  if (!e) return "Enter the team member's email.";
  if (e.length > 254) return "The email must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) return "Enter one email address, like name@example.com.";
  if (!isTeamRole(role)) return "Choose a project role.";
  if (!isMaxMode(maxMode)) return "Choose a max mode.";
  return capProblem(usdCapMonth);
}

export function buildAddProjectMemberBody(
  email: string,
  role: TeamRole,
  maxMode: MaxMode,
  usdCapMonth: string,
): AddProjectMemberBody | null {
  if (addProjectMemberProblem(email, role, maxMode, usdCapMonth) !== null) return null;
  return { email: email.trim(), role, maxMode, usdCapMonth: Number(usdCapMonth) };
}

/**
 * The global team member rows a global admin may add. The project routes add by email so a project
 * admin never needs the team list; this only filters rows the caller already has.
 */
export function addableTeamMembers(members: readonly TeamMember[], current: readonly ProjectMember[]): TeamMember[] {
  const present = new Set(current.map((m) => m.userId));
  return members.filter((m) => !present.has(m.userId) && m.status === "active");
}

/** The picker is for anyone with a project; the global team panels stay owner/admin only. */
export function showProjectPicker(projects: readonly ProjectSummary[] | null): boolean {
  return Array.isArray(projects) && projects.length > 0;
}

/** Whether the selected project unlocks project-member management, or the global team panels too. */
export function teamPanelVisible(teamRole: TeamRole | null, projectRole: TeamRole | null): boolean {
  return canManageTeam(teamRole) || canManageProject(projectRole);
}

export { MAX_MODES, MAX_USD_CAP_MONTH };
export { decodeTeamIdentity } from "./team-model.ts";

// ---- the routes (call() throws ApiError; a non-2xx is never data here) -------------------------------

export const listProjects = async (client: CoreClient): Promise<ProjectSummary[]> =>
  decodeProjects(await call(client, "GET", "/projects"));

export const listProjectMemberRows = async (
  client: CoreClient,
  projectId: string,
): Promise<{ project: { id: string; name: string }; members: ProjectMember[] }> =>
  decodeProjectMembers(await call(client, "GET", `/projects/${encodeURIComponent(projectId)}/members`));

export const addProjectMember = async (
  client: CoreClient,
  projectId: string,
  body: AddProjectMemberBody,
): Promise<ProjectMember> =>
  decodeProjectMemberResponse(await call(client, "POST", `/projects/${encodeURIComponent(projectId)}/members`, body));

export const patchProjectMember = async (
  client: CoreClient,
  projectId: string,
  userId: string,
  patch: ProjectMemberPatch,
): Promise<ProjectMember> =>
  decodeProjectMemberResponse(await call(
    client, "PATCH", `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, patch,
  ));

export const removeProjectMember = async (
  client: CoreClient,
  projectId: string,
  userId: string,
): Promise<boolean> =>
  decodeProjectRemoved(await call(
    client, "DELETE", `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
  ));
