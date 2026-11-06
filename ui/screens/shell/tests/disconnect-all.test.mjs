// "Sign out and disconnect all accounts": the Mac's third variant. Deletes only what is saved, one by one, in order,
// and signs out only when every delete worked. Values are never read: the status route gives names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load, React, renderToStaticMarkup, SHELL } from "./helpers.mjs";

const D = await load("disconnect-all.ts");
const A = await load("AccountMenu.tsx");
const h = React.createElement;
const REPO = join(SHELL, "../../..");
const SECRET = "secret value";

/** A scripted shell core: `routes["POST /auth/me/secrets"]` answers; records every call in order. */
function fakeCore(routes) {
  const calls = [];
  return {
    calls,
    async request(path, opts = {}) {
      const method = opts.method ?? "GET";
      calls.push({ method, path, body: opts.body });
      const h = routes[`${method} ${path}`];
      if (!h) throw Object.assign(new Error("no route"), { code: "NOT_FOUND" });
      return h(opts.body);
    },
  };
}
const ok = () => ({ ok: true });
const memStorage = (saved = {}) => {
  const m = new Map();
  if (saved.gitlab || saved.github) m.set("llmide.repos.config", JSON.stringify({ saved: { gitlab: saved.gitlab ?? [], github: saved.github ?? [] } }));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get raw() { return m.get("llmide.repos.config"); } };
};
const repo = (id) => ({ id, displayName: id, url: `https://x/${id}`, clonePath: "", active: false });

test("the plan names only the tokens that exist, in the Mac's order, and counts saved repositories", () => {
  const plan = D.planDisconnect(["gitlab.token", "claude.apiKey", "serpapi.apiKey"], 2);
  assert.deepEqual(plan.keys.map((k) => k.key), ["gitlab.token"]);
  assert.equal(D.describePlan(plan), "GitLab token, 2 saved repositories");
  assert.equal(D.describePlan(D.planDisconnect(["github.token", "gitlab.token"], 1)), "GitHub token, GitLab token, 1 saved repository");
  assert.equal(D.describePlan(D.planDisconnect([], 0)), "");
});

test("reading the plan uses the status names only, never a value", async () => {
  const core = fakeCore({
    "GET /auth/me/secrets": () => ({ secrets: [{ key: "github.token", updatedAt: "t", value: SECRET }, { key: "claude.apiKey", updatedAt: "t" }], available: [] }),
  });
  const plan = await D.readDisconnectPlan(core, memStorage({ github: [repo("a")] }));
  assert.deepEqual(plan.keys.map((k) => k.key), ["github.token"]);
  assert.equal(plan.savedRepos, 1);
  assert.ok(!JSON.stringify(plan).includes(SECRET));
});

test("disconnect deletes exactly the saved tokens in order (value null), clears the saved repositories, then signs out once", async () => {
  const core = fakeCore({ "POST /auth/me/secrets": ok });
  const storage = memStorage({ gitlab: [repo("g1"), repo("g2")] });
  const signOuts = [];
  const plan = D.planDisconnect(["gitlab.token", "github.token"], 2);
  const out = await D.disconnectAll(core, plan, async () => { signOuts.push(core.calls.length); }, { storage });
  assert.deepEqual(core.calls.map((c) => [c.method, c.path, c.body]), [
    ["POST", "/auth/me/secrets", { key: "github.token", value: null }],
    ["POST", "/auth/me/secrets", { key: "gitlab.token", value: null }],
  ]);
  assert.deepEqual(signOuts, [2], "sign-out only after both deletes");
  assert.deepEqual(out, { removed: ["github.token", "gitlab.token"], failed: [], reposCleared: true, signedOut: true });
  assert.deepEqual(JSON.parse(storage.raw).saved, { gitlab: [], github: [] });
});

