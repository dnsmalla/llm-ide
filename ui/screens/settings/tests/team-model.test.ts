// Team admin model (ADR 0021 H2 local/UI part): strict decoding of the API 123 fixtures, the role/grant
// rules the server enforces, invite validation, and the five calls. No React and no network: fixtures and
// a scripted core only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INVITE_TTL_HOURS, DEFAULT_USD_CAP_MONTH, MAX_INVITE_TTL_HOURS, MAX_USD_CAP_MONTH, TOKEN_ONCE_WARNING,
  buildInviteBody, buildMemberPatch, canManageTeam, createTeamInvite, dbTimeLabel, decodeCreatedInvite,
  decodeInviteList, decodeMemberList, decodeMemberResponse, decodeRevoked, decodeTeamIdentity, defaultInviteDraft,
  emailProblem, formatUsdCap, grantableRoles, inviteDraftProblem, inviteRolesFor, inviteRoleBlock, inviteState,
  isTeamRole, listTeamInvites, listTeamMembers, maxModeLabel, memberDraftProblem, memberEditBlock, parseDbTime, patchTeamMember,
  revokeTeamInvite, roleAtLeast, roleLabel, statusLabel, teamRoleFromMe, ttlProblem, usdCapProblem,
  type MemberDraft, type TeamInvite, type TeamMember,
} from "../team-model.ts";
import { fakeClient, fixture, reply } from "./helpers.ts";

const fixtureBody = (rel: string): Record<string, unknown> => fixture(rel).response as Record<string, unknown>;
const inviteFixture = (): Record<string, unknown> =>
  (fixtureBody("team/get-admin-invites-200.json").invites as Record<string, unknown>[])[0]!;
const members = (): TeamMember[] => decodeMemberList(fixtureBody("team/get-admin-members-200.json"));
const invites = (): TeamInvite[] => decodeInviteList(fixtureBody("team/get-admin-invites-200.json"));

test("member/invite fixtures decode strictly; the invite list never carries a token", () => {
  const list = members();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.teamRole, "owner");
  assert.equal(list[1]!.usdCapMonth, 0);
  assert.equal(decodeMemberResponse(fixtureBody("team/patch-admin-members--userid-200.json")).teamRole, "viewer");

  const inv = invites();
  assert.equal(inv[0]!.id, "706a5b734356ecad");
  assert.equal(inv[0]!.usedAt, null);
  const leaked = decodeInviteList({ invites: [{ ...inviteFixture(), token: "must-not-survive" }] });
  assert.ok(!("token" in leaked[0]!));
  assert.ok(!JSON.stringify(leaked).includes("must-not-survive"));

  assert.throws(() => decodeMemberList({ members: [{ ...list[0], teamRole: "superuser" }] }));
  assert.throws(() => decodeMemberList({ members: [{ ...list[0], maxMode: "write" }] }));
  assert.throws(() => decodeMemberList({ members: [{ ...list[0], usdCapMonth: MAX_USD_CAP_MONTH + 1 }] }));
  assert.throws(() => decodeMemberList({ members: [{ ...list[0], userId: undefined }] }));
  assert.throws(() => decodeInviteList({ invites: [{ ...inv[0], id: "not-hex" }] }));
  assert.throws(() => decodeInviteList({ invites: [{ ...inv[0], teamRole: "owner" }] }));
  assert.throws(() => decodeMemberList({ nope: [] }));
});

test("the created invite keeps the token once and rejects a missing or unsafe token", () => {
  const made = decodeCreatedInvite(fixtureBody("team/post-admin-invites-200.json"));
  assert.deepEqual(Object.keys(made).sort(), ["expiresAt", "id", "token"]);
  assert.equal(made.token, "ZmFrZS1pbnZpdGUtdG9rZW4tZm9yLXRoZS10ZWFtLXNjaGVtYQ");
  assert.throws(() => decodeCreatedInvite({ id: made.id, expiresAt: made.expiresAt }), "no token = no panel");
  assert.throws(() => decodeCreatedInvite({ ...made, token: "short" }));
  assert.throws(() => decodeCreatedInvite({ ...made, token: "<script>alert(1)</script>" }));
  assert.equal(decodeRevoked({ revoked: true }), true);
  assert.equal(decodeRevoked({ revoked: false }), false);
  assert.throws(() => decodeRevoked({ revoked: "yes" }));
});

