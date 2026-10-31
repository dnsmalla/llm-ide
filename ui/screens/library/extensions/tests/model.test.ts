import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionsApi } from "../api.ts";
import { ExtensionsModel } from "../model.ts";
import { deferred, err, fakeCore, fx, reply, tick, type Call, type Handler } from "./helpers.ts";

const P = "/auth/me/extensions";
type Item = Record<string, any>;
const E = "e".repeat(40);
const F = "f".repeat(40);

const baseItems = (): Item[] => structuredClone((fx("get-auth-me-extensions-installed-200-2").response as { items: Item[] }).items);
const runnerBody = (over: Item = {}): Item => {
  const runner = baseItems().find((i) => i.id === "plugin:acme/runner")!;
  return { ...runner, declared: { executableKinds: ["hook"] }, members: [...runner.members, { memberId: "hook:Stop", type: "hook", name: "Stop", executable: true }], ...over };
};
const ok = (body: unknown) => ({ status: 200, body });

function setup(routes: Record<string, Handler> = {}, items: Item[] = [runnerBody(), ...baseItems().filter((i) => i.id !== "plugin:acme/runner")]) {
  let current = items;
  const core = fakeCore({
    [`GET ${P}/installed`]: () => ok({ corrupt: false, items: current }),
    [`GET ${P}/active`]: () => reply("get-auth-me-extensions-active-200"),
    [`GET ${P}/catalog`]: () => reply("get-auth-me-extensions-catalog-200-2"),
    ...routes,
  });
  const model = new ExtensionsModel(createExtensionsApi(core));
  return { core, model, setItems: (n: Item[]) => (current = n), items: () => current };
}
const posts = (core: { calls: Call[] }, suffix: string) => core.calls.filter((c) => c.method === "POST" && c.path === `${P}/${suffix}`);
const runner = (m: ExtensionsModel) => m.item("plugin:acme/runner")!;

test("appearing reads only cached local lists: installed and active, no POST, no catalog", async () => {
  const { core, model } = setup();
  await model.init();
  assert.deepEqual(core.calls.map((c) => `${c.method} ${c.path}`).sort(), [`GET ${P}/active`, `GET ${P}/installed`]);
  assert.equal(model.getSnapshot().items.length, 3);
  assert.equal(model.getSnapshot().loaded, true);
});

test("Browse reads the cached catalog on first open; only Refresh is a POST to the network", async () => {
  const { core, model } = setup({ [`POST ${P}/catalog/refresh`]: () => reply("post-auth-me-extensions-catalog-refresh-200") });
  await model.init();
  await model.showTab("browse");
  assert.equal(core.calls.filter((c) => c.path.startsWith(`${P}/catalog`)).length, 1);
  assert.equal(core.calls.filter((c) => c.method === "POST").length, 0);
  await model.refreshCatalog();
  assert.equal(posts(core, "catalog/refresh").length, 1);
  assert.match(model.getSnapshot().notice!.text, /Refreshed 4 of 4 sources/);
  assert.equal(posts(core, "catalog/refresh")[0]!.opts.slow, true);
});

test("enabling an item with no executable kind needs no consent and sends no consents", async () => {
  const { core, model } = setup({ [`POST ${P}/toggle`]: () => reply("post-auth-me-extensions-toggle-200") });
  await model.init();
  await model.requestEnable(model.item("skill:acme/tidy")!);
  assert.equal(model.getSnapshot().sheet, null);
  assert.deepEqual(posts(core, "toggle")[0]!.body, { id: "skill:acme/tidy", enabled: true });
});

test("enabling an item that runs code opens the consent sheet and sends nothing until every kind is ticked", async () => {
  const { core, model } = setup({ [`POST ${P}/toggle`]: () => ok({ ok: true, item: { ...runnerBody(), state: { enabled: true, disabledMembers: [] } } }) });
  await model.init();
  await model.requestEnable(runner(model));
  const sheet = model.getSnapshot().sheet;
  assert.equal(sheet?.kind, "consent");
  assert.equal(posts(core, "toggle").length, 0);
  assert.equal(model.canConfirmConsent, false);
  await model.confirmConsent(); // Apply is disabled: refused
  assert.equal(posts(core, "toggle").length, 0);
  assert.equal(model.getSnapshot().sheet?.kind, "consent");
  model.tick("hook", true);
  assert.equal(model.canConfirmConsent, true);
  model.tick("hook", false);
  assert.equal(model.canConfirmConsent, false);
  model.tick("not-a-kind", true);
  assert.deepEqual((model.getSnapshot().sheet as { ticked: string[] }).ticked, []);
  model.tick("hook", true);
  await model.confirmConsent();
  assert.deepEqual(posts(core, "toggle")[0]!.body, { id: "plugin:acme/runner", enabled: true, consents: ["hook"] });
  assert.equal(runner(model).enabled, true);
  assert.equal(model.getSnapshot().sheet, null);
});

