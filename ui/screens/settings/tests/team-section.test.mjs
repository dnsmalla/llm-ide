// Render tests for Settings → Team (ADR 0021 H2 local/UI part): member rows, the grant editor, the
// create-invite form, the one-time token panel, invite rows and the role gate. Pure views are rendered with
// react-dom/server; the container is checked for its honest loading state before any request.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const fixture = (rel) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures", rel), "utf8")).response;
const [owner, member] = fixture("team/get-admin-members-200.json").members;
const invite = fixture("team/get-admin-invites-200.json").invites[0];
const created = fixture("team/post-admin-invites-200.json");
const buttonTag = (out, label) => out.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";

let m;
before(async () => {
  const outdir = bundleDir("team-section");
  await build({
    entryPoints: {
      view: join(SETTINGS, "sections/team-view.tsx"),
      model: join(SETTINGS, "team-model.ts"),
      section: join(SETTINGS, "sections/TeamSection.tsx"),
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
  for (const k of ["view", "model", "section", "context"]) m[k] = await import(pathToFileURL(join(outdir, `${k}.js`)).href + t);
});

test("role gate: member/viewer see the admin-only notice, owner/admin see the section", () => {
  for (const role of ["member", "viewer"]) {
    const out = html(h(m.view.TeamAccessNotice, { teamRole: role }));
    assert.match(out, /Only the team owner and admins can see members and invites/);
    assert.match(out, new RegExp(`Your team role is ${role[0].toUpperCase()}${role.slice(1)}`));
    assert.match(out, /role="status"/);
  }
  assert.equal(html(h(m.view.TeamAccessNotice, { teamRole: "owner" })), "");
  assert.equal(html(h(m.view.TeamAccessNotice, { teamRole: "admin" })), "");
  assert.match(html(h(m.view.TeamAccessNotice, { teamRole: null })), /Only the team owner and admins/);
});

test("member row: email, display name, role, max mode, cap and status; admin cannot edit an owner or themselves", () => {
  const memberRow = html(h(m.view.MemberRowView, { member, actorRole: "admin", selfId: owner.userId, onEdit() {} }));
  assert.match(memberRow, new RegExp(member.email.replaceAll(".", "\\.")));
  assert.match(memberRow, new RegExp(member.displayName));
  assert.match(memberRow, /Member · Execute · No USD cap · Active/);
  assert.match(buttonTag(memberRow, "Edit"), /aria-label="Edit capture-member@example.com"/);

  const ownerRow = html(h(m.view.MemberRowView, { member: owner, actorRole: "admin", selfId: member.userId, onEdit() {} }));
  assert.match(ownerRow, /Only an owner can change an owner\./);
  assert.equal(buttonTag(ownerRow, "Edit"), "", "no Edit button for an owner an admin may not touch");

  const selfRow = html(h(m.view.MemberRowView, { member, actorRole: "admin", selfId: member.userId, onEdit() {} }));
  assert.match(selfRow, /You cannot change your own role or grants\./);
  assert.equal(buttonTag(selfRow, "Edit"), "", "never a self-grant");

  const ownerActorRow = html(h(m.view.MemberRowView, { member: owner, actorRole: "owner", selfId: member.userId, onEdit() {} }));
  assert.match(buttonTag(ownerActorRow, "Edit"), />Edit</);
});

test("grant editor: role options stop at the actor's role, Save stays off until something changes and the cap is valid", () => {
  const draft = { teamRole: "viewer", maxMode: "read_only", usdCapMonth: "5" };
  const adminView = html(h(m.view.MemberEditorView, {
    member, actorRole: "admin", selfId: owner.userId, draft, onChange() {}, onSave() {}, onCancel() {}, busy: false,
  }));
  assert.match(adminView, /aria-label="Edit capture-member@example.com"/);
  assert.ok(!adminView.includes('value="owner"'), "an admin cannot grant owner");
  for (const r of ["viewer", "member", "admin"]) assert.match(adminView, new RegExp(`value="${r}"`));
  assert.match(adminView, /Monthly USD cap/);
  assert.match(adminView, /max="100000"/);
  assert.ok(!buttonTag(adminView, "Save changes").includes("disabled"), "a valid changed grant can be saved");

  const ownerView = html(h(m.view.MemberEditorView, {
    member, actorRole: "owner", selfId: owner.userId, draft, onChange() {}, onSave() {}, onCancel() {}, busy: false,
  }));
  assert.match(ownerView, /value="owner"/, "only an owner may grant owner");

  const overreach = html(h(m.view.MemberEditorView, {
    member, actorRole: "admin", selfId: owner.userId, draft: { ...draft, teamRole: "owner" }, onChange() {}, onSave() {}, onCancel() {}, busy: false,
  }));
  assert.match(overreach, /You cannot grant a role above your own\./);
  assert.ok(buttonTag(overreach, "Save changes").includes("disabled"));

  const unchanged = { teamRole: member.teamRole, maxMode: member.maxMode, usdCapMonth: String(member.usdCapMonth) };
  const unchangedView = html(h(m.view.MemberEditorView, {
    member, actorRole: "admin", selfId: owner.userId, draft: unchanged, onChange() {}, onSave() {}, onCancel() {}, busy: false,
  }));
  assert.ok(buttonTag(unchangedView, "Save changes").includes("disabled"), "nothing changed = nothing to PATCH");

  const broken = html(h(m.view.MemberEditorView, {
    member, actorRole: "admin", selfId: owner.userId, draft: { ...draft, usdCapMonth: "-1" }, onChange() {}, onSave() {}, onCancel() {}, busy: false,
  }));
  assert.match(broken, /role="alert"[^>]*>The monthly USD cap must be between 0 and 100000\./);
  assert.ok(buttonTag(broken, "Save changes").includes("disabled"));

  const busy = html(h(m.view.MemberEditorView, {
    member, actorRole: "admin", selfId: owner.userId, draft, onChange() {}, onSave() {}, onCancel() {}, busy: true,
  }));
  assert.ok(buttonTag(busy, "Save changes").includes("disabled"));
  assert.ok(buttonTag(busy, "Cancel").includes("disabled"));
});

test("invite form: owner-only Admin role, 1-168 hour TTL, optional email, inline validation", () => {
  const draft = m.model.defaultInviteDraft();
  const adminView = html(h(m.view.InviteFormView, {
    actorRole: "admin", draft, onChange() {}, onSubmit() {}, busy: false,
  }));
  assert.match(adminView, /aria-label="Create an invite"/);
  assert.match(adminView, /value="member"/);
  assert.match(adminView, /value="viewer"/);
  assert.ok(!adminView.includes('value="admin"'), "an admin cannot invite an admin");
  assert.ok(!adminView.includes('value="owner"'), "an invite can never make an owner");
  assert.match(adminView, /max="168"/);
  assert.match(adminView, /Email \(optional\)/);
  assert.doesNotMatch(adminView, /role="alert"/, "the default draft is valid");

  const ownerView = html(h(m.view.InviteFormView, {
    actorRole: "owner", draft, onChange() {}, onSubmit() {}, busy: false,
  }));
  assert.match(ownerView, /value="admin"/, "an owner may invite an admin");

  const broken = html(h(m.view.InviteFormView, {
    actorRole: "owner", draft: { ...draft, ttlHours: "169" }, onChange() {}, onSubmit() {}, busy: false,
  }));
  assert.match(broken, /The invite can last 1 to 168 hours\./);
  assert.ok(buttonTag(broken, "Create invite").includes("disabled"));

  const good = html(h(m.view.InviteFormView, {
    actorRole: "owner", draft: { ...draft, email: "new@example.com" }, onChange() {}, onSubmit() {}, busy: false,
  }));
  assert.ok(!buttonTag(good, "Create invite").includes("disabled"));
});

test("one-time token: the warning, the token once, Copy and Done; no second reveal path", () => {
  const out = html(h(m.view.InviteTokenView, {
    created, copied: false, copyFailed: false, onCopy() {}, onDismiss() {},
  }));
  assert.match(out, /role="region"[^>]*aria-label="New invite token"|aria-label="New invite token"[^>]*role="region"/);
  assert.match(out, /Copy this token now\. It is shown once and cannot be shown again/);
  assert.match(out, /role="alert"/);
  assert.equal(out.split(created.token).length - 1, 1, "the token appears exactly once");
  assert.match(buttonTag(out, "Copy token"), /Copy token/);
  assert.match(buttonTag(out, "Done"), /Done/);
  assert.match(out, /Expires 2026-11-08 08:17:35 UTC/);
  assert.ok(!/type="password"|type="hidden"|localStorage/.test(out));

  const copied = html(h(m.view.InviteTokenView, {
    created, copied: true, copyFailed: false, onCopy() {}, onDismiss() {},
  }));
  assert.match(copied, /Copied to the clipboard\./);
  const failed = html(h(m.view.InviteTokenView, {
    created, copied: false, copyFailed: true, onCopy() {}, onDismiss() {},
  }));
  assert.match(failed, /Could not copy\. Select the token above and copy it by hand\./);
});

test("invite row: no token, status from UTC times, revoke behind a confirmation and never for a used invite", () => {
  const open = Date.UTC(2026, 10, 7, 9, 0, 0);
  const openView = html(h(m.view.InviteRowView, {
    invite, nowMs: open, confirming: false, busy: false, onAskRevoke() {}, onCancelRevoke() {}, onRevoke() {},
  }));
  assert.match(openView, /new-member@example\.com/);
  assert.match(openView, /Member · Read-only · \$20 \/ month/);
  assert.match(openView, /Expires 2026-11-08 08:17:33 UTC/);
  assert.match(buttonTag(openView, "Revoke"), /aria-label="Revoke invite for new-member@example.com"/);
  assert.ok(!openView.includes(created.token), "a list row never has a token");

  const confirming = html(h(m.view.InviteRowView, {
    invite, nowMs: open, confirming: true, busy: false, onAskRevoke() {}, onCancelRevoke() {}, onRevoke() {},
  }));
  assert.match(confirming, /Revoke it\? The link stops working\./);
  assert.match(buttonTag(confirming, "Revoke"), /Revoke/);
  assert.match(buttonTag(confirming, "Cancel"), /Cancel/);

  const expired = html(h(m.view.InviteRowView, {
    invite, nowMs: Date.UTC(2026, 10, 9, 0, 0, 0), confirming: false, busy: false, onAskRevoke() {}, onCancelRevoke() {}, onRevoke() {},
  }));
  assert.match(expired, /Expired 2026-11-08 08:17:33 UTC/);

  const used = html(h(m.view.InviteRowView, {
    invite: { ...invite, usedAt: "2026-11-07 09:30:00" },
    nowMs: open, confirming: false, busy: false, onAskRevoke() {}, onCancelRevoke() {}, onRevoke() {},
  }));
  assert.match(used, /Used 2026-11-07 09:30:00 UTC/);
  assert.equal(buttonTag(used, "Revoke"), "");
});

test("container: no fake data before /auth/me answers, and no admin calls from the pure view layer", () => {
  let requested = 0;
  const env = {
    client: { async request() { requested++; return { status: 200, body: {} }; } },
    host: { diagnostics: async () => ({}), copyText: async () => {} },
  };
  const out = html(h(m.context.SettingsEnvProvider, { env }, h(m.section.default)));
  assert.match(out, /Checking your team role…/);
  assert.ok(!/capture-owner@example\.com|capture-member@example\.com/.test(out), "no fake rows");
  assert.equal(requested, 0, "the first paint makes no request");
});
