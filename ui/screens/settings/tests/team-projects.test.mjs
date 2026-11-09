// Render/logic tests for Settings → Team → project (ADR 0021 H1.3). Pure decoders and form rules are
// exercised directly; the views are bundled and rendered with react-dom/server, like the team tests.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = resolve(HERE, "..");
const REPO = resolve(SETTINGS, "../../..");
const DESKTOP = join(REPO, "desktop");
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";
const req = createRequire(join(DESKTOP, "package.json"));
const { build } = req("esbuild");
const { createElement: h } = req("react");
const { renderToStaticMarkup } = req("react-dom/server");

const html = (el) => renderToStaticMarkup(el);
const buttonTag = (out, label) => out.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";

const PROJECT = {
  id: "p-one", name: "One", role: "admin", maxMode: "execute", usdCapMonth: 20,
  permissions: ["self.read", "self.write", "model.ask", "model.read", "model.exec", "project.admin"],
};
const VIEWER_PROJECT = {
  id: "p-two", name: "Two", role: "viewer", maxMode: "read_only", usdCapMonth: 20,
  permissions: ["self.read", "self.write", "model.ask"],
};
const OWNER_MEMBER = {
  userId: "u-owner", email: "owner@example.com", displayName: "Owner", status: "active",
  role: "owner", maxMode: "execute", usdCapMonth: 0, updatedAt: "2026-11-08 00:00:00",
};
const ENGINEER_MEMBER = {
  userId: "u-eng", email: "eng@example.com", displayName: "Engineer", status: "active",
  role: "member", maxMode: "execute", usdCapMonth: 5, updatedAt: "2026-11-08 00:00:00",
};

let m;
before(async () => {
  const outdir = bundleDir("team-projects");
  await build({
    entryPoints: {
      model: join(SETTINGS, "team-projects-model.ts"),
      view: join(SETTINGS, "sections/team-projects-view.tsx"),
      section: join(SETTINGS, "sections/TeamProjectsSection.tsx"),
      context: join(SETTINGS, "context.tsx"),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "silent",
    loader: { ".css": "empty" },
    alias: {
      "@llmide/ui-kit/styles.css": join(REPO, "ui/kit/src/styles/kit.css"),
      "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts"),
    },
  });
  const t = `?t=${Date.now()}`;
  m = {};
  for (const k of ["model", "view", "section", "context"]) m[k] = await import(pathToFileURL(join(outdir, `${k}.js`)).href + t);
});

test("decoders accept the API 126 project and member shapes, and reject a bad role/cap", () => {
  const project = m.model.decodeProject(PROJECT);
  assert.equal(project.role, "admin");
  assert.deepEqual(project.permissions, PROJECT.permissions);
  assert.deepEqual(m.model.decodeProjects({ projects: [PROJECT, VIEWER_PROJECT] }).map((p) => p.role), ["admin", "viewer"]);
  assert.throws(() => m.model.decodeProject({ ...PROJECT, role: "root" }));
  assert.throws(() => m.model.decodeProject({ ...PROJECT, usdCapMonth: -1 }));
  assert.throws(() => m.model.decodeProject({ ...PROJECT, id: "../x" }));

  const member = m.model.decodeProjectMember(ENGINEER_MEMBER);
  assert.equal(member.role, "member");
  assert.deepEqual(m.model.decodeProjectMembers({
    project: { id: "p-one", name: "One" },
    members: [OWNER_MEMBER, ENGINEER_MEMBER],
  }).members.map((x) => x.role), ["owner", "member"]);
  assert.equal(m.model.decodeProjectRemoved({ removed: true }), true);
  assert.throws(() => m.model.decodeProjectRemoved({ removed: "yes" }));
});

test("projectsFromMe reads /auth/me.projects and returns null for an older core", () => {
  assert.deepEqual(m.model.projectsFromMe({ projects: [PROJECT] }).map((p) => p.id), ["p-one"]);
  assert.equal(m.model.projectsFromMe({}), null);
  assert.equal(m.model.projectFromMe({ projects: [PROJECT] }, "p-one").role, "admin");
  assert.equal(m.model.projectFromMe({ projects: [PROJECT] }, "p-two"), null);
});