test("several kinds: all must be ticked and exactly those are sent", async () => {
  const { core, model } = setup({ [`POST ${P}/toggle`]: () => ok({ ok: true, item: runnerBody() }) }, [runnerBody({ declared: { executableKinds: ["bin", "hook", "mcp"] } })]);
  await model.init();
  await model.requestEnable(runner(model));
  model.tick("mcp", true);
  model.tick("hook", true);
  assert.equal(model.canConfirmConsent, false);
  model.tick("bin", true);
  await model.confirmConsent();
  assert.deepEqual((posts(core, "toggle")[0]!.body as { consents: string[] }).consents, ["hook", "mcp", "bin"]);
});

test("double tap on Apply sends one request", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const { core, model } = setup({ [`POST ${P}/toggle`]: () => gate.promise });
  await model.init();
  await model.requestEnable(runner(model));
  model.tick("hook", true);
  const a = model.confirmConsent();
  const b = model.confirmConsent();
  gate.resolve(ok({ ok: true, item: runnerBody() }));
  await Promise.all([a, b]);
  assert.equal(posts(core, "toggle").length, 1);
});

test("a consent is bound to the pinned commit: an item that moved under the sheet is not switched on", async () => {
  const { core, model, setItems } = setup({ [`POST ${P}/toggle`]: () => ok({ ok: true, item: runnerBody() }) });
  await model.init();
  await model.requestEnable(runner(model));
  model.tick("hook", true);
  setItems([runnerBody({ pinnedCommit: F })]);
  await model.loadInstalled();
  await model.confirmConsent();
  assert.equal(posts(core, "toggle").length, 0);
  assert.match(model.getSnapshot().notice!.text, /changed while you were deciding/);
});

test("CONSENT_REQUIRED from the core reloads the list and asks again with the real kinds", async () => {
  const { model, setItems } = setup({ [`POST ${P}/toggle`]: () => reply("post-auth-me-extensions-toggle-409") });
  setItems([runnerBody({ declared: { executableKinds: [] } })]);
  await model.init();
  setItems([runnerBody()]);
  await model.requestEnable(runner(model));
  assert.equal(model.getSnapshot().sheet?.kind, "consent");
  assert.match(model.getSnapshot().notice!.text, /Consent to each kind/);
});

test("busy: a second request for the same item says so instead of silently doing nothing", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const { model } = setup({ [`POST ${P}/toggle`]: () => gate.promise });
  await model.init();
  const t = model.item("skill:acme/tidy")!;
  const first = model.requestEnable(t);
  await tick();
  assert.deepEqual(model.getSnapshot().busy, ["skill:acme/tidy"]);
  await model.requestEnable(t);
  assert.equal(model.getSnapshot().notice?.text, "Busy, try again.");
  gate.resolve(reply("post-auth-me-extensions-toggle-200"));
  await first;
  assert.deepEqual(model.getSnapshot().busy, []);
});

test("members: unticking sends the member id and replaces the item", async () => {
  const { core, model } = setup({ [`POST ${P}/toggle`]: () => reply("post-auth-me-extensions-toggle-200-members") });
  await model.init();
  await model.setMember(runner(model), "skill:a", false);
  assert.deepEqual(posts(core, "toggle")[0]!.body, { id: "plugin:acme/runner", members: ["skill:a"], enabled: false });
});

// ---- update flow -----------------------------------------------------------------------------------
const withUpdate = (): Item[] => [runnerBody({ update: { latest: F, checkedAt: "2026-10-31T00:00:00Z" } })];
const previewReply = (over: Item = {}) => ok({ ...(fx("post-auth-me-extensions-update-preview-200").response as Item), ...over });
const appliedReply = () => reply("post-auth-me-extensions-update-200");

