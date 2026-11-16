// The shared host error reader: a string, an Error and the SSH { code, message } object all give their message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { hostErrorText, hostErrorCode } = await load("host-error.ts");

test("hostErrorText: string, Error and { message } give the message; anything else gives empty", () => {
  assert.equal(hostErrorText("  boom  "), "boom");
  assert.equal(hostErrorText(new Error("bang")), "bang");
  assert.equal(hostErrorText({ code: "x", message: "from the host" }), "from the host");
  assert.equal(hostErrorText({ code: "x" }), "");
  assert.equal(hostErrorText(null), "");
  assert.equal(hostErrorText(42), "");
});

test("hostErrorCode: only a string code on an object", () => {
  assert.equal(hostErrorCode({ code: "no_project", message: "n" }), "no_project");
  assert.equal(hostErrorCode("no_project"), "");
  assert.equal(hostErrorCode(new Error("x")), "");
});
