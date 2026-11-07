// Settings → Team (ADR 0021 H2 local/UI part): decoders, validation and role gating for the team admin
// routes (API 123, `schema/http/team.schema.json`). Pure: no React, no DOM.
//
// The invite token is the one secret this module handles. It comes back only from POST /admin/invites,
// is decoded into the caller's component state, and is never written to storage or logged. The list
// routes never carry it, so `TeamInvite` has no token field at all.
import { ApiError, call, type CoreClient } from "./core-api.ts";

export const TEAM_ROLES = ["viewer", "member", "admin", "owner"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const MAX_MODES = ["none", "read_only", "execute"] as const;
export type MaxMode = (typeof MAX_MODES)[number];
/** An invite can never make an owner; an admin invite needs an owner actor (ADR 0021). */
export const INVITE_ROLES = ["member", "viewer", "admin"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const MAX_USD_CAP_MONTH = 100_000;
export const DEFAULT_USD_CAP_MONTH = 20;
export const MAX_INVITE_TTL_HOURS = 168;
export const DEFAULT_INVITE_TTL_HOURS = 24;

/** The one warning every token panel shows, verbatim (the core keeps only the token's SHA-256). */
export const TOKEN_ONCE_WARNING =
  "Copy this token now. It is shown once and cannot be shown again: the hub stores only its hash.";

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  /** The users row's status: "active" | "disabled". */
  status: string;
  teamRole: TeamRole;
  maxMode: MaxMode;
  usdCapMonth: number;
  updatedAt: string;
}

export interface TeamInvite {
  id: string;
  email: string | null;
  teamRole: InviteRole;
  maxMode: MaxMode;
  usdCapMonth: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

/** POST /admin/invites only: the token is shown once and is intentionally absent from TeamInvite. */
export interface CreatedInvite {
  id: string;
  token: string;
  expiresAt: string;
}

export interface MemberDraft {
  teamRole: TeamRole;
  maxMode: MaxMode;
  usdCapMonth: string;
}

export interface InviteDraft {
  teamRole: InviteRole;
  maxMode: MaxMode;
  usdCapMonth: string;
  ttlHours: string;
  email: string;
}

export interface MemberPatch {
  teamRole?: TeamRole;
  maxMode?: MaxMode;
  usdCapMonth?: number;
}

export interface InviteBody {
  teamRole: InviteRole;
  maxMode: MaxMode;
  usdCapMonth: number;
  ttlHours: number;
  email?: string;
}

export interface TeamIdentity {
  id: string;
  teamRole: TeamRole;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const badResponse = (): never => {
  throw new ApiError(0, "BAD_RESPONSE");
};

function readStr(v: unknown): string {
  return typeof v === "string" ? v : badResponse();
}

function readCap(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_USD_CAP_MONTH) return badResponse();
  return v;
}

export function isTeamRole(v: unknown): v is TeamRole {
  return typeof v === "string" && (TEAM_ROLES as readonly string[]).includes(v);
}

export function isMaxMode(v: unknown): v is MaxMode {
  return typeof v === "string" && (MAX_MODES as readonly string[]).includes(v);
}

export function isInviteRole(v: unknown): v is InviteRole {
  return typeof v === "string" && (INVITE_ROLES as readonly string[]).includes(v);
}

const INVITE_ID = /^[0-9a-f]{16}$/;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,512}$/;

export function decodeMember(v: unknown): TeamMember {
  if (!isRec(v)) return badResponse();
  if (!isTeamRole(v.teamRole)) return badResponse();
  if (!isMaxMode(v.maxMode)) return badResponse();
  return {
    userId: readStr(v.userId),
    email: readStr(v.email),
    displayName: readStr(v.displayName),
    status: readStr(v.status),
    teamRole: v.teamRole,
    maxMode: v.maxMode,
    usdCapMonth: readCap(v.usdCapMonth),
    updatedAt: readStr(v.updatedAt),
  };
}

export function decodeMemberList(v: unknown): TeamMember[] {
  if (!isRec(v) || !Array.isArray(v.members)) return badResponse();
  return v.members.map((m) => decodeMember(m));
}

export function decodeMemberResponse(v: unknown): TeamMember {
  if (!isRec(v)) return badResponse();
  return decodeMember(v.member);
}

export function decodeInvite(v: unknown): TeamInvite {
  if (!isRec(v)) return badResponse();
  if (typeof v.id !== "string" || !INVITE_ID.test(v.id)) return badResponse();
  if (v.email !== null && typeof v.email !== "string") return badResponse();
  if (!isInviteRole(v.teamRole)) return badResponse();
  if (!isMaxMode(v.maxMode)) return badResponse();
  if (v.usedAt !== null && typeof v.usedAt !== "string") return badResponse();
  return {
    id: v.id,
    email: v.email,
    teamRole: v.teamRole,
    maxMode: v.maxMode,
    usdCapMonth: readCap(v.usdCapMonth),
    createdBy: readStr(v.createdBy),
    createdAt: readStr(v.createdAt),
    expiresAt: readStr(v.expiresAt),
    usedAt: v.usedAt,
  };
}

export function decodeInviteList(v: unknown): TeamInvite[] {
  if (!isRec(v) || !Array.isArray(v.invites)) return badResponse();
  return v.invites.map((i) => decodeInvite(i));
}

export function decodeCreatedInvite(v: unknown): CreatedInvite {
  if (!isRec(v)) return badResponse();
  if (typeof v.id !== "string" || !INVITE_ID.test(v.id)) return badResponse();
  if (typeof v.token !== "string" || !INVITE_TOKEN.test(v.token)) return badResponse();
  return { id: v.id, token: v.token, expiresAt: readStr(v.expiresAt) };
}

export function decodeRevoked(v: unknown): boolean {
  if (!isRec(v) || typeof v.revoked !== "boolean") return badResponse();
  return v.revoked;
}

/** `/auth/me.member.teamRole`, or null for a missing/unknown row (a solo `legacy` account has none). */
export function teamRoleFromMe(v: unknown): TeamRole | null {
  if (!isRec(v) || !isRec(v.member)) return null;
  const role = v.member.teamRole;
  return isTeamRole(role) ? role : null;
}

/** What Team needs from `/auth/me`: the caller's id and their enforced team role. */
export function decodeTeamIdentity(v: unknown): TeamIdentity | null {
  if (!isRec(v) || typeof v.id !== "string") return null;
  const teamRole = teamRoleFromMe(v);
  return teamRole === null ? null : { id: v.id, teamRole };
}

export const ROLE_RANK: Readonly<Record<TeamRole, number>> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: TeamRole, minRole: TeamRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/** The Team group and every admin route need admin or owner. */
export function canManageTeam(role: TeamRole | null | undefined): role is "admin" | "owner" {
  return role === "admin" || role === "owner";
}

/** Roles this actor may hand out on PATCH: never above their own. */
export function grantableRoles(actor: TeamRole): TeamRole[] {
  return TEAM_ROLES.filter((r) => roleAtLeast(actor, r));
}

/** Roles this actor may put on an invite: only an owner may invite an admin, and never an owner. */
export function inviteRolesFor(actor: TeamRole): InviteRole[] {
  return INVITE_ROLES.filter((r) => r !== "admin" || actor === "owner");
}

export function usdCapProblem(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return "Enter a monthly USD cap, or 0 for no cap.";
  const n = Number(t);
  if (!Number.isFinite(n)) return "The monthly USD cap must be a number.";
  if (n < 0 || n > MAX_USD_CAP_MONTH) return `The monthly USD cap must be between 0 and ${MAX_USD_CAP_MONTH}.`;
  return null;
}

export function emailProblem(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  if (t.length > 254) return "The email must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+$/.test(t)) return "Enter one email address, like name@example.com.";
  return null;
}

export function ttlProblem(raw: string): string | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return "Enter a whole number of hours.";
  const n = Number(t);
  if (n < 1 || n > MAX_INVITE_TTL_HOURS) return `The invite can last 1 to ${MAX_INVITE_TTL_HOURS} hours.`;
  return null;
}

