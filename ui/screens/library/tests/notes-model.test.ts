process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyHead, areaOf, buildRows, classify, countBySection, dateFromPath, filtersActive, formatDate, formatDuration, matchesFilters, monthKey, NO_FILTERS,
  recordFromEntry, rowIndexOf, sectionLabel, sectionsFor, stepNoteRow, titleFromName, UNSORTED, type NoteRecord,
} from "../notes-model.ts";

const entry = (rel: string, mtimeMs = Date.UTC(2026, 9, 31), placeholder = false) => ({ rel, size: 100, mtimeMs, placeholder });
const head = (lines: string[]) => `---\n${lines.join("\n")}\n---\n\nbody`;

test("path facts: area, type dir, title, date", () => {
  assert.deepEqual(areaOf("source/meetings/2026/10/a.md"), { area: "source", typeDir: "meetings" });
  assert.deepEqual(areaOf("llm-doc/emails/x.md"), { area: "llm-doc", typeDir: "emails" });
  assert.deepEqual(areaOf("llm-doc/x.md"), { area: "llm-doc", typeDir: "" });
  assert.deepEqual(areaOf("2026/10/x.md"), { area: "other", typeDir: "" });
  assert.equal(titleFromName("2026-05-28-standup-1a2b3c4d.md"), "standup");
  assert.equal(titleFromName("2026-05-28-1030-weekly_sync.md"), "weekly sync");
  assert.equal(titleFromName("2026-05-28.md"), "2026-05-28");
  assert.equal(titleFromName("notes.txt"), "notes");
  assert.equal(formatDate(dateFromPath("source/meetings/2026/10/2026-10-05-a.md")!), "2026-10-05");
  assert.equal(formatDate(dateFromPath("source/meetings/2026/09/a.md")!), "2026-09-01");
  assert.equal(dateFromPath("a/b.md"), null);
  assert.equal(dateFromPath("2026-13-40-x.md"), null);
});

test("classification mirrors the Mac: platform, then raw dir, then meeting default; no platform is Unsorted (Q19)", () => {
  const meet = applyHead(recordFromEntry(entry("source/meetings/2026/10/m.md")), head(["title: A", "platform: zoom"]));
  assert.equal(meet.sourceId, "meeting");
  const slack = applyHead(recordFromEntry(entry("source/meetings/2026/10/s.md")), head(["title: S", "platform: slack"]));
  assert.equal(slack.sourceId, "slack", "meetings/ is shared: explicit platform beats the directory");
  const mail = applyHead(recordFromEntry(entry("source/emails/e.md")), head(["title: E", "platform: email"]));
  assert.equal(mail.sourceId, "email");
  const weird = applyHead(recordFromEntry(entry("a/b.md")), head(["title: W", "platform: chrome-extension"]));
  assert.equal(weird.sourceId, "meeting", "unknown platform keeps the historical meeting default");
  const unknownInDir = applyHead(recordFromEntry(entry("source/emails/e2.md")), head(["title: W", "platform: weirdo"]));
  assert.equal(unknownInDir.sourceId, "email", "unknown platform in an owned raw dir follows the dir");
  const noPlatform = applyHead(recordFromEntry(entry("2026/10/x.md")), head(["title: X", "language: en"]));
  assert.equal(noPlatform.sourceId, UNSORTED);
  assert.equal(recordFromEntry(entry("2026/10/x.md")).sourceId, UNSORTED, "before the head is read");
  assert.equal(recordFromEntry(entry("source/emails/raw.txt")).sourceId, "email", "raw dir classifies even without frontmatter");
  assert.equal(recordFromEntry(entry("source/miro/board.md")).sourceId, "dir:miro");
  assert.equal(recordFromEntry(entry("source/documents/d.md")).sourceId, UNSORTED);
  assert.equal(recordFromEntry(entry("llm-doc/emails/n.md")).sourceId, "doc:emails");
  assert.equal(applyHead(recordFromEntry(entry("llm-doc/emails/n.md")), head(["platform: meet"])).sourceId, "doc:emails", "llm-doc is grouped by type dir, not source");
});

test("head facts: title, date, participants, platform, gist, duration; heading and path fallbacks", () => {
  const r = applyHead(
    recordFromEntry(entry("source/meetings/2026/10/2026-10-05-x-1a2b3c4d.md")),
    head(["id: m1", "title: Budget review", "started_at: '2026-10-05T10:00:00Z'", "duration_seconds: 1800", "participants: [Alice, Bob]", "platform: Meet", "gist: Raise the budget"]),
  );
  assert.equal(r.title, "Budget review");
  assert.equal(r.titleFromPath, false);
  assert.equal(r.dateMs, Date.parse("2026-10-05T10:00:00Z"));
  assert.deepEqual(r.participants, ["Alice", "Bob"]);
  assert.equal(r.platform, "meet");
  assert.equal(r.gist, "Raise the budget");
  assert.equal(r.durationSec, 1800);
  assert.equal(formatDuration(r.durationSec), "30m");
  assert.equal(formatDuration(3700), "1h 1m");
  assert.equal(formatDuration(0), null);
  const h = applyHead(recordFromEntry(entry("a/x.md")), "# The Heading\n\ntext");
  assert.equal(h.title, "The Heading");
  assert.equal(h.hasFrontmatter, false);
  const p = recordFromEntry(entry("a/2026-10-05-plain-name.md"));
  assert.equal(p.title, "plain name");
  assert.equal(p.titleFromPath, true);
  assert.equal(applyHead(p, "no heading here").title, "plain name");
});

