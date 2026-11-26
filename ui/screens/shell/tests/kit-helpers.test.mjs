import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecord } from "../../../kit/src/decode.ts";
import { entryNameProblem } from "../../../kit/src/entry-name.ts";
import { hostErrorCode, hostErrorText } from "../../../kit/src/host-error.ts";
import { baseName, joinAbs, joinRel, lastSegment, nativeBaseName, parentOf } from "../../../kit/src/paths.ts";

test("isRecord: plain objects only", () => {
  assert.equal(isRecord({}), true);
  for (const v of [null, undefined, [], "x", 0, true]) assert.equal(isRecord(v), false);
});

test("joinRel and joinAbs differ on purpose", () => {
  assert.equal(joinRel("", "a"), "a");
  assert.equal(joinRel("d", "a"), "d/a");
  assert.equal(joinAbs("/", "a"), "/a");
  assert.equal(joinAbs("/home/u", "a"), "/home/u/a");
});

test("path segments", () => {
  assert.equal(parentOf("a/b/c"), "a/b");
  assert.equal(parentOf("a"), "");
  assert.equal(baseName("a/b/c"), "c");
  assert.equal(baseName("a/b/"), "");
  assert.equal(nativeBaseName("C:\\Users\\me\\proj\\"), "proj");
  assert.equal(lastSegment("/a/b/"), "b");
  assert.equal(lastSegment("C:\\a\\b"), "b");
  assert.equal(lastSegment("a\\b", "posix"), "a\\b");
  assert.equal(lastSegment("/"), "/");
});

test("entryNameProblem: reasons in report order", () => {
  assert.equal(entryNameProblem("  "), "empty");
  assert.equal(entryNameProblem(" .. "), "dot");
  assert.equal(entryNameProblem("a/b"), "separator");
  assert.equal(entryNameProblem("a\\b"), null);
  assert.equal(entryNameProblem("a\\b", { refuseBackslash: true }), "separator");
  assert.equal(entryNameProblem("a\0b"), "null");
  assert.equal(entryNameProblem("a\nb"), "line_break");
  assert.equal(entryNameProblem("a\u2028b"), "line_break");
  assert.equal(entryNameProblem(" ok "), null);
});

test("hostErrorText: table entry, host message, fallback", () => {
  const table = { known: "Fixed.", echo: (m) => (m ? `Host: ${m}` : "none") };
  assert.equal(hostErrorCode({ code: "known" }), "known");
  assert.equal(hostErrorCode(new Error("x")), "");
  assert.equal(hostErrorText({ code: "known", message: "m" }, table, "fb"), "Fixed.");
  assert.equal(hostErrorText({ code: "echo", message: " m " }, table, "fb"), "Host: m");
  assert.equal(hostErrorText({ code: "other", message: "said" }, table, "fb"), "said");
  assert.equal(hostErrorText(new Error("boom"), table, "fb"), "boom");
  assert.equal(hostErrorText({ code: "other" }, table, "fb"), "fb");
  assert.equal(hostErrorText({ code: "toString" }, table, "fb"), "fb");
  assert.equal(hostErrorText({ message: "x".repeat(400) }, table, "fb").length, 300);
});
