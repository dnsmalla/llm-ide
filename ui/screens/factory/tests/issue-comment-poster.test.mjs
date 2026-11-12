import { test } from "node:test";
import assert from "node:assert/strict";
import { postStageComment } from "../issue-comment-poster.ts";
import { FACTORY_TEMPLATE } from "../../loop/native/factory.ts";

const stage = (name) => FACTORY_TEMPLATE.config.stages.find((s) => s.name === name);
const item = { source: "issue", id: "2", repo: "grid-devs/personal/dinesh/smart-input", provider: "gitlab" };

function deps(over = {}) {
  const posted = [];
  return {
    posted,
    d: {
      request: async (path, body) => { posted.push({ path, body }); return { status: 201, body: {} }; },
      diffFiles: async () => ["src/button.css"],
      readText: async (path) => (path.endsWith("REVIEW.md") ? "Looks fine.\nVerdict: approve\n" : null),
      allowed: () => true,
      ...over,
    },
  };
}

test("each finished step posts one facts-only comment on its issue", async () => {
  const { posted, d } = deps();
  const ev = { item, runId: "r1", mode: "full", ok: true, iteration: 1, runPrefix: "code/smart-input/.wt/r1" };
  assert.equal(await postStageComment(d, { ...ev, stage: stage("Implement") }), true);
  assert.equal(await postStageComment(d, { ...ev, stage: stage("Review") }), true);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].path, "/kb/issues/comment");
  assert.deepEqual({ ...posted[0].body, body: undefined }, { provider: "gitlab", repo: item.repo, number: 2, body: undefined });
  assert.match(posted[0].body.body, /Factory · `Implement`\*\* — passed[\s\S]*`src\/button\.css`/);
  assert.match(posted[1].body.body, /Review verdict: `approve`/);
  assert.doesNotMatch(posted[1].body.body, /Looks fine/, "the report's prose never reaches the issue");
});

test("nothing is posted for setup, a non-issue item, or when commenting is not allowed in Settings", async () => {
  const ev = { item, runId: "r1", mode: "full", ok: true, iteration: 1, runPrefix: "p" };
  const a = deps();
  assert.equal(await postStageComment(a.d, { ...ev, stage: stage("Set up") }), false);
  assert.equal(await postStageComment(a.d, { ...ev, stage: stage("Review gate") }), false, "a gate only restates the Review verdict");
  const b = deps();
  assert.equal(await postStageComment(b.d, { ...ev, item: { ...item, source: "text" }, stage: stage("Implement") }), false);
  const c = deps({ allowed: () => false });
  assert.equal(await postStageComment(c.d, { ...ev, stage: stage("Implement") }), false);
  assert.equal(a.posted.length + b.posted.length + c.posted.length, 0);
});

test("a failed post or a failing fact lookup never throws into the run", async () => {
  const { d } = deps({ request: async () => { throw new Error("offline"); }, diffFiles: async () => { throw new Error("gone"); } });
  assert.equal(await postStageComment(d, { item, runId: "r1", mode: "full", ok: false, iteration: 2, runPrefix: "p", stage: stage("Implement") }), false);
  const { d: d2 } = deps({ request: async () => ({ status: 403, body: { error: { code: "REPO_NOT_ALLOWED" } } }) });
  assert.equal(await postStageComment(d2, { item, runId: "r1", mode: "full", ok: true, iteration: 1, runPrefix: "p", stage: stage("Verify") }), false);
});