test("hostile frontmatter cannot inject into the record shape", () => {
  const r = applyHead(recordFromEntry(entry("a.md")), head(["title: '<img src=x onerror=alert(1)>'", "__proto__: polluted", "participants: [\"<script>\"]"]));
  assert.equal(r.title, "<img src=x onerror=alert(1)>"); // data, rendered as text by the UI
  assert.equal(({} as { polluted?: string }).polluted, undefined);
});

test("sections: three built-ins always, Unsorted only when present, doc types sorted, counts", () => {
  const recs: NoteRecord[] = [
    recordFromEntry(entry("llm-doc/emails/a.md")),
    recordFromEntry(entry("llm-doc/meetings/b.md")),
    recordFromEntry(entry("source/miro/c.md")),
    recordFromEntry(entry("x.md")),
  ];
  const counts = countBySection(recs);
  assert.equal(counts.get("doc:emails"), 1);
  const ids = sectionsFor(counts).map((s) => s.id);
  assert.deepEqual(ids, ["meeting", "email", "slack", "dir:miro", UNSORTED, "doc:emails", "doc:meetings"]);
  assert.deepEqual(sectionsFor(new Map()).map((s) => s.id), ["meeting", "email", "slack"]);
  assert.equal(sectionLabel("dir:miro"), "Miro");
  assert.equal(sectionLabel("doc:"), "General");
  assert.equal(sectionLabel("doc:meeting-notes"), "Meeting notes");
});

test("filters: query terms (AND), platform, summary, range", () => {
  const a = applyHead(recordFromEntry(entry("m/a.md")), head(["title: Budget review", "platform: meet", "gist: raise it", "participants: [Alice]", "started_at: '2026-10-30T10:00:00Z'"]));
  const b = applyHead(recordFromEntry(entry("m/b.md")), head(["title: Standup", "platform: zoom", "started_at: '2025-01-01T10:00:00Z'"]));
  const now = Date.parse("2026-10-31T00:00:00Z");
  const f = (p: Partial<typeof NO_FILTERS>) => ({ ...NO_FILTERS, ...p });
  assert.equal(matchesFilters(a, f({ query: "budget alice" }), now), true);
  assert.equal(matchesFilters(a, f({ query: "budget bob" }), now), false);
  assert.equal(matchesFilters(a, f({ query: "m/a" }), now), true, "path is searchable");
  assert.equal(matchesFilters(b, f({ platform: "meet" }), now), false);
  assert.equal(matchesFilters(a, f({ hasSummary: true }), now), true);
  assert.equal(matchesFilters(b, f({ hasSummary: true }), now), false);
  assert.equal(matchesFilters(a, f({ range: "7d" }), now), true);
  assert.equal(matchesFilters(b, f({ range: "year" }), now), false);
  assert.equal(filtersActive(NO_FILTERS), false);
  assert.equal(filtersActive(f({ query: " " })), false);
  assert.equal(filtersActive(f({ hasSummary: true })), true);
});

test("rows: filter by section, sort, group by month with counts; headers are skipped by stepping", () => {
  const mk = (rel: string, started: string, platform = "meet") => applyHead(recordFromEntry(entry(rel)), head([`title: ${rel}`, `started_at: '${started}'`, `platform: ${platform}`]));
  const recs = [mk("a.md", "2026-10-02T10:00:00Z"), mk("b.md", "2026-10-20T10:00:00Z"), mk("c.md", "2026-09-05T10:00:00Z"), mk("s.md", "2026-10-21T10:00:00Z", "slack")];
  const rows = buildRows(recs, { sectionId: "meeting", filters: NO_FILTERS, sort: "date-desc", group: "month", now: Date.now() });
  assert.deepEqual(
    rows.map((r) => (r.kind === "header" ? `# ${r.label} (${r.count})` : r.rec.rel)),
    ["# 2026-10 (2)", "b.md", "a.md", "# 2026-09 (1)", "c.md"],
  );
  assert.equal(monthKey(Date.parse("2026-10-31T23:59:59Z")), "2026-10");
  assert.equal(rowIndexOf(rows, "a.md"), 2);
  assert.equal(stepNoteRow(rows, 1, 1), 2);
  assert.equal(stepNoteRow(rows, 2, 1), 4, "skips the header");
  assert.equal(stepNoteRow(rows, 4, 1), 4, "stays at the end");
  assert.equal(stepNoteRow(rows, 1, -1), 1, "stays at the start");
  assert.equal(stepNoteRow(rows, -1, 1), 1, "no selection: first note");
  assert.equal(stepNoteRow([], -1, 1), -1);
  const flat = buildRows(recs, { sectionId: null, filters: NO_FILTERS, sort: "title", group: "none", now: Date.now() });
  assert.deepEqual(flat.map((r) => (r.kind === "note" ? r.rec.rel : "")), ["a.md", "b.md", "c.md", "s.md"]);
  const byFolder = buildRows([mk("x/a.md", "2026-10-02T10:00:00Z"), mk("y/b.md", "2026-10-01T10:00:00Z")], { sectionId: null, filters: NO_FILTERS, sort: "path", group: "folder", now: Date.now() });
  assert.equal(byFolder.filter((r) => r.kind === "header").length, 2);
});

test("classify is a pure function of the record", () => {
  const r = recordFromEntry(entry("source/meetings/a.md"));
  assert.equal(classify(r), "meeting");
});
