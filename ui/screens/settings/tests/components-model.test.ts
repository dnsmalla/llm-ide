import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LOG_CHARS,
  componentError,
  componentStateLabel,
  decodeComponentStatus,
  decodeCoreLog,
  shortPath,
  sizeLabel,
} from "../components-model.ts";

const status = { installed: true, version: "11.17.2", sizeBytes: 40_053, host: "cdn.jsdelivr.net" };

test("component status: only a well-shaped answer from the host is accepted", () => {
  assert.deepEqual(decodeComponentStatus(status), status);
  assert.deepEqual(decodeComponentStatus({ ...status, installed: false }), { ...status, installed: false });
  for (const bad of [
    null,
    undefined,
    "x",
    {},
    { ...status, installed: "yes" },
    { ...status, version: 3 },
    { ...status, version: "x".repeat(41) },
    { ...status, host: undefined },
    { ...status, sizeBytes: -1 },
    { ...status, sizeBytes: Number.NaN },
    { ...status, sizeBytes: 1e12 },
    { ...status, sizeBytes: "big" },
  ]) {
    assert.equal(decodeComponentStatus(bad), null, JSON.stringify(bad));
  }
});

test("component status: a fractional size is rounded, not trusted verbatim", () => {
  assert.equal(decodeComponentStatus({ ...status, sizeBytes: 10.7 })?.sizeBytes, 11);
});

test("core log: decodes, drops NULs and keeps only a bounded tail", () => {
  assert.deepEqual(decodeCoreLog({ path: "/d/core/server.log", text: "a\nb\n", exists: true }), { path: "/d/core/server.log", text: "a\nb\n", exists: true });
  const huge = "x".repeat(MAX_LOG_CHARS + 500) + "TAIL";
  const got = decodeCoreLog({ path: "/d/server.log", text: huge, exists: true });
  assert.equal(got?.text.length, MAX_LOG_CHARS);
  assert.ok(got?.text.endsWith("TAIL"), "the newest bytes survive");
  assert.equal(decodeCoreLog({ path: "/d/server.log", text: "a\u0000b", exists: true })?.text, "ab");
  assert.deepEqual(decodeCoreLog({ path: "", text: "", exists: false }), { path: "", text: "", exists: false });
  for (const bad of [null, {}, { path: 1, text: "", exists: true }, { path: "/x", text: "", exists: "no" }, { path: "x".repeat(4097), text: "", exists: true }]) {
    assert.equal(decodeCoreLog(bad), null, JSON.stringify(bad));
  }
});

test("labels: sizes, state and the short path for the log header", () => {
  assert.equal(sizeLabel(0), "0 B");
  assert.equal(sizeLabel(512), "512 B");
  assert.equal(sizeLabel(40_053), "39 KB");
  assert.equal(sizeLabel(1_258_291), "1.2 MB");
  assert.equal(sizeLabel(Number.NaN), "0 B");
  assert.equal(componentStateLabel(null), "Not installed");
  assert.equal(componentStateLabel({ ...status, installed: false }), "Not installed");
  assert.equal(componentStateLabel(status), "Installed");
  assert.equal(shortPath("/Users/a/Library/Application Support/llm-ide-desktop/core/server.log"), "…/core/server.log");
  assert.equal(shortPath("/x"), "/x");
});

test("component errors: host codes become plain sentences; a raw string is kept but capped", () => {
  assert.match(componentError({ code: "busy" }), /already running/);
  assert.match(componentError({ code: "integrity" }), /checksum/);
  assert.match(componentError({ code: "rate_limited" }), /Too many/);
  assert.match(componentError({ code: "io" }), /data folder/);
  assert.equal(componentError("plain failure"), "plain failure");
  assert.equal(componentError("x".repeat(500)).length, 200);
  assert.equal(componentError(new Error("boom")), "boom");
  assert.equal(componentError({}), "The action failed.");
});
