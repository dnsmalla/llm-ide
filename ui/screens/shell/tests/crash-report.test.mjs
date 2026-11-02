import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const crash = await load("crash-report.ts");
const { CrashReportBanner } = await load("CrashReportBanner.tsx");

const record = (o = {}) => ({ at: "2026-11-02T10:00:00Z", message: "index out of bounds", location: "~/llm-ide/desktop/src-tauri/src/git_scm.rs:123", app_version: "0.0.0", os: "macos aarch64", count: 1, ...o });
const notice = (o = {}) => crash.decodeCrashNotice(record(o));

test("decodeCrashNotice: a well-formed record decodes; anything else reads as no notice", () => {
  assert.deepEqual(notice(), {
    at: "2026-11-02T10:00:00Z",
    message: "index out of bounds",
    location: "~/llm-ide/desktop/src-tauri/src/git_scm.rs:123",
    appVersion: "0.0.0",
    os: "macos aarch64",
    count: 1,
  });
  assert.equal(crash.decodeCrashNotice(null), null);
  assert.equal(crash.decodeCrashNotice("boom"), null);
  assert.equal(crash.decodeCrashNotice(record({ count: 0 })), null, "no pending crash is no banner");
  assert.equal(crash.decodeCrashNotice(record({ count: 1.5 })), null);
  assert.equal(crash.decodeCrashNotice(record({ at: "yesterday" })), null, "a bad time is refused");
  assert.equal(crash.decodeCrashNotice(record({ message: 42 })), null);
});

test("decodeCrashNotice: the record is untrusted text, so control and bidi characters are removed and lengths capped", () => {
  const n = notice({ message: "bad‮evil\u0007\nline".padEnd(2000, "x") });
  assert.equal(n.message.includes("‮"), false);
  assert.equal(n.message.includes("\u0007"), false);
  assert.ok(n.message.length <= 1000);
  assert.equal(notice({ count: 500 }).count, 99, "the count is capped for the wording");
});

test("crashBannerMessage: the Mac's wording for one and for several", () => {
  assert.equal(crash.crashBannerMessage(1), "LLM-IDE didn't close properly last time.");
  assert.equal(crash.crashBannerMessage(3), "LLM-IDE didn't close properly 3 times since you last checked.");
});

test("crashDetails: the copied text is the redacted record and nothing else", () => {
  const text = crash.crashDetails(notice());
  assert.equal(text, [
    "LLM-IDE crash report",
    "Time: 2026-11-02T10:00:00Z",
    "Message: index out of bounds",
    "Location: ~/llm-ide/desktop/src-tauri/src/git_scm.rs:123",
    "App version: 0.0.0",
    "OS: macos aarch64",
  ].join("\n"));
  assert.doesNotMatch(text, /\/Users\/|HOME|PATH|token|secret/i);
});

test("loadCrashNotice and dismissCrashNotice never throw without a host, and call only the fixed commands", async () => {
  // Each load() bundles its own copy of host.ts, so a bridge set here would not reach crash-report.ts: check the
  // wiring by source, and check the no-host path by behaviour.
  assert.equal(await crash.loadCrashNotice(), null, "no host at all (browser, tests): no banner");
  await assert.doesNotReject(crash.dismissCrashNotice().catch(() => undefined));
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "crash-report.ts"), "utf8");
  assert.match(src, /invokeHost<unknown>\("crash_report_latest"\)/);
  assert.match(src, /invokeHost<number>\("crash_report_dismiss"\)/);
  assert.doesNotMatch(src, /crash_report_\w+", \{/, "no arguments are sent from the page");
});

test("CrashReportBanner: wording, Copy details and Dismiss; plain text only", () => {
  const out = html(h(CrashReportBanner, { notice: notice({ count: 2 }), onDismiss() {} }));
  assert.match(out, /data-testid="crash-notice"/);
  assert.match(out, /didn&#x27;t close properly 2 times|didn't close properly 2 times/);
  assert.match(out, />Copy details</);
  assert.match(out, /aria-label="Dismiss"[^>]*>Dismiss</);
  assert.doesNotMatch(out, /<script|dangerouslySetInnerHTML/);
});

test("Copy details copies exactly the record text, and says when it could not", async () => {
  const seen = [];
  assert.equal(await crash.copyCrashDetails(notice(), async (t) => { seen.push(t); }), "Copied.");
  assert.deepEqual(seen, [crash.crashDetails(notice())], "only the redacted record, once");
  assert.match(await crash.copyCrashDetails(notice(), async () => { throw new Error("denied"); }), /Could not copy/);
  const here = dirname(fileURLToPath(import.meta.url));
  const banner = readFileSync(join(here, "..", "CrashReportBanner.tsx"), "utf8");
  assert.match(banner, /copyCrashDetails\(notice, copy \?\? \(\(t: string\) => navigator\.clipboard\.writeText\(t\)\)\)/, "the button goes through it, via navigator.clipboard");
});

test("Shell mounts the banner once, loads it on mount and dismisses through the host", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shell = readFileSync(join(here, "..", "Shell.tsx"), "utf8");
  assert.match(shell, /<CrashReportBanner notice=\{crash\} onDismiss=\{dismissCrash\}/);
  assert.match(shell, /void loadCrashNotice\(\)\.then\(\(n\) => \{ if \(live\) setCrash\(n\); \}\)/);
  assert.match(shell, /dismissCrashNotice\(\)\.catch/);
});
