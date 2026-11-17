import { test } from "node:test";
import assert from "node:assert/strict";
import * as lb from "../native/loopback.ts";
import { runStatusCode } from "../native/runner.ts";

const st = (id, over = {}) => ({ id, name: id, kind: "shellCommand", order: 0, enabled: true, severity: "blocking", allowsRepair: true, runOnce: false, skillId: null, ...over });
const sk = (id, skillId, over = {}) => st(id, { kind: "skill", skillId, ...over });
const ids = (list) => list.map((s) => s.id);

test("loopbackGroups: Factory shape", () => {
  const groups = lb.loopbackGroups([
    st("setup", { runOnce: true }), sk("plan", "skills/writing-plans"), sk("impl", "skills/test-driven-development"),
    st("sv"), st("v"), sk("tg", "skills/test-gap-writer", { severity: "advisory" }), sk("dr", "skills/doc-writer"),
    sk("rv", "skills/factory-review"), st("gate", { kind: "artifactCheck" }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0].codeStages), ["impl"]);
  assert.deepEqual(groups[0].verifyIds, ["sv", "v"]);
  assert.equal(groups[0].closerId, "v");
});

test("loopbackGroups: Refactoring shape", () => {
  const groups = lb.loopbackGroups([
    sk("tw", "skills/test-gap-writer"), st("tb"), sk("apply", "skills/refactor-apply"), sk("conform", "skills/refactor-conform"),
    st("t"), st("ledger", { kind: "testMap" }),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(ids(groups[0].codeStages), ["tw"]);
  assert.equal(groups[0].closerId, "tb");
  assert.deepEqual(ids(groups[1].codeStages), ["apply", "conform"]);
  assert.equal(groups[1].closerId, "t");
});

test("loopbackGroups: not verifies", () => {
  const code = sk("impl", "skills/test-driven-development");
  assert.equal(lb.loopbackGroups([code, st("a", { severity: "advisory" })]).length, 0);
  assert.equal(lb.loopbackGroups([code, st("o", { runOnce: true })]).length, 0);
  assert.equal(lb.loopbackGroups([code, st("g", { kind: "artifactCheck" })]).length, 0);
  assert.equal(lb.isCodeWritingStage(sk("x", "skills/test-driven-development", { reviewAfter: false })), false);
  assert.equal(lb.isCodeWritingStage(st("s", { reviewAfter: true })), false);
  assert.equal(lb.loopbackGroups([sk("x", "skills/test-driven-development", { reviewAfter: false }), st("v")]).length, 0);
});

test("groupOfVerify / groupOfCode", () => {
  const groups = lb.loopbackGroups([sk("plan", "skills/writing-plans"), sk("impl", "skills/test-driven-development"), st("sv"), st("v")]);
  assert.equal(lb.groupOfVerify(groups, "sv"), groups[0]);
  assert.equal(lb.groupOfVerify(groups, "v"), groups[0]);
  assert.equal(lb.groupOfCode(groups, "impl"), groups[0]);
  assert.equal(lb.groupOfCode(groups, "plan"), null);
  assert.equal(lb.groupOfVerify(groups, "plan"), null);
});

test("findingsText", () => {
  const entries = [{ round: 1, source: "tests", text: "boom" }, { round: 2, source: "review", text: "fix x" }];
  assert.equal(lb.findingsText(entries), "Round 1 (tests)\nboom\n\nRound 2 (review)\nfix x");
  const cut = lb.findingsText(entries, 30);
  assert.ok(cut.startsWith("…") && cut.endsWith("fix x") && cut.length <= 30);
});

test("stoppedSummary and failureSignature", () => {
  assert.equal(lb.stoppedSummary(3, "tests"), "Stopped after 3 rounds: tests still failing");
  assert.equal(lb.stoppedSummary(1, "review"), "Stopped after 1 round: review still requests changes");
  assert.equal(lb.stoppedSummary(2, "tests", true), "Stopped after 2 rounds: tests still failing (no change since the previous round)");
  assert.equal(lb.failureSignature("tests", "  boom "), "tests:boom");
  assert.equal(lb.failureSignature("tests", "ran 3 in 12ms at 10:41:07"), lb.failureSignature("tests", "ran 4 in 15ms at 10:42:09"));
  assert.equal(lb.failureSignature("review", "a".repeat(5000)), "review:" + "a".repeat(2000));
});

test("loopbackRecord and loopbackLogLine", () => {
  assert.deepEqual(lb.loopbackRecord(undefined), {});
  const rec = lb.loopbackRecord({ rounds: 3, maxRounds: 3, reason: "tests", findings: "x".repeat(5000), stopped: true });
  assert.equal(rec.loopback.findings.length, 4000);
  assert.match(lb.loopbackLogLine({ rounds: 3, maxRounds: 3, reason: "tests", findings: "", stopped: true }), /3 of 3/);
});

test("runStatusCode with stoppedAtLimit", () => {
  assert.equal(runStatusCode({ passed: false, stoppedAtLimit: true }), "stopped.limit");
  assert.equal(runStatusCode({ passed: false, stoppedAtLimit: true, cancelled: true }), "aborted");
  assert.equal(runStatusCode({ passed: false, stoppedAtLimit: true, awaitingReview: true }), "awaiting_review");
  assert.equal(runStatusCode({ passed: false }), "failed");
});
