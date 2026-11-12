import { test } from "node:test";
import assert from "node:assert/strict";
import { autoShipRun } from "../auto-ship.ts";
import { decodeRepoConfig, defaultRepoConfig } from "../../settings/repo-config.ts";

const info = { runId: "r1", project: "/p", repo: "/p/code/smart-input", worktree: "/p/system/loop-worktrees/r1", branch: "factory/r1", baseCommit: "0123456789abcdef0123" };
const item = { source: "issue", id: "2", title: "Make buttons more colorful", body: "", repo: "grid-devs/personal/dinesh/smart-input", provider: "gitlab" };
const config = decodeRepoConfig({ saved: { gitlab: [{ id: "g", url: "https://gitlab.com/grid-devs/personal/dinesh/smart-input", clonePath: "/p/code/smart-input", active: true }] } });
const entry = { id: "e1", startedAt: "2026-11-12T10:00:00.000Z" };
const diff = (over = {}) => ({ text: "+x", truncated: false, patchId: "a".repeat(64), files: ["src/button.css"], additions: 1, deletions: 0, ...over });

function world(over = {}) {
  const w = { shipped: [], saved: [], blocked: [], comments: [] };
  w.d = {
    repoConfig: () => config,
    diff: async () => diff(),
    repoBranch: async () => "dev",
    readText: async (p) => (p.endsWith("REVIEW.md") ? "Fine.\nVerdict: approve\n" : null),
    ship: async (body) => { w.shipped.push(body); return { ok: true, url: "https://gitlab.com/grid-devs/personal/dinesh/smart-input/-/merge_requests/9", commit: "abc1234", reused: false }; },
    saveShip: async (e, s) => { w.saved.push({ e, s }); return true; },
    saveBlocked: async (e, reason) => { w.blocked.push({ e, reason }); return true; },
    comment: async (text) => { w.comments.push(text); },
    now: () => new Date("2026-11-12T10:05:00.000Z"),
    ...over,
  };
  return w;
}
const ctx = (over = {}) => ({ info, item, entry, kind: "passed", failedStage: null, runPrefix: "system/loop-worktrees/r1", ...over });

test("a passed run opens its draft MR against the branch it was cut from, records it and tells the issue", async () => {
  const w = world();
  const out = await autoShipRun(w.d, ctx());
  assert.deepEqual(out, { shipped: "https://gitlab.com/grid-devs/personal/dinesh/smart-input/-/merge_requests/9" });
  assert.equal(w.shipped.length, 1);
  assert.deepEqual({ repo: w.shipped[0].repo, base: w.shipped[0].base, provider: w.shipped[0].provider, title: w.shipped[0].title, patchId: w.shipped[0].patchId }, { repo: "grid-devs/personal/dinesh/smart-input", base: "dev", provider: "gitlab", title: "Make buttons more colorful", patchId: "a".repeat(64) });
  assert.match(w.shipped[0].body, /^Refs #2$/m);
  assert.equal(w.saved[0].s.url, out.shipped);
  assert.match(w.comments[0], /Factory · `Ship`\*\* — draft MR opened/);
  assert.match(w.comments[0], /merge_requests\/9/);
});

test("a failed run ships too, labelled in the title and first line of the description", async () => {
  const w = world();
  await autoShipRun(w.d, ctx({ kind: "testsFailing", failedStage: "Verify" }));
  assert.equal(w.shipped[0].title, "[Tests failing] Make buttons more colorful");
  assert.match(w.shipped[0].body, /^> \*\*The Factory's tests failed \(Verify\)\.\*\*/);
});

test("with no checked-out branch the MR targets main", async () => {
  const w = world({ repoBranch: async () => null });
  await autoShipRun(w.d, ctx());
  assert.equal(w.shipped[0].base, "main");
});

test("an unsafe or impossible ship stops for a person with the reason recorded and posted, and never calls the server", async () => {
  const cases = [
    [{ repoConfig: () => defaultRepoConfig() }, /not in Settings → Repositories/],
    [{ repoConfig: () => ({ ...config, operations: { ...config.operations, gitlab: ["sync"] } }) }, /Push and Create PR/],
    [{ diff: async () => diff({ files: [] }) }, /changed nothing/],
    [{ diff: async () => diff({ files: [".gitlab-ci.yml"] }) }, /CI or hook files/],
    [{ diff: async () => { throw new Error("gone"); } }, /could not be read/],
  ];
  for (const [over, why] of cases) {
    const w = world(over);
    const out = await autoShipRun(w.d, ctx());
    assert.match(out.blocked, why);
    assert.equal(w.shipped.length, 0);
    assert.match(w.blocked[0].reason, why);
    assert.match(w.comments[0], /— not shipped/);
  }
});

test("a server refusal (secret found, push rejected) is recorded without echoing the server's text", async () => {
  const w = world({ ship: async () => ({ ok: false, code: "secret_detected", message: "+ token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'", rule: "GitHub token" }) });
  const out = await autoShipRun(w.d, ctx());
  assert.match(out.blocked, /secret/i);
  assert.doesNotMatch(out.blocked + w.comments.join(""), /ghp_/);
  assert.equal(w.saved.length, 0);
});