test("/auth/me.member.teamRole is the only team gate; the legacy users.role is ignored", () => {
  const me = fixtureBody("health-auth/get-auth-me-200.json");
  assert.equal(teamRoleFromMe(me), "owner");
  assert.deepEqual(decodeTeamIdentity(me), { id: "85eaf45b2dd93108", teamRole: "owner" });
  assert.equal(teamRoleFromMe({ ...me, role: "member", member: null }), null);
  assert.equal(teamRoleFromMe({ ...me, member: { teamRole: "superuser" } }), null);
  assert.equal(decodeTeamIdentity({ ...me, member: null }), null);
  assert.equal(decodeTeamIdentity({ ...me, id: 42 }), null);
  assert.ok(canManageTeam("owner"));
  assert.ok(canManageTeam("admin"));
  assert.ok(!canManageTeam("member"));
  assert.ok(!canManageTeam("viewer"));
  assert.ok(!canManageTeam(null));
  assert.ok(isTeamRole("owner"));
  assert.ok(!isTeamRole("superuser"));
});

test("roles: only an owner may grant owner or invite an admin; self and owner rows are blocked for admins", () => {
  assert.ok(roleAtLeast("owner", "admin"));
  assert.ok(roleAtLeast("admin", "admin"));
  assert.ok(!roleAtLeast("member", "admin"));
  assert.deepEqual(grantableRoles("owner"), ["viewer", "member", "admin", "owner"]);
  assert.deepEqual(grantableRoles("admin"), ["viewer", "member", "admin"]);
  assert.deepEqual(inviteRolesFor("owner"), ["member", "viewer", "admin"]);
  assert.deepEqual(inviteRolesFor("admin"), ["member", "viewer"]);

  const [owner, member] = members() as [TeamMember, TeamMember];
  assert.equal(memberEditBlock(member, "admin", owner.userId), null);
  assert.match(memberEditBlock(owner, "admin", member.userId) ?? "", /Only an owner/);
  assert.match(memberEditBlock(member, "admin", member.userId) ?? "", /your own role/);
  assert.equal(memberEditBlock(owner, "owner", member.userId), null);
  assert.match(memberEditBlock(member, "member", owner.userId) ?? "", /Only the team owner and admins/);

  assert.equal(inviteRoleBlock("owner", "admin"), null);
  assert.match(inviteRoleBlock("admin", "admin") ?? "", /Only an owner can invite an admin/);
  assert.match(inviteRoleBlock("admin", "owner") ?? "", /never make an owner/);
  assert.match(inviteRoleBlock("member", "viewer") ?? "", /Only the team owner and admins/);

  const draft: MemberDraft = { teamRole: "viewer", maxMode: "read_only", usdCapMonth: "5" };
  assert.equal(memberDraftProblem(member, draft, "admin", owner.userId), null);
  assert.match(memberDraftProblem(member, draft, "admin", member.userId) ?? "", /your own role/);
  assert.match(memberDraftProblem(owner, draft, "admin", member.userId) ?? "", /Only an owner/);
  assert.match(memberDraftProblem(member, { ...draft, teamRole: "owner" }, "admin", owner.userId) ?? "", /above your own/);
  assert.match(memberDraftProblem(member, { ...draft, usdCapMonth: "-1" }, "admin", owner.userId) ?? "", /between 0 and 100000/);
});

test("USD cap, email and TTL validation mirror the server bounds", () => {
  for (const ok of ["0", "20", "20.5", "100000", " 5 "]) assert.equal(usdCapProblem(ok), null, ok);
  for (const bad of ["", "abc", "-1", "100001", "Infinity"]) assert.notEqual(usdCapProblem(bad), null, bad);
  assert.match(usdCapProblem("100001") ?? "", new RegExp(String(MAX_USD_CAP_MONTH)));

  assert.equal(emailProblem(""), null);
  assert.equal(emailProblem("  "), null);
  assert.equal(emailProblem("a@b.example"), null);
  assert.notEqual(emailProblem("a@b@c"), null);
  assert.notEqual(emailProblem("no-at-sign"), null);
  assert.notEqual(emailProblem(`${"a".repeat(250)}@b.example`), null);

  for (const ok of ["1", "24", "168", " 12 "]) assert.equal(ttlProblem(ok), null, ok);
  for (const bad of ["", "0", "169", "1.5", "x", "-1"]) assert.notEqual(ttlProblem(bad), null, bad);
  assert.match(ttlProblem("169") ?? "", new RegExp(String(MAX_INVITE_TTL_HOURS)));
});