test("role gating: a project admin manages this project, a viewer does not", () => {
  assert.equal(m.model.canManageProject("admin"), true);
  assert.equal(m.model.canManageProject("owner"), true);
  assert.equal(m.model.canManageProject("member"), false);
  assert.equal(m.model.canManageProject("viewer"), false);
  assert.deepEqual(m.model.grantableProjectRoles("admin"), ["viewer", "member", "admin"]);
  assert.deepEqual(m.model.grantableProjectRoles("owner"), ["viewer", "member", "admin", "owner"]);
  assert.equal(m.model.teamPanelVisible("member", "admin"), true);
  assert.equal(m.model.teamPanelVisible("member", "viewer"), false);
  assert.equal(m.model.teamPanelVisible("owner", null), true);
});

test("member edit rules mirror the core: no self-change, no grant above the actor", () => {
  assert.match(m.model.projectMemberEditBlock(ENGINEER_MEMBER, "admin", ENGINEER_MEMBER.userId), /own project role/);
  assert.match(m.model.projectMemberEditBlock(OWNER_MEMBER, "admin", "u-eng"), /project owner/);
  assert.equal(m.model.projectMemberEditBlock(ENGINEER_MEMBER, "admin", OWNER_MEMBER.userId), null);
  assert.match(m.model.projectMemberEditBlock(ENGINEER_MEMBER, "member", OWNER_MEMBER.userId), /project owner or admin/);

  const draft = m.model.defaultProjectMemberDraft(ENGINEER_MEMBER);
  assert.deepEqual(draft, { role: "member", maxMode: "execute", usdCapMonth: "5" });
  assert.equal(m.model.projectMemberDraftProblem(ENGINEER_MEMBER, draft, "admin", OWNER_MEMBER.userId), null);
  assert.equal(m.model.projectMemberDraftProblem(ENGINEER_MEMBER, { ...draft, usdCapMonth: "-1" }, "admin", OWNER_MEMBER.userId),
    "The monthly USD cap must be between 0 and 100000.");
  assert.match(m.model.projectMemberDraftProblem(ENGINEER_MEMBER, { ...draft, role: "owner" }, "admin", OWNER_MEMBER.userId),
    /above your own/);
  assert.deepEqual(m.model.buildProjectMemberPatch(ENGINEER_MEMBER, draft), null);
  assert.deepEqual(m.model.buildProjectMemberPatch(ENGINEER_MEMBER, { ...draft, role: "admin" }), { role: "admin" });
});

test("add-by-email validates the address and builds the body", () => {
  assert.match(m.model.addProjectMemberProblem("", "member", "execute", "20"), /email/);
  assert.match(m.model.addProjectMemberProblem("not-an-email", "member", "execute", "20"), /one email/);
  assert.equal(m.model.addProjectMemberProblem("a@example.com", "member", "execute", "20"), null);
  assert.deepEqual(m.model.buildAddProjectMemberBody("a@example.com", "member", "execute", "20"), {
    email: "a@example.com", role: "member", maxMode: "execute", usdCapMonth: 20,
  });
  assert.equal(m.model.buildAddProjectMemberBody("a@example.com", "member", "execute", "-1"), null);
});

test("permissions feed the chat mode gate: a project viewer is Ask only", () => {
  const adminPerms = m.model.projectPermissions(m.model.decodeProject(PROJECT));
  assert.ok(adminPerms.has("model.exec"));
  const viewerPerms = m.model.projectPermissions(m.model.decodeProject(VIEWER_PROJECT));
  assert.ok(viewerPerms.has("model.ask"));
  assert.ok(!viewerPerms.has("model.exec"));
  assert.equal(m.model.projectPermissions(null), null);
});

test("the project picker renders every project, the selected one and the no-project hint", () => {
  const out = html(h(m.view.ProjectPickerView, {
    projects: [m.model.decodeProject(PROJECT), m.model.decodeProject(VIEWER_PROJECT)],
    selectedId: "p-two",
    onSelect() {},
  }));
  assert.match(out, /aria-label="Project"/);
  assert.match(out, /value="p-two" selected/);
  assert.match(out, />One</);
  assert.match(out, />Two</);
  assert.match(html(h(m.view.ProjectPickerView, { projects: [], selectedId: null, onSelect() {} })), /No projects are registered/);
});

