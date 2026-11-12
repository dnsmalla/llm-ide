import { test } from "node:test";
import assert from "node:assert/strict";
import { issueTarget, safeTestCommand, stageCommentBody, verdictLine } from "../issue-comments.ts";

const issue = { key: "issue:7", source: "issue", id: "7", title: "Fix login", body: "", repo: "grid-devs/personal/dinesh/smart-input", provider: "gitlab" };

test("only an imported issue with a provider, repo and number is commented on", () => {
  assert.deepEqual(issueTarget(issue), { provider: "gitlab", repo: "grid-devs/personal/dinesh/smart-input", number: 7 });
  assert.equal(issueTarget({ ...issue, source: "spec" }), null);
  assert.equal(issueTarget({ ...issue, provider: null }), null);
  assert.equal(issueTarget({ ...issue, repo: null }), null);
  assert.equal(issueTarget({ ...issue, id: "abc" }), null);
  assert.equal(issueTarget({ ...issue, id: "0" }), null);
});

test("verdictLine keeps only the one Verdict line of a report", () => {
  assert.equal(verdictLine("# Review\n\nLots of prose\n\nVerdict: approve\nmore"), "approve");
  assert.equal(verdictLine("verdict:  request changes  "), "request changes");
  assert.equal(verdictLine("no verdict here"), null);
  assert.equal(verdictLine(`Verdict: ${"x".repeat(500)}`).length, 120);
  assert.equal(verdictLine("Verdict: approve‮ evil"), "approve evil", "bidi controls are dropped");
});

test("a stage comment carries facts only: step, result, run, and the role's own fact", () => {
  const base = { stageName: "Implement", role: "implement", ok: true, runId: "20261112-r1", mode: "full", iteration: 1 };
  const impl = stageCommentBody({ ...base, changedFiles: ["src/a.ts", "src/b.ts"] });
  assert.match(impl, /^\*\*Factory · `Implement`\*\* — passed/);
  assert.match(impl, /Run `20261112-r1` \(full\)/);
  assert.match(impl, /Changed files \(2\): `src\/a\.ts`, `src\/b\.ts`/);
  const many = stageCommentBody({ ...base, changedFiles: Array.from({ length: 30 }, (_, i) => `f${i}.ts`) });
  assert.match(many, /Changed files \(30\):.*… and 10 more/);
  const verify = stageCommentBody({ ...base, stageName: "Verify", role: "verify", ok: false, testCommand: "npm test" });
  assert.match(verify, /\*\*Factory · `Verify`\*\* — failed/);
  assert.match(verify, /Test command: `npm test`/);
  const review = stageCommentBody({ ...base, stageName: "Review", role: "review", verdict: "request changes" });
  assert.match(review, /Review verdict: `request changes`/);
  assert.match(stageCommentBody({ ...base, iteration: 3 }), /attempt 3/);
  assert.doesNotMatch(stageCommentBody({ ...base, iteration: 1 }), /attempt/);
});

test("untrusted names cannot break out of their code span or add markdown", () => {
  const body = stageCommentBody({ stageName: "Implement", role: "implement", ok: true, runId: "r1", mode: "full", iteration: 1, changedFiles: ["a`b.ts", "@everyone.md"], testCommand: null });
  assert.doesNotMatch(body, /a`b/);
  assert.match(body, /`a'b\.ts`/);
  assert.match(body, /`@everyone\.md`/, "a mention inside a code span does not notify");
});

test("a test command is shown only when it cannot carry a secret", () => {
  assert.equal(safeTestCommand("npm test"), "npm test");
  assert.equal(safeTestCommand("cargo test --lib"), "cargo test --lib");
  for (const leaky of ["DATABASE_URL=postgres://u:pw@db npm test", "TOKEN=abc pytest", "pytest --api-key=abc", "curl https://u:p@host/run", "API=$SECRET npm test", "npm test ${TOKEN}"]) {
    assert.equal(safeTestCommand(leaky), null, leaky);
  }
  assert.equal(safeTestCommand(null), null);
  const body = stageCommentBody({ stageName: "Verify", role: "verify", ok: true, runId: "r1", mode: "full", iteration: 1, testCommand: "TOKEN=abc pytest" });
  assert.doesNotMatch(body, /abc|Test command/);
});

test("a renamed stage or a crafted verdict cannot mention people or render links", () => {
  const body = stageCommentBody({ stageName: "@team review", role: "review", ok: true, runId: "r1", mode: "full", iteration: 1, verdict: "approve ![](https://tracker/p.png) @owner" });
  assert.match(body, /`@team review`/);
  assert.match(body, /verdict: `approve !\[\]\(https:\/\/tracker\/p\.png\) @owner`/);
});