test("preview shows the diff and writes nothing; Apply needs consent when the candidate runs code, then sends the previewed commit and the ticked kinds", async () => {
  const { core, model } = setup({ [`POST ${P}/update/preview`]: () => previewReply(), [`POST ${P}/update`]: appliedReply }, withUpdate());
  await model.init();
  await model.openPreview(runner(model));
  assert.equal(model.getSnapshot().sheet?.kind, "preview");
  assert.deepEqual(posts(core, "update/preview")[0]!.body, { id: "plugin:acme/runner", commit: F });
  assert.equal(posts(core, "update").length, 0);
  await model.applyPreview();
  assert.equal(model.getSnapshot().sheet?.kind, "consent"); // a consent wins over the preview
  assert.equal(posts(core, "update").length, 0);
  model.tick("hook", true);
  await model.confirmConsent();
  assert.deepEqual(posts(core, "update")[0]!.body, { id: "plugin:acme/runner", commit: F, consents: ["hook"] });
  assert.match(model.getSnapshot().notice!.text, /Updated eeeeeeee to ffffffff\. It was switched off/);
  assert.equal(model.getSnapshot().sheet, null);
});

test("an update that needs no consent applies at once, by commit, without consents", async () => {
  const { core, model } = setup(
    { [`POST ${P}/update/preview`]: () => previewReply({ consent: { required: false, kinds: [] } }), [`POST ${P}/update`]: appliedReply },
    withUpdate(),
  );
  await model.init();
  await model.openPreview(runner(model));
  await model.applyPreview();
  assert.deepEqual(posts(core, "update")[0]!.body, { id: "plugin:acme/runner", commit: F });
});

test("UPDATE_CHANGED goes back to a fresh preview with 'That update changed; review it again'", async () => {
  let n = 0;
  const { core, model } = setup(
    {
      [`POST ${P}/update/preview`]: () => previewReply({ consent: { required: false, kinds: [] } }),
      [`POST ${P}/update`]: () => (++n === 1 ? err(409, "UPDATE_CHANGED") : appliedReply()),
    },
    withUpdate(),
  );
  await model.init();
  await model.openPreview(runner(model));
  await model.applyPreview();
  assert.equal(posts(core, "update/preview").length, 2);
  assert.equal(model.getSnapshot().sheet?.kind, "preview");
  assert.equal(model.getSnapshot().notice?.text, "That update changed; review it again.");
});

test("ALREADY_CURRENT on apply reloads the list and says up to date", async () => {
  const { core, model } = setup({ [`POST ${P}/update/preview`]: () => previewReply({ consent: { required: false, kinds: [] } }), [`POST ${P}/update`]: () => reply("post-auth-me-extensions-update-409") }, withUpdate());
  await model.init();
  const before = core.calls.filter((c) => c.path === `${P}/installed`).length;
  await model.openPreview(runner(model));
  await model.applyPreview();
  assert.equal(core.calls.filter((c) => c.path === `${P}/installed`).length, before + 1);
  assert.equal(model.getSnapshot().notice?.text, "Already up to date.");
  assert.equal(model.getSnapshot().sheet, null);
});

test("ALREADY_CURRENT on preview reloads the list", async () => {
  const { core, model } = setup({ [`POST ${P}/update/preview`]: () => reply("post-auth-me-extensions-update-preview-409") }, withUpdate());
  await model.init();
  const before = core.calls.filter((c) => c.path === `${P}/installed`).length;
  await model.openPreview(runner(model));
  assert.equal(core.calls.filter((c) => c.path === `${P}/installed`).length, before + 1);
  assert.equal(model.getSnapshot().sheet, null);
});

test("an item that moved while the preview was open is re-reviewed, never applied", async () => {
  const { core, model, setItems } = setup({ [`POST ${P}/update/preview`]: () => previewReply(), [`POST ${P}/update`]: appliedReply }, withUpdate());
  await model.init();
  await model.openPreview(runner(model));
  setItems([runnerBody({ pinnedCommit: "a".repeat(40), update: { latest: F, checkedAt: "x" } })]);
  await model.loadInstalled();
  await model.applyPreview();
  assert.equal(posts(core, "update").length, 0);
  assert.equal(posts(core, "update/preview").length, 2);
});