test("the role notice explains the effective project grant", () => {
  const admin = html(h(m.view.ProjectRoleNotice, { project: m.model.decodeProject(PROJECT) }));
  assert.match(admin, /On <strong>One<\/strong> you are Admin/);
  assert.match(admin, /Execute/);
  assert.match(admin, /\$20 \/ month/);
  assert.ok(!admin.includes("A viewer can read and Ask only"));
  const viewer = html(h(m.view.ProjectRoleNotice, { project: m.model.decodeProject(VIEWER_PROJECT) }));
  assert.match(viewer, /Viewer/);
  assert.match(viewer, /A viewer can read and Ask only/);
  assert.match(html(h(m.view.ProjectRoleNotice, { project: null })), /Choose a project/);
});

test("member rows show role/mode/cap and hide Edit where the actor may not act", () => {
  const row = html(h(m.view.ProjectMemberRowView, {
    member: ENGINEER_MEMBER, actorRole: "admin", selfId: OWNER_MEMBER.userId, onEdit() {},
  }));
  assert.match(row, /eng@example\.com/);
  assert.match(row, /Member · Execute · \$5 \/ month · Active/);
  assert.match(buttonTag(row, "Edit"), /aria-label="Edit eng@example.com"/);

  const ownerRow = html(h(m.view.ProjectMemberRowView, {
    member: OWNER_MEMBER, actorRole: "admin", selfId: ENGINEER_MEMBER.userId, onEdit() {},
  }));
  assert.match(ownerRow, /Only a project owner can change a project owner/);
  assert.equal(buttonTag(ownerRow, "Edit"), "");

  const selfRow = html(h(m.view.ProjectMemberRowView, {
    member: ENGINEER_MEMBER, actorRole: "admin", selfId: ENGINEER_MEMBER.userId, onEdit() {},
  }));
  assert.match(selfRow, /You cannot change your own project role/);
  assert.equal(buttonTag(selfRow, "Edit"), "");
});

test("the editor offers only grantable roles and keeps Save off until something changes", () => {
  const draft = m.model.defaultProjectMemberDraft(ENGINEER_MEMBER);
  const out = html(h(m.view.ProjectMemberEditorView, {
    member: ENGINEER_MEMBER, actorRole: "admin", selfId: OWNER_MEMBER.userId,
    draft, onChange() {}, onSave() {}, onCancel() {}, busy: false,
  }));
  assert.match(out, /aria-label="Edit eng@example.com on this project"/);
  assert.ok(!out.includes('value="owner"'), "an admin cannot grant project owner");
  for (const r of ["viewer", "member", "admin"]) assert.match(out, new RegExp(`value="${r}"`));
  assert.ok(buttonTag(out, "Save changes").includes("disabled"), "nothing changed = nothing to PATCH");

  const changed = html(h(m.view.ProjectMemberEditorView, {
    member: ENGINEER_MEMBER, actorRole: "admin", selfId: OWNER_MEMBER.userId,
    draft: { ...draft, role: "admin" }, onChange() {}, onSave() {}, onCancel() {}, busy: false,
  }));
  assert.ok(!buttonTag(changed, "Save changes").includes("disabled"));

  const broken = html(h(m.view.ProjectMemberEditorView, {
    member: ENGINEER_MEMBER, actorRole: "admin", selfId: OWNER_MEMBER.userId,
    draft: { ...draft, usdCapMonth: "-1" }, onChange() {}, onSave() {}, onCancel() {}, busy: false,
  }));
  assert.match(broken, /role="alert"[^>]*>The monthly USD cap must be between 0 and 100000\./);
});

test("the add form explains a bad email and disables its button", () => {
  const out = html(h(m.view.ProjectAddMemberView, {
    email: "nope", role: "member", maxMode: "execute", usdCapMonth: "20",
    actorRole: "admin", busy: false, onChange() {}, onSubmit() {},
  }));
  assert.match(out, /aria-label="Add a project member"/);
  assert.match(out, /role="alert"[^>]*>Enter one email address/);
  assert.ok(buttonTag(out, "Add to project").includes("disabled"));
});