test("one failed delete does not stop the others, but the sign-out is not performed and the repositories are kept", async () => {
  const core = fakeCore({
    "POST /auth/me/secrets": (body) => {
      if (body.key === "github.token") throw Object.assign(new Error("x"), { code: "VAULT_FAILED" });
      return ok();
    },
  });
  const storage = memStorage({ github: [repo("h1")] });
  let signedOut = false;
  const out = await D.disconnectAll(core, D.planDisconnect(["github.token", "gitlab.token"], 1), async () => { signedOut = true; }, { storage });
  assert.equal(core.calls.length, 2, "the second delete still ran");
  assert.equal(signedOut, false);
  assert.deepEqual(out.failed, [{ key: "github.token", label: "GitHub token", code: "VAULT_FAILED" }]);
  assert.deepEqual(out.removed, ["gitlab.token"]);
  assert.equal(out.signedOut, false);
  assert.equal(out.reposCleared, false);
  assert.equal(JSON.parse(storage.raw).saved.github.length, 1);
});

test("an untrusted core refuses the deletes: nothing is removed and the user stays signed in", async () => {
  const core = { async request() { throw Object.assign(new Error("untrusted"), { code: "UNTRUSTED_CORE" }); } };
  let signedOut = false;
  const out = await D.disconnectAll(core, D.planDisconnect(["gitlab.token"], 0), async () => { signedOut = true; }, { storage: memStorage() });
  assert.equal(signedOut, false);
  assert.equal(out.failed[0].code, "UNTRUSTED_CORE");
});

test("with nothing saved there are no deletes, and the sign-out still runs", async () => {
  const core = fakeCore({});
  let signedOut = false;
  const out = await D.disconnectAll(core, D.planDisconnect([], 0), async () => { signedOut = true; }, { storage: memStorage() });
  assert.equal(core.calls.length, 0);
  assert.equal(signedOut, true);
  assert.equal(out.signedOut, true);
});

test("a double click runs the disconnect once", async () => {
  let release;
  let runs = 0;
  const once = D.singleFlight(async () => {
    runs += 1;
    await new Promise((r) => { release = r; });
    return "done";
  });
  const first = once();
  const second = once();
  release();
  assert.equal(await first, "done");
  assert.equal(await second, "done");
  assert.equal(runs, 1);
  const later = once();
  release();
  assert.equal(await later, "done", "a later, deliberate run starts again");
  assert.equal(runs, 2);
});

test("the confirmation names what is removed and says it cannot be undone; Cancel comes first; the value is never shown", () => {
  const plan = D.planDisconnect(["github.token", "gitlab.token"], 3);
  const html = renderToStaticMarkup(h(A.DisconnectDialogView, { plan, busy: false, step: null, failed: [], onCancel: () => {}, onConfirm: () => {} }));
  assert.match(html, /GitHub token, GitLab token, 3 saved repositories/);
  assert.match(html, /cannot be undone/);
  assert.match(html, /paste the tokens again/);
  assert.ok(html.indexOf(">Cancel<") < html.indexOf(">Disconnect and sign out<"));
  assert.ok(!html.includes(SECRET));
});

test("with nothing saved the confirmation says so, and a failure names what is still there", () => {
  const empty = renderToStaticMarkup(h(A.DisconnectDialogView, { plan: D.planDisconnect([], 0), busy: false, step: null, failed: [], onCancel: () => {}, onConfirm: () => {} }));
  assert.match(empty, /No GitHub or GitLab token and no saved repositories/);
  const failed = renderToStaticMarkup(h(A.DisconnectDialogView, { plan: D.planDisconnect(["gitlab.token"], 0), busy: false, step: null, failed: [{ label: "GitHub token", code: "VAULT_FAILED" }], onCancel: () => {}, onConfirm: () => {} }));
  assert.match(failed, /Could not remove: GitHub token/);
  assert.match(failed, /still signed in/);
});