test("VERIFY_UNAVAILABLE on update offers a retry that resends the same commit and consents", async () => {
  let n = 0;
  const { core, model } = setup(
    {
      [`POST ${P}/update/preview`]: () => previewReply(),
      [`POST ${P}/update`]: () => (++n === 1 ? err(503, "VERIFY_UNAVAILABLE", { retryable: true }) : appliedReply()),
    },
    withUpdate(),
  );
  await model.init();
  await model.openPreview(runner(model));
  await model.applyPreview();
  model.tick("hook", true);
  await model.confirmConsent();
  const notice = model.getSnapshot().notice!;
  assert.match(notice.text, /Nothing was changed/);
  assert.ok(notice.retry);
  await model.retry();
  assert.equal(posts(core, "update").length, 2);
  assert.deepEqual(posts(core, "update")[1]!.body, posts(core, "update")[0]!.body);
});

test("non-retryable failures offer no retry button", async () => {
  const { model } = setup({ [`POST ${P}/update/preview`]: () => reply("post-auth-me-extensions-update-preview-422") }, withUpdate());
  await model.init();
  await model.openPreview(runner(model));
  assert.equal(model.getSnapshot().notice?.retry, null);
  assert.match(model.getSnapshot().notice!.text, /different item/);
});

test("only one sheet at a time: opening a second one is ignored", async () => {
  const { model } = setup({ [`POST ${P}/update/preview`]: () => previewReply() }, withUpdate());
  await model.init();
  await model.requestEnable(runner(model));
  model.requestUninstall(runner(model));
  assert.equal(model.getSnapshot().sheet?.kind, "consent");
  model.dismissSheet();
  await model.openPreview(runner(model));
  await model.requestEnable(runner(model));
  assert.equal(model.getSnapshot().sheet?.kind, "preview");
});

// ---- destructive actions ---------------------------------------------------------------------------
test("Remove, Rollback and Repair confirm first, naming the item and the commit; nothing is sent until confirmed", async () => {
  const withPrev = [runnerBody({ previous: { pinnedCommit: F, version: "0.9", installedAt: null } })];
  const { core, model } = setup(
    {
      [`POST ${P}/uninstall`]: () => reply("post-auth-me-extensions-uninstall-200"),
      [`POST ${P}/rollback`]: () => reply("post-auth-me-extensions-rollback-200"),
      [`POST ${P}/repair`]: () => reply("post-auth-me-extensions-repair-200"),
    },
    withPrev,
  );
  await model.init();
  model.requestUninstall(runner(model));
  let sh = model.getSnapshot().sheet as { kind: string; action: { kind: string; itemName: string; commit: string } };
  assert.deepEqual([sh.action.kind, sh.action.itemName, sh.action.commit], ["uninstall", "runner", E]);
  assert.equal(posts(core, "uninstall").length, 0);
  model.dismissSheet();
  model.requestRollback(runner(model));
  sh = model.getSnapshot().sheet as typeof sh;
  assert.equal((sh.action as unknown as { toCommit: string }).toCommit, F);
  model.dismissSheet();
  model.requestRepair(runner(model));
  assert.equal((model.getSnapshot().sheet as typeof sh).action.kind, "repair");
  await model.confirmAction();
  await model.confirmAction(); // second tap: no sheet
  assert.equal(posts(core, "repair").length, 1);
  assert.equal(posts(core, "uninstall").length + posts(core, "rollback").length, 0);
  model.requestUninstall(runner(model));
  await model.confirmAction();
  assert.equal(posts(core, "uninstall").length, 1);
  assert.equal(model.item("plugin:acme/runner"), undefined);
  assert.match(model.getSnapshot().notice!.text, /Removed runner/);
});

test("Rollback is offered only when there is a previous version", async () => {
  const { model } = setup();
  await model.init();
  model.requestRollback(runner(model));
  assert.equal(model.getSnapshot().sheet, null);
});