/** Why this row cannot be edited by this actor, or null when it can. Mirrors the server's rules. */
export function memberEditBlock(member: TeamMember, actorRole: TeamRole | null, selfId: string): string | null {
  if (!canManageTeam(actorRole)) return "Only the team owner and admins can change members.";
  if (member.userId === selfId) return "You cannot change your own role or grants.";
  if (!roleAtLeast(actorRole, member.teamRole)) return "Only an owner can change an owner.";
  return null;
}

export function inviteRoleBlock(actorRole: TeamRole | null, role: TeamRole): string | null {
  if (!canManageTeam(actorRole)) return "Only the team owner and admins can create invites.";
  if (role === "owner") return "An invite can never make an owner.";
  if (role === "admin" && actorRole !== "owner") return "Only an owner can invite an admin.";
  return null;
}

/** Why this draft cannot be saved by this actor, or null. The editor and the save path both use it. */
export function memberDraftProblem(member: TeamMember, draft: MemberDraft, actorRole: TeamRole | null, selfId: string): string | null {
  if (!canManageTeam(actorRole)) return "Only the team owner and admins can change members.";
  const blocked = memberEditBlock(member, actorRole, selfId);
  if (blocked !== null) return blocked;
  if (!grantableRoles(actorRole).includes(draft.teamRole)) return "You cannot grant a role above your own.";
  return usdCapProblem(draft.usdCapMonth);
}

