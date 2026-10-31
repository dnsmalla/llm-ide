import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNote } from "../frontmatter.ts";
import { parseMeetingBody, parseTranscript, speakerCounts } from "../meeting.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("the Mac fixture's transcript parses into speakers and times", () => {
  const text = readFileSync(join(REPO, "mac/Tests/LlmIdeMacTests/Fixtures/lta/meeting-with-platform.md"), "utf8");
  const m = parseMeetingBody(parseNote(text).body);
  assert.equal(m.hasTranscript, true);
  assert.deepEqual(m.transcript, [{ time: "10:00:01", speaker: "Alice", text: "we should raise the budget" }]);
  assert.equal(m.summaryMarkdown, "");
});

test("summary section is split from the transcript and the list sections are pulled out", () => {
  const body = [
    "", "A short summary paragraph.", "", "### Detail", "More text.", "",
    "## Actions", "- [ ] **Alice** — send the deck (due Friday)", "- [x] done thing", "- plain", "",
    "## Decisions", "- Ship it", "", "## Blockers", "- None yet", "",
    "## Transcript", "", "[10:00:01] **Alice**: hello", "continued line", "[10:00:09] **Bob B**: hi: there", "",
  ].join("\n");
  const m = parseMeetingBody(body);
  assert.equal(m.summaryMarkdown, "A short summary paragraph.\n\n### Detail\nMore text.");
  assert.deepEqual(m.actions, [
    { text: "**Alice** — send the deck (due Friday)", done: false },
    { text: "done thing", done: true },
    { text: "plain", done: null },
  ]);
  assert.deepEqual(m.decisions, [{ text: "Ship it", done: null }]);
  assert.deepEqual(m.blockers, [{ text: "None yet", done: null }]);
  assert.deepEqual(m.transcript, [
    { time: "10:00:01", speaker: "Alice", text: "hello\ncontinued line" },
    { time: "10:00:09", speaker: "Bob B", text: "hi: there" },
  ]);
  assert.deepEqual(speakerCounts(m.transcript), [{ speaker: "Alice", count: 1 }, { speaker: "Bob B", count: 1 }]);
});

test("template variants: Action items and To-dos headings; no transcript heading", () => {
  const m = parseMeetingBody("Intro\n\n## Action items\n- a\n\n## To-dos\n- b\n\n## Notes\n- kept in the summary\n");
  assert.equal(m.hasTranscript, false);
  assert.deepEqual(m.actions.map((a) => a.text), ["a", "b"]);
  assert.match(m.summaryMarkdown, /## Notes\n- kept in the summary/);
});

test("a heading inside a code fence is not a section; CRLF is handled; junk lines before any caption survive", () => {
  const m = parseMeetingBody("```\n## Actions\n- not an action\n```\r\n\r\n## Transcript\r\nstray\r\n[1:02] **A**: x");
  assert.equal(m.actions.length, 0);
  assert.match(m.summaryMarkdown, /## Actions/);
  assert.deepEqual(m.transcript, [{ time: null, speaker: null, text: "stray" }, { time: "1:02", speaker: "A", text: "x" }]);
  assert.deepEqual(parseTranscript(""), []);
});

test("a 100k-line transcript parses quickly", () => {
  const lines = Array.from({ length: 100_000 }, (_, i) => `[10:${String(i % 60).padStart(2, "0")}:00] **S${i % 5}**: line ${i}`).join("\n");
  const t0 = performance.now();
  const t = parseTranscript(lines);
  assert.equal(t.length, 100_000);
  assert.ok(performance.now() - t0 < 1500);
});