test("rollback and repair failures map to their codes", async () => {
  const withPrev = [runnerBody({ previous: { pinnedCommit: F, version: null, installedAt: null } })];
  const { model } = setup(
    { [`POST ${P}/rollback`]: () => reply("post-auth-me-extensions-rollback-409-gone"), [`POST ${P}/repair`]: () => reply("post-auth-me-extensions-repair-409-mismatch") },
    withPrev,
  );
  await model.init();
  model.requestRollback(runner(model));
  await model.confirmAction();
  assert.match(model.getSnapshot().notice!.text, /missing or damaged, so rollback is not possible/);
  model.requestRepair(runner(model));
  await model.confirmAction();
  assert.match(model.getSnapshot().notice!.text, /do not match the recorded fingerprint/);
  assert.equal(model.getSnapshot().notice?.error, true);
});

// ---- install ---------------------------------------------------------------------------------------
test("install validates locally first, then sends url (and folder) and starts OFF", async () => {
  const { core, model } = setup({ [`POST ${P}/install`]: () => reply("post-auth-me-extensions-install-200-3") });
  await model.init();
  model.setInstallUrl("http://evil.example/x");
  assert.equal(await model.install(), false);
  assert.ok(model.getSnapshot().install.fieldError);
  assert.equal(posts(core, "install").length, 0);
  model.setInstallUrl(" https://github.com/acme/runner ");
  model.setInstallPath("skills/x");
  assert.equal(await model.install(), true);
  assert.deepEqual(posts(core, "install")[0]!.body, { url: "https://github.com/acme/runner", path: "skills/x" });
  const last = model.getSnapshot().install.last!;
  assert.equal(last.item.enabled, false);
  assert.equal(last.item.pinnedCommit, E);
  assert.match(model.getSnapshot().notice!.text, /It is off until you switch it on/);
});

test("install in flight: a second click does nothing", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const { core, model } = setup({ [`POST ${P}/install`]: () => gate.promise });
  await model.init();
  model.setInstallUrl("https://github.com/acme/runner");
  const a = model.install();
  await tick();
  assert.equal(await model.install(), false);
  gate.resolve(reply("post-auth-me-extensions-install-200-3"));
  await a;
  assert.equal(posts(core, "install").length, 1);
});

test("install failures: not allowed, marketplace, already installed, commit not in repo", async () => {
  const cases: [string, RegExp][] = [
    ["post-auth-me-extensions-install-403", /Extension sources/],
    ["post-auth-me-extensions-install-422", /marketplace/],
    ["post-auth-me-extensions-install-409", /Use Update/],
    ["post-auth-me-extensions-install-404", /Not found/],
  ];
  for (const [name, re] of cases) {
    const { model } = setup({ [`POST ${P}/install`]: () => reply(name) });
    await model.init();
    model.setInstallUrl("https://github.com/acme/runner");
    assert.equal(await model.install(), false, name);
    assert.match(model.getSnapshot().notice!.text, re, name);
    assert.equal(model.getSnapshot().install.last, null);
  }
});

test("CATALOG_DISABLED sets the off banner flag", async () => {
  const { model } = setup({ [`POST ${P}/install`]: () => err(404, "CATALOG_DISABLED") });
  await model.init();
  model.setInstallUrl("https://github.com/acme/runner");
  await model.install();
  assert.equal(model.getSnapshot().catalogOff, true);
});

test("Browse install asks first; the tab changes only when the install succeeded", async () => {
  let fail = true;
  const { core, model } = setup({ [`POST ${P}/install`]: () => (fail ? err(403, "SOURCE_NOT_ALLOWED") : reply("post-auth-me-extensions-install-200-3")) });
  await model.init();
  await model.showTab("browse");
  const entry = model.getSnapshot().browse.results[0]!;
  model.requestBrowseInstall(entry);
  assert.equal(model.getSnapshot().sheet?.kind, "confirm");
  assert.equal(posts(core, "install").length, 0);
  await model.confirmAction();
  assert.equal(model.getSnapshot().tab, "browse"); // failed: stay put
  assert.deepEqual(posts(core, "install")[0]!.body, { url: "https://github.com/anthropics/skills", path: "skills/pdf" });
  fail = false;
  model.requestBrowseInstall(entry);
  await model.confirmAction();
  assert.equal(model.getSnapshot().tab, "install");
});

test("browse-only and installed entries cannot be installed", async () => {
  const { model } = setup();
  await model.init();
  await model.showTab("browse");
  const e = model.getSnapshot().browse.results[0]!;
  model.requestBrowseInstall({ ...e, installable: false });
  model.requestBrowseInstall({ ...e, installed: true });
  model.requestBrowseInstall({ ...e, sourceUrl: undefined });
  assert.equal(model.getSnapshot().sheet, null);
});