test("drafts build only changed fields; an invite with no email omits it", () => {
  const [owner, member] = members() as [TeamMember, TeamMember];
  const same: MemberDraft = { teamRole: member.teamRole, maxMode: member.maxMode, usdCapMonth: String(member.usdCapMonth) };
  assert.equal(buildMemberPatch(member, same), null);
  assert.deepEqual(buildMemberPatch(member, { ...same, teamRole: "viewer" }), { teamRole: "viewer" });
  assert.deepEqual(buildMemberPatch(member, { ...same, usdCapMonth: " 5 " }), { usdCapMonth: 5 });
  assert.equal(buildMemberPatch(member, { ...same, usdCapMonth: "-1" }), null);
  assert.equal(buildMemberPatch(member, { ...same, usdCapMonth: "5", maxMode: "none" })?.maxMode, "none");

  const draft = defaultInviteDraft();
  assert.equal(draft.teamRole, "member");
  assert.equal(draft.maxMode, "read_only");
  assert.equal(draft.usdCapMonth, String(DEFAULT_USD_CAP_MONTH));
  assert.equal(draft.ttlHours, String(DEFAULT_INVITE_TTL_HOURS));
  assert.equal(draft.email, "");
  assert.deepEqual(buildInviteBody(draft, "admin"), { teamRole: "member", maxMode: "read_only", usdCapMonth: 20, ttlHours: 24 });
  assert.deepEqual(buildInviteBody({ ...draft, email: " new@example.com " }, "owner"), {
    teamRole: "member", maxMode: "read_only", usdCapMonth: 20, ttlHours: 24, email: "new@example.com",
  });
  assert.equal(buildInviteBody({ ...draft, teamRole: "admin" }, "admin"), null);
  assert.equal(buildInviteBody({ ...draft, ttlHours: "0" }, "owner"), null);
  assert.equal(buildInviteBody({ ...draft, email: "nope" }, "owner"), null);
  assert.equal(inviteDraftProblem({ ...draft, teamRole: "admin" }, "admin"), "Only an owner can invite an admin.");

  assert.equal(owner.teamRole, "owner");
  assert.equal(member.teamRole, "member");
  assert.match(TOKEN_ONCE_WARNING, /shown once/);
  assert.match(TOKEN_ONCE_WARNING, /cannot be shown again/);
});

test("invite state is computed from the core's UTC strings, never from local time", () => {
  const invite = invites()[0]!;
  const expiry = Date.UTC(2026, 10, 8, 8, 17, 33);
  assert.equal(parseDbTime("2026-11-08 08:17:33"), expiry);
  assert.equal(parseDbTime("2026-11-08T08:17:33"), expiry);
  assert.equal(parseDbTime("not a date"), null);
  assert.equal(dbTimeLabel("2026-11-08 08:17:33"), "2026-11-08 08:17:33 UTC");
  assert.equal(dbTimeLabel("nonsense"), "nonsense");
  assert.equal(inviteState(invite, expiry - 1), "open");
  assert.equal(inviteState(invite, expiry), "expired");
  assert.equal(inviteState({ ...invite, usedAt: "2026-11-07 09:00:00" }, 0), "used");
});

test("labels and caps read as plain text", () => {
  assert.equal(roleLabel("owner"), "Owner");
  assert.equal(roleLabel("viewer"), "Viewer");
  assert.equal(maxModeLabel("none"), "No runs");
  assert.equal(maxModeLabel("read_only"), "Read-only");
  assert.equal(maxModeLabel("execute"), "Execute");
  assert.equal(statusLabel("active"), "Active");
  assert.equal(statusLabel("disabled"), "Disabled");
  assert.equal(formatUsdCap(0), "No USD cap");
  assert.equal(formatUsdCap(20), "$20 / month");
});

test("the five calls hit the API 123 routes with closed bodies", async () => {
  const c = fakeClient({
    "GET /admin/members": () => reply("team/get-admin-members-200.json"),
    "GET /admin/invites": () => reply("team/get-admin-invites-200.json"),
    "PATCH /admin/members/12c2fcdf904d8d13": () => reply("team/patch-admin-members--userid-200.json"),
    "POST /admin/invites": () => reply("team/post-admin-invites-200.json"),
    "DELETE /admin/invites/706a5b734356ecad": () => reply("team/delete-admin-invites--id-200.json"),
  });
  assert.equal((await listTeamMembers(c)).length, 2);
  assert.equal((await listTeamInvites(c)).length, 1);
  assert.equal((await patchTeamMember(c, "12c2fcdf904d8d13", { teamRole: "viewer", maxMode: "read_only", usdCapMonth: 5 })).teamRole, "viewer");
  const made = await createTeamInvite(c, { teamRole: "viewer", maxMode: "read_only", usdCapMonth: 5, ttlHours: 24 });
  assert.equal(made.id, "b06037719d59b647");
  assert.equal(await revokeTeamInvite(c, "706a5b734356ecad"), true);
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.path}`), [
    "GET /admin/members",
    "GET /admin/invites",
    "PATCH /admin/members/12c2fcdf904d8d13",
    "POST /admin/invites",
    "DELETE /admin/invites/706a5b734356ecad",
  ]);
  assert.deepEqual(c.calls[2]!.body, { teamRole: "viewer", maxMode: "read_only", usdCapMonth: 5 });
  assert.deepEqual(c.calls[3]!.body, { teamRole: "viewer", maxMode: "read_only", usdCapMonth: 5, ttlHours: 24 });
  assert.ok(!JSON.stringify(c.calls).includes(made.token), "the token never rides on a later call");
});