test("container: no fake rows before /auth/me and /projects answer", () => {
  let requested = 0;
  const env = {
    client: { async request() { requested++; return { status: 200, body: {} }; } },
    host: { diagnostics: async () => ({}), copyText: async () => {} },
  };
  const out = html(h(m.context.SettingsEnvProvider, { env }, h(m.section.default)));
  assert.match(out, /Checking your projects…/);
  assert.ok(!/eng@example\.com|owner@example\.com/.test(out), "no fake rows");
  assert.equal(requested, 0, "the first paint makes no request");
});

test('R-020 #9: project list and member requests carry an AbortSignal', async () => {
  const seen = [];
  const client = {
    async request(method, path, body, signal) {
      seen.push({ path, signal });
      if (path.endsWith('/members')) return { status: 200, body: { project: { id: 'p-one', name: 'One' }, members: [] } };
      return { status: 200, body: { projects: [] } };
    },
  };
  const ac = new AbortController();
  await m.model.listProjects(client, ac.signal);
  await m.model.listProjectMemberRows(client, 'p-one', ac.signal);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.signal === ac.signal), 'the signal reaches every request');
});

// ---- plan-task assignments (API 130) ---------------------------------------------------------------

const ASSIGNEE = { userId: "u-eng", displayName: "Engineer", email: "eng@example.com" };
const ASSIGNED_TASK = {
  taskId: "t-1", planId: "plan-1", projectId: "p-one", projectName: "One", planTitle: "Plan One",
  title: "Task A", status: "planned", due: "2026-11-20", milestone: "M1", owner: "planner",
  assignee: ASSIGNEE, assignedBy: OWNER_MEMBER, assignedAt: "2026-11-09 00:00:00",
};
const UNASSIGNED_TASK = {
  ...ASSIGNED_TASK, taskId: "t-2", title: "Task B", projectName: null,
  assignee: null, assignedBy: null, assignedAt: null,
};