test("the sign-out dialog offers the third variant only when wired, and the two existing variants are unchanged", () => {
  const base = { busy: false, onCancel: () => {}, onConfirm: () => {} };
  const plain = renderToStaticMarkup(h(A.SignOutDialog, base));
  assert.ok(!plain.includes("disconnect all accounts"));
  assert.ok(plain.includes(">Sign out<"));
  const wired = renderToStaticMarkup(h(A.SignOutDialog, { ...base, onDisconnect: () => {} }));
  assert.match(wired, />Sign out and disconnect all accounts</);
  assert.ok(wired.indexOf(">Cancel<") < wired.indexOf(">Sign out and disconnect all accounts<"));
  assert.ok(wired.includes(A.DISCONNECT_NOTE) && !plain.includes(A.DISCONNECT_NOTE), "the Mac's note appears only with the option");
});

test("every key the disconnect wipes is in the core allowlist", () => {
  const vault = readFileSync(join(REPO, "extension/server/vault.mjs"), "utf8");
  for (const k of D.DISCONNECT_KEYS) assert.ok(vault.includes(`'${k.key}'`), `${k.key} is in the core allowlist`);
});

test("a failed delete whose error echoes a secret shows only a safe code", async () => {
  const core = { async request() { throw Object.assign(new Error(`vault said ${SECRET}`), { code: `bad ${SECRET}` }); } };
  const out = await D.disconnectAll(core, D.planDisconnect(["github.token"], 0), async () => {}, { storage: memStorage() });
  assert.equal(out.failed[0].code, "FAILED");
  const html = renderToStaticMarkup(h(A.DisconnectDialogView, { plan: null, busy: false, step: null, failed: out.failed, onCancel: () => {}, onConfirm: () => {} }));
  assert.ok(!html.includes(SECRET));
});

test("the saved repositories are cleared from storage even when the plan counted none (Mac always empties both lists)", async () => {
  const storage = memStorage({ gitlab: [repo("late")] });
  const out = await D.disconnectAll(fakeCore({}), D.planDisconnect([], 0), async () => {}, { storage });
  assert.equal(out.reposCleared, true);
  assert.deepEqual(JSON.parse(storage.raw).saved, { gitlab: [], github: [] });
});

test("a session that ends partway stops the run, names what is left, and does not claim the user is still signed in", async () => {
  const plan = { keys: [{ key: "github.token", label: "GitHub token" }, { key: "gitlab.token", label: "GitLab token" }], savedRepos: 1 };
  const client = {
    calls: [],
    async request(path, opts = {}) {
      this.calls.push(opts.body?.key);
      throw Object.assign(new Error("expired"), { code: "SESSION_EXPIRED" });
    },
  };
  let signedOut = 0;
  const out = await D.disconnectAll(client, plan, async () => { signedOut += 1; }, { storage: memStorage() });
  assert.equal(out.sessionLost, true);
  assert.equal(out.signedOut, false);
  assert.equal(signedOut, 0, "no sign-out call after the session is gone");
  assert.deepEqual(client.calls, ["github.token"], "no second delete is attempted once the session is lost");
  assert.deepEqual(out.failed.map((f) => f.key), ["github.token", "gitlab.token"], "the untried one is listed as left");
  assert.equal(out.reposCleared, false);
});

test("an ordinary failure still tries the next secret and keeps the user signed in", async () => {
  const plan = { keys: [{ key: "github.token", label: "GitHub token" }, { key: "gitlab.token", label: "GitLab token" }], savedRepos: 0 };
  const seen = [];
  const client = {
    async request(path, opts = {}) {
      seen.push(opts.body?.key);
      if (opts.body?.key === "github.token") throw Object.assign(new Error("boom"), { code: "SERVER_ERROR" });
      return { ok: true };
    },
  };
  const out = await D.disconnectAll(client, plan, async () => { throw new Error("must not sign out"); }, { storage: memStorage() });
  assert.deepEqual(seen, ["github.token", "gitlab.token"]);
  assert.equal(out.sessionLost, undefined);
  assert.equal(out.signedOut, false);
});