/** The first problem with an invite draft, or null. */
export function inviteDraftProblem(draft: InviteDraft, actorRole: TeamRole | null): string | null {
  return inviteRoleBlock(actorRole, draft.teamRole)
    ?? usdCapProblem(draft.usdCapMonth)
    ?? emailProblem(draft.email)
    ?? ttlProblem(draft.ttlHours);
}

/** Only changed fields, so an untouched Save is not a pointless PATCH (the server answers "Nothing to change"). */
export function buildMemberPatch(member: TeamMember, draft: MemberDraft): MemberPatch | null {
  if (usdCapProblem(draft.usdCapMonth) !== null) return null;
  const patch: MemberPatch = {};
  if (draft.teamRole !== member.teamRole) patch.teamRole = draft.teamRole;
  if (draft.maxMode !== member.maxMode) patch.maxMode = draft.maxMode;
  const cap = Number(draft.usdCapMonth.trim());
  if (cap !== member.usdCapMonth) patch.usdCapMonth = cap;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function buildInviteBody(draft: InviteDraft, actorRole: TeamRole | null): InviteBody | null {
  if (inviteDraftProblem(draft, actorRole) !== null) return null;
  const email = draft.email.trim();
  return {
    teamRole: draft.teamRole,
    maxMode: draft.maxMode,
    usdCapMonth: Number(draft.usdCapMonth.trim()),
    ttlHours: Number(draft.ttlHours.trim()),
    ...(email === "" ? {} : { email }),
  };
}

export function defaultMemberDraft(member: TeamMember): MemberDraft {
  return { teamRole: member.teamRole, maxMode: member.maxMode, usdCapMonth: String(member.usdCapMonth) };
}

export function defaultInviteDraft(): InviteDraft {
  return {
    teamRole: "member",
    maxMode: "read_only",
    usdCapMonth: String(DEFAULT_USD_CAP_MONTH),
    ttlHours: String(DEFAULT_INVITE_TTL_HOURS),
    email: "",
  };
}

/** SQLite `datetime('now')` strings are UTC. Parse them as UTC, never as local time. */
export function parseDbTime(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** A deterministic label that never silently reinterprets the core's UTC time. */
export function dbTimeLabel(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC` : s;
}

export type InviteState = "open" | "used" | "expired";

export function inviteState(invite: TeamInvite, nowMs: number): InviteState {
  if (invite.usedAt !== null) return "used";
  const expires = parseDbTime(invite.expiresAt);
  return expires !== null && expires <= nowMs ? "expired" : "open";
}

export function roleLabel(role: TeamRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function maxModeLabel(mode: MaxMode): string {
  return mode === "none" ? "No runs" : mode === "read_only" ? "Read-only" : "Execute";
}

export function statusLabel(status: string): string {
  return status === "active" ? "Active" : status === "disabled" ? "Disabled" : status;
}

export function formatUsdCap(cap: number): string {
  return cap === 0 ? "No USD cap" : `$${cap} / month`;
}

// ---- the routes (call() throws ApiError; a non-2xx is never data here) ---------------------------------

export const listTeamMembers = async (client: CoreClient): Promise<TeamMember[]> =>
  decodeMemberList(await call(client, "GET", "/admin/members"));

export const listTeamInvites = async (client: CoreClient): Promise<TeamInvite[]> =>
  decodeInviteList(await call(client, "GET", "/admin/invites"));

export const patchTeamMember = async (client: CoreClient, userId: string, patch: MemberPatch): Promise<TeamMember> =>
  decodeMemberResponse(await call(client, "PATCH", `/admin/members/${encodeURIComponent(userId)}`, patch));

export const createTeamInvite = async (client: CoreClient, body: InviteBody): Promise<CreatedInvite> =>
  decodeCreatedInvite(await call(client, "POST", "/admin/invites", body));

export const revokeTeamInvite = async (client: CoreClient, id: string): Promise<boolean> =>
  decodeRevoked(await call(client, "DELETE", `/admin/invites/${encodeURIComponent(id)}`));
