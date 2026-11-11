// Host API v1 project scope (ADR 0021 H1.3). A frame that carries `projectId` is checked against the
// caller's fresh per-project grant on EVERY frame; an unassigned caller is a viewer (Ask only). A frame
// without `projectId` keeps the v1 team-scoped behavior, so an existing pairing/client does not break.
//
// `projects.list` is the additive command a device uses to learn its role on each project.
import { classRefusal, getMember } from '../../kb/members.mjs';
import {
  effectiveProjectGrant, getProject, listProjectsForUser,
} from '../../kb/projects.mjs';

/** The action class of each command that can carry a project id. Mirrors the gateway's COMMAND_CLASS. */
export const PROJECT_FRAME_CLASS = Object.freeze({
  'chat.send': 'model.ask',
  'chat.new': 'self.write',
  'chat.snapshot': 'self.read',
  'chat.sessions': 'self.read',
  'chat.history': 'self.read',
  'chat.cancel': 'self.write',
  'chat.history.clear': 'self.write',
  'chat.options': 'self.read',
  'approvals.answer': 'model.ask',
  'toolApprovals.answer': 'model.exec',
  'loop.issues': 'self.read',
  'loop.list': 'self.read',
  'loop.start': 'model.exec',
});

/** The `projects.list` result: id, name, the caller's effective role/mode/cap and permissions. */
export function projectsListResult(db, userId) {
  return { projects: listProjectsForUser(db, userId) };
}

/**
 * Check a frame that carries `projectId`. Pure enough to unit-test: the caller injects the spend
 * reader so a project cap is checked against that project's month, not the whole install.
 *
 * Returns `{ ok: true, projectId, scoped, grant }` (scoped false when the frame has no project id),
 * or `{ ok: false, reason, projectId }` with reason `required`, `not_found`, `role_denied`,
 * `max_mode_*` or `usd_cap`. `requireProject` is the hub rule: a project-scoped command must name a
 * project (a hub has no global chat).
 */
export function projectFrameAuthority(db, userId, command, payload, { usedUsd = null, requireProject = false } = {}) {
  const projectId = payload && typeof payload.projectId === 'string' ? payload.projectId : null;
  if (!projectId) {
    if (requireProject && PROJECT_FRAME_CLASS[command]) return { ok: false, reason: 'required', projectId: null };
    return { ok: true, projectId: null, scoped: false, grant: null };
  }
  if (!getProject(db, projectId)) {
    return { ok: false, reason: 'not_found', projectId };
  }
  const cls = PROJECT_FRAME_CLASS[command];
  if (!cls) {
    // A command that cannot carry a project id is not project-scoped; the gateway's team class still applies.
    return { ok: true, projectId, scoped: false, grant: null };
  }
  const member = getMember(db, userId);
  const grant = effectiveProjectGrant(db, userId, projectId);
  const scopeMember = {
    teamRole: grant.role, maxMode: grant.maxMode, usdCapMonth: grant.usdCapMonth,
  };
  const reason = classRefusal(scopeMember, cls, typeof usedUsd === 'function' ? () => usedUsd(projectId) : null);
  return reason
    ? { ok: false, reason, projectId }
    : { ok: true, projectId, scoped: true, grant, member: member ? { teamRole: member.teamRole } : null };
}