test("assignment decoders accept the API 130 rows and reject a missing assignee record", () => {
  const rows = m.model.decodeMyAssignments({ assignments: [ASSIGNED_TASK] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assignee.userId, "u-eng");
  assert.equal(rows[0].projectName, "One");
  const board = m.model.decodeProjectPlanTasks({ project: { id: "p-one", name: "One" }, tasks: [ASSIGNED_TASK, UNASSIGNED_TASK] });
  assert.equal(board.tasks.length, 2);
  assert.equal(board.tasks[1].assignee, null, "an unassigned board row decodes to null");
  assert.throws(() => m.model.decodeMyAssignments({ assignments: [{ ...ASSIGNED_TASK, assignee: null }] }));
  assert.throws(() => m.model.decodeProjectPlanTasks({ project: { id: "../x", name: "One" }, tasks: [] }));
  assert.equal(m.model.decodeAssignTaskResponse({
    assignment: { taskId: "t-1", planId: "p", projectId: "p-one", assignee: ASSIGNEE, assignedBy: null, assignedAt: null },
    changed: true, action: "assign",
  }).assignment.assignee.userId, "u-eng");
  assert.equal(m.model.decodeUnassignTaskResponse({ unassigned: true }), true);
});

test("assignment controls mirror the core: admin picks, a member claims/releases, someone else's is read-only", () => {
  assert.equal(m.model.canViewProjectTasks("member"), true);
  assert.equal(m.model.canViewProjectTasks("admin"), true);
  assert.equal(m.model.canViewProjectTasks("viewer"), false);
  assert.equal(m.model.assignmentControl(UNASSIGNED_TASK, "admin", "u-owner"), "manage");
  assert.equal(m.model.assignmentControl(ASSIGNED_TASK, "admin", "u-owner"), "manage");
  assert.equal(m.model.assignmentControl(UNASSIGNED_TASK, "member", "u-eng"), "claim");
  assert.equal(m.model.assignmentControl(ASSIGNED_TASK, "member", "u-eng"), "release");
  assert.equal(m.model.assignmentControl(ASSIGNED_TASK, "member", "u-other"), "readonly");
  // A downgraded team viewer can still release a task that is already theirs (the core allows the assignee).
  assert.equal(m.model.assignmentControl(ASSIGNED_TASK, "viewer", "u-eng"), "release");
  assert.equal(m.model.assignmentControl(ASSIGNED_TASK, "viewer", "u-other"), "readonly");

  const choices = m.model.assigneeChoices([OWNER_MEMBER, ENGINEER_MEMBER], { ...ASSIGNEE, userId: "u-team-admin", displayName: "Team Admin" });
  assert.deepEqual(choices.map((c) => c.label), ["Unassigned", "Owner", "Engineer", "Team Admin"]);
});

test("Assigned to me: count badge, project/plan context and the empty state", () => {
  const out = html(h(m.view.MyAssignmentsView, { rows: [ASSIGNED_TASK, UNASSIGNED_TASK], loaded: true, error: null }));
  assert.match(out, /Assigned to me/);
  assert.match(out, /aria-label="2 assignments"/);
  assert.match(out, /Task A/);
  assert.match(out, /One · Plan One/);
  assert.match(out, /planned · due 2026-11-20 · M1 · plan owner: planner/);

  const empty = html(h(m.view.MyAssignmentsView, { rows: [], loaded: true, error: null }));
  assert.match(empty, /No plan tasks are assigned to you\./);
  const failed = html(h(m.view.MyAssignmentsView, { rows: [], loaded: false, error: "Unavailable", onRetry() {} }));
  assert.match(failed, /role="alert"[^>]*>Unavailable/);
  assert.match(failed, /<button[^>]*>Retry<\/button>/);
});

test("project plan tasks: an admin sees the member picker and the current assignee", () => {
  const out = html(h(m.view.ProjectPlanTasksView, {
    tasks: [ASSIGNED_TASK, UNASSIGNED_TASK], members: [OWNER_MEMBER, ENGINEER_MEMBER],
    role: "admin", selfId: OWNER_MEMBER.userId, busy: false, error: null,
    onAssign() {}, onUnassign() {},
  }));
  assert.match(out, /aria-label="Assignee for Task A"/);
  assert.match(out, /Assignee: Engineer/);
  assert.match(out, /Assignee: Unassigned/);
  for (const label of ["Unassigned", "Owner", "Engineer"]) assert.match(out, new RegExp(`>${label}<`));
});

test("project plan tasks: a member can claim an unassigned task or release their own, never take another's", () => {
  const claim = html(h(m.view.ProjectPlanTasksView, {
    tasks: [UNASSIGNED_TASK], members: [], role: "member", selfId: ENGINEER_MEMBER.userId,
    busy: false, error: null, onAssign() {}, onUnassign() {},
  }));
  assert.match(buttonTag(claim, "Assign to me"), /aria-label="Assign Task B to me"/);

  const release = html(h(m.view.ProjectPlanTasksView, {
    tasks: [ASSIGNED_TASK], members: [], role: "member", selfId: ENGINEER_MEMBER.userId,
    busy: false, error: null, onAssign() {}, onUnassign() {},
  }));
  assert.match(buttonTag(release, "Release"), /aria-label="Release Task A"/);

  const readonly = html(h(m.view.ProjectPlanTasksView, {
    tasks: [ASSIGNED_TASK], members: [], role: "member", selfId: OWNER_MEMBER.userId,
    busy: false, error: null, onAssign() {}, onUnassign() {},
  }));
  assert.match(readonly, /Only a project owner or admin can change this assignment/);
  assert.equal(buttonTag(readonly, "Assign to me"), "");
  assert.equal(buttonTag(readonly, "Release"), "");
});

test("project plan tasks: empty and loading states are honest", () => {
  const loading = html(h(m.view.ProjectPlanTasksView, {
    tasks: null, members: [], role: "member", selfId: ENGINEER_MEMBER.userId,
    busy: false, error: null, onAssign() {}, onUnassign() {},
  }));
  assert.match(loading, /Loading plan tasks…/);
  const empty = html(h(m.view.ProjectPlanTasksView, {
    tasks: [], members: [], role: "member", selfId: ENGINEER_MEMBER.userId,
    busy: false, error: null, onAssign() {}, onUnassign() {},
  }));
  assert.match(empty, /No plan tasks are tagged with this project yet/);
});