// ---- search ----------------------------------------------------------------------------------------
test("a superseded search never overwrites a newer one (sequence guard)", async () => {
  const slow = deferred<{ status: number; body: unknown }>();
  const page = (name: string) => ok({ ...(fx("get-auth-me-extensions-catalog-200-2").response as Item), results: [{ ...(fx("get-auth-me-extensions-catalog-200-2").response as { results: Item[] }).results[0], name }] });
  let n = 0;
  const { model } = setup({ [`GET ${P}/catalog`]: () => (++n === 1 ? slow.promise : page("newer")) });
  await model.init();
  model.setQuery("a");
  const first = model.search();
  model.setQuery("ab");
  await model.search();
  slow.resolve(page("older"));
  await first;
  assert.deepEqual(model.getSnapshot().browse.results.map((r) => r.name), ["newer"]);
  assert.equal(model.getSnapshot().browse.loading, false);
});

test("load more appends the next page, and is dropped when a new search started", async () => {
  const base = fx("get-auth-me-extensions-catalog-200-2").response as { results: Item[] };
  const mk = (from: number, n: number, total: number) => ok({ ...base, total, results: Array.from({ length: n }, (_, i) => ({ ...base.results[0], name: `e${from + i}` })) });
  const { core, model } = setup({ [`GET ${P}/catalog`]: (c) => (c.path.includes("offset=50") ? mk(50, 50, 120) : mk(0, 50, 120)) });
  await model.init();
  await model.showTab("browse");
  assert.equal(model.getSnapshot().browse.results.length, 50);
  await model.loadMore();
  assert.equal(model.getSnapshot().browse.results.length, 100);
  assert.ok(core.calls.some((c) => c.path.includes("offset=50")));
  // the request carries a bounded limit
  assert.ok(core.calls.every((c) => !c.path.includes("limit=") || /limit=(?:[1-9]|[1-9]\d|100)(?:&|$)/.test(c.path)));
});

test("a failing catalog read is a message, not a crash; the list keeps what it had", async () => {
  let fail = false;
  const { model } = setup({ [`GET ${P}/catalog`]: () => (fail ? err(400, "VALIDATION_FAILED") : reply("get-auth-me-extensions-catalog-200-2")) });
  await model.init();
  await model.showTab("browse");
  fail = true;
  await model.search();
  assert.ok(model.getSnapshot().browse.error);
  assert.equal(model.getSnapshot().browse.results.length, 1);
});

// ---- updates check, load errors, dispose -----------------------------------------------------------
test("checking for updates is a user action that reloads the list and summarises", async () => {
  const { core, model } = setup({ [`POST ${P}/updates/check`]: () => reply("post-auth-me-extensions-updates-check-200") });
  await model.init();
  await model.checkUpdates();
  assert.equal(posts(core, "updates/check").length, 1);
  assert.match(model.getSnapshot().notice!.text, /2 updates available\. 1 could not be checked\./);
});

test("an unreadable or corrupt installed record shows an error and keeps the list empty", async () => {
  const { model } = setup({ [`GET ${P}/installed`]: () => err(500, "STATE_UNREADABLE") });
  await model.init();
  assert.match(model.getSnapshot().loadError!, /could not be read, so nothing was changed/);
  assert.equal(model.getSnapshot().loaded, false);
});

test("a hostile answer is BAD_RESPONSE, not a half-typed list", async () => {
  const { model } = setup({ [`GET ${P}/installed`]: () => ok({ corrupt: false, items: [{ id: "x" }] }) });
  await model.init();
  assert.match(model.getSnapshot().loadError!, /does not understand/);
});

test("dispose aborts in-flight work and later answers change nothing", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  let seen: AbortSignal | undefined;
  const { model } = setup({ [`GET ${P}/installed`]: (c) => ((seen = c.opts.signal), gate.promise) });
  const p = model.init();
  await tick();
  model.dispose();
  assert.equal(seen?.aborted, true);
  gate.resolve(ok({ corrupt: false, items: baseItems() }));
  await p;
  assert.equal(model.getSnapshot().items.length, 0);
});
