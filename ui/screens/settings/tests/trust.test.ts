import { test } from "node:test";
import assert from "node:assert/strict";
import { AllowlistModel, RELOAD_FIRST, TRUST_CONSENT, TrustListModel, ceilingText, normalizeSource } from "../trust-model.ts";
import { deferred, fakeClient, fixture, reply } from "./helpers.ts";

test("normalizeSource: owner/repo and owner/*, lowercased; pasted URLs reduce to the same entry", () => {
  assert.equal(normalizeSource("Acme/Tools"), "acme/tools");
  assert.equal(normalizeSource("  acme/*  "), "acme/*");
  assert.equal(normalizeSource("https://github.com/Acme/Tools"), "acme/tools");
  assert.equal(normalizeSource("http://github.com/acme/tools.git"), "acme/tools");
  assert.equal(normalizeSource("github.com/acme/tools/"), "acme/tools");
  assert.equal(normalizeSource("https://github.com/acme/tools.git/"), "acme/tools");
  for (const bad of ["", "acme", "not a repo", "*/*", "*/x", "a/b/c", "acme/ tools", "acme/t!ools", "/x"]) assert.equal(normalizeSource(bad), null, bad);
});

test("ceiling wording covers no limit, empty limit and a list", () => {
  assert.match(ceilingText(null), /no limit/);
  assert.match(ceilingText([]), /no additions/);
  assert.match(ceilingText(["acme/*"]), /acme\/\*/);
});

const allowClient = (extra: Record<string, () => { status: number; body: unknown }> = {}) =>
  fakeClient({
    "GET /auth/me/extensions/allowlist": () => reply("extensions/get-auth-me-extensions-allowlist-200.json"),
    "PUT /auth/me/extensions/allowlist": (b) => ({ status: 200, body: { ...(fixture("extensions/put-auth-me-extensions-allowlist-200.json").response as object), user: (b as { sources: string[] }).sources } }),
    ...extra,
  });

test("allowlist: edits are refused until the list has loaded ('Reload first')", async () => {
  const client = allowClient();
  const m = new AllowlistModel(client);
  m.setDraft("acme/tools");
  assert.equal(m.canAdd, false);
  await m.addDraft();
  assert.equal(m.getState().error, RELOAD_FIRST);
  await m.remove("x/y");
  assert.equal(m.getState().error, RELOAD_FIRST);
  assert.equal(client.calls.filter((c) => c.method === "PUT").length, 0);
});

test("allowlist: add saves the whole list (normalised), clears the draft; duplicates and bad entries stay local", async () => {
  const client = allowClient();
  const m = new AllowlistModel(client);
  await m.load();
  m.setDraft("https://github.com/Acme/Tools.git");
  assert.equal(m.canAdd, true);
  await m.addDraft();
  assert.deepEqual(client.calls.find((c) => c.method === "PUT")!.body, { sources: ["acme/tools"] });
  assert.equal(m.getState().draft, "");
  m.setDraft("acme/tools");
  await m.addDraft();
  assert.match(m.getState().error!, /already in your list/);
  m.setDraft("not a repo");
  await m.addDraft();
  assert.match(m.getState().error!, /"not a repo" is not a valid source/);
  assert.equal(client.calls.filter((c) => c.method === "PUT").length, 1);
});

test("allowlist: a server refusal is mapped (ceiling / invalid / validation) and the saved list is untouched", async () => {
  for (const [rel, re] of [
    ["extensions/put-auth-me-extensions-allowlist-403.json", /wider than the operator allows/],
    ["extensions/put-auth-me-extensions-allowlist-400.json", /not a valid source/],
    ["extensions/put-auth-me-extensions-allowlist-400-validation.json", /did not accept/],
  ] as const) {
    const client = allowClient({ "PUT /auth/me/extensions/allowlist": () => reply(rel) });
    const m = new AllowlistModel(client);
    await m.load();
    m.setDraft("foo/bar");
    await m.addDraft();
    assert.match(m.getState().error!, re, rel);
    assert.deepEqual(m.getState().allowlist!.user, []);
  }
});

