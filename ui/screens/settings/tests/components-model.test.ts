import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOG_POLL_MS,
  LOG_TEXT,
  MAX_LOG_CHARS,
  componentError,
  componentStateLabel,
  decodeComponentStatus,
  decodeCoreLog,
  decodeRtkStatus,
  shortPath,
  singleFlight,
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

test("rtk status: installed/version/canInstall, with a strict shape", () => {
  assert.deepEqual(decodeRtkStatus({ installed: true, version: "rtk 0.4.2", canInstall: true }), { installed: true, version: "rtk 0.4.2", canInstall: true });
  assert.deepEqual(decodeRtkStatus({ installed: false, version: null, canInstall: false }), { installed: false, version: null, canInstall: false });
  assert.equal(decodeRtkStatus({ installed: true, version: 4, canInstall: true }), null);
  assert.equal(decodeRtkStatus({ installed: true, version: null, canInstall: "yes" }), null);
  assert.equal(decodeRtkStatus({ installed: true, version: "x".repeat(200), canInstall: true }), null);
  assert.equal(decodeRtkStatus(null), null);
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

test("Backend log: the auto-scroll label and the poll interval", () => {
  assert.equal(LOG_TEXT.autoScroll, "Auto-scroll");
  assert.equal(LOG_POLL_MS, 2000);
});

test("Backend log poll: a tick during a slow read is dropped, so reads never overlap", async () => {
  let reads = 0;
  let release: () => void = () => undefined;
  let active = 0;
  let maxActive = 0;
  // A fake read that takes longer than the 2 s poll: it settles only when the test releases it.
  const slowRead = () => {
    reads += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve) => {
      release = () => {
        active -= 1;
        resolve();
      };
    });
  };
  const tick = singleFlight(slowRead);
  tick(); // poll 1 starts a read
  tick(); // poll 2 (2 s later, read still running): dropped
  tick(); // poll 3: dropped
  assert.equal(reads, 1, "no second read while the first is in flight");
  release();
  await new Promise((r) => setTimeout(r, 0));
  tick(); // poll 4 after the read settled: runs again
  assert.equal(reads, 2, "polling resumes once the read has finished");
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(maxActive, 1, "never more than one read in flight");
});

test("Backend log poll: a failed read still frees the slot for the next tick", async () => {
  let reads = 0;
  const tick = singleFlight(() => {
    reads += 1;
    return Promise.reject(new Error("host read failed"));
  });
  // The read handles its own errors in ServerSection; this checks the slot is released even if one escapes.
  tick();
  await new Promise((r) => setTimeout(r, 0));
  tick();
  assert.equal(reads, 2);
});

test("Backend log poll: a read that never settles frees the slot after the timeout, and its late settle frees nothing", async () => {
  let reads = 0;
  const settles: Array<() => void> = [];
  const tick = singleFlight(() => {
    reads += 1;
    return new Promise<void>((r) => settles.push(r));
  }, 20);
  tick(); // read 1 hangs
  tick();
  assert.equal(reads, 1, "still single-flight before the timeout");
  await new Promise((r) => setTimeout(r, 40));
  tick(); // read 2 after the timeout
  assert.equal(reads, 2, "a stuck read does not stop the poll for good");
  settles[0](); // read 1 finally lands while read 2 holds the slot
  await new Promise((r) => setTimeout(r, 0));
  tick();
  assert.equal(reads, 2, "the stale read's settle must not free read 2's slot");
  settles[1]();
  await new Promise((r) => setTimeout(r, 0));
  tick();
  assert.equal(reads, 3);
});

test("Backend log poll: ServerSection reads the log only through the single-flight poll", () => {
  const src = readFileSync(new URL("../sections/ServerSection.tsx", import.meta.url), "utf8");
  assert.match(src, /const loadLog = useMemo\([\s\S]*?singleFlight\(/, "loadLog is wrapped in singleFlight");
  assert.match(src, /setInterval\(loadLog, LOG_POLL_MS\)/, "the poll drives the guarded reader");
  assert.match(src, /clearInterval\(id\)/, "the poll stops on unmount");
});

test("a ready but unhealthy core offers Kill & Restart, not a no-op Start", () => {
  const src = readFileSync(new URL("../sections/ServerSection.tsx", import.meta.url), "utf8");
  assert.match(src, /!info \|\| info\.coreState === "stopped" \|\| info\.coreState === "failed" \?/);
  assert.match(src, /tone=\{!health \? "primary" : undefined\}/);
  assert.match(src, /The backend is not answering/);
});