test("allowlist: ignored entries and the ceiling come through", async () => {
  const m = new AllowlistModel(allowClient({ "GET /auth/me/extensions/allowlist": () => reply("extensions/get-auth-me-extensions-allowlist-200-2.json") }));
  await m.load();
  assert.deepEqual(m.getState().allowlist!.ignored, ["evil/x"]);
  assert.deepEqual(m.getState().allowlist!.ceiling, ["acme/*"]);
});

test("allowlist: stale load guard (load started, save completes, load answers late)", async () => {
  const lateLoad = deferred<{ status: number; body: unknown }>();
  let calls = 0;
  const client = allowClient({ "GET /auth/me/extensions/allowlist": () => (calls++ === 0 ? reply("extensions/get-auth-me-extensions-allowlist-200.json") : (lateLoad.promise as never)) });
  const m = new AllowlistModel(client);
  await m.load();
  const reload = m.load();
  m.setDraft("foo/bar");
  await m.addDraft();
  assert.deepEqual(m.getState().allowlist!.user, ["foo/bar"]);
  lateLoad.resolve(reply("extensions/get-auth-me-extensions-allowlist-200.json"));
  await reload;
  assert.deepEqual(m.getState().allowlist!.user, ["foo/bar"], "late answer did not undo the save");
});

const trustClient = () =>
  fakeClient({
    "GET /auth/me/workspace-trust": () => reply("extensions/get-auth-me-workspace-trust-200-2.json"),
    "PUT /auth/me/workspace-trust": (b) => ({ status: 200, body: { ok: true, item: { path: (b as { path: string }).path, trusted: (b as { trusted: boolean }).trusted, updatedAt: "2026-10-31T10:00:00.000Z" } } }),
  });

test("trust list: trusting goes through the consent naming the folder; untrusting is immediate", async () => {
  const client = trustClient();
  const m = new TrustListModel(client);
  await m.load();
  const other = m.getState().items.find((i) => !i.trusted)!;
  await m.requestChange(other, true);
  assert.equal(client.calls.filter((c) => c.method === "PUT").length, 0, "nothing sent before consent");
  assert.match(TRUST_CONSENT(m.getState().pendingTrust!.path), /Trust \/Users\/dev\/other\?/);
  assert.match(TRUST_CONSENT("/x"), /runs a program on this computer/);
  await m.confirmPendingTrust();
  assert.deepEqual(client.calls.find((c) => c.method === "PUT")!.body, { path: other.path, trusted: true });
  assert.equal(m.getState().items.find((i) => i.path === other.path)!.trusted, true);
  const trusted = m.getState().items.find((i) => i.path === "/Users/dev/project")!;
  await m.requestChange(trusted, false);
  assert.equal(m.getState().items.find((i) => i.path === trusted.path)!.trusted, false);
});

test("trust list: cancel sends nothing; an added folder also needs consent; broad folder refusal is a sentence", async () => {
  const client = fakeClient({
    "GET /auth/me/workspace-trust": () => reply("extensions/get-auth-me-workspace-trust-200.json"),
    "PUT /auth/me/workspace-trust": () => reply("extensions/put-auth-me-workspace-trust-400-broad.json"),
  });
  const m = new TrustListModel(client);
  await m.load();
  m.addFolder("/");
  assert.equal(m.getState().pendingTrust!.path, "/");
  m.cancelPending();
  assert.equal(client.calls.filter((c) => c.method === "PUT").length, 0);
  m.addFolder("/");
  await m.confirmPendingTrust();
  assert.match(m.getState().error!, /too broad/);
  assert.equal(m.getState().items.length, 0);
});

test("trust list: a load that started before an apply cannot overwrite it", async () => {
  const late = deferred<{ status: number; body: unknown }>();
  let n = 0;
  const client = fakeClient({
    "GET /auth/me/workspace-trust": () => (n++ === 0 ? reply("extensions/get-auth-me-workspace-trust-200-2.json") : (late.promise as never)),
    "PUT /auth/me/workspace-trust": (b) => ({ status: 200, body: { ok: true, item: { path: (b as { path: string }).path, trusted: false, updatedAt: "t" } } }),
  });
  const m = new TrustListModel(client);
  await m.load();
  const reload = m.load();
  await m.requestChange(m.getState().items[0]!, false);
  late.resolve(reply("extensions/get-auth-me-workspace-trust-200-2.json"));
  await reload;
  assert.equal(m.getState().items[0]!.trusted, false, "the stale list did not bring the old value back");
});
