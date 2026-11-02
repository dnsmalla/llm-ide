// Mac parity: the Library's fixed date buckets (LibraryViewModel.DateGroup) and the bucket rows.
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHead, buildRows, NO_FILTERS, recordFromEntry, relativeGroup, type NoteRecord } from "../notes-model.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

test("relative groups follow the Mac buckets: today, yesterday, 7 days, 1 month, earlier", () => {
  assert.equal(relativeGroup(Date.parse("2026-10-31T01:00:00Z"), NOW), "Today");
  assert.equal(relativeGroup(Date.parse("2026-10-30T23:59:00Z"), NOW), "Yesterday");
  assert.equal(relativeGroup(NOW - 3 * DAY, NOW), "This Week");
  assert.equal(relativeGroup(NOW - 20 * DAY, NOW), "This Month");
  assert.equal(relativeGroup(NOW - 60 * DAY, NOW), "Earlier");
});

test("a month back clamps to the previous month's last day, like Calendar.date(byAdding: .month)", () => {
  // Mac: Mar 31 - 1 month = Feb 28 (2027), so Mar 1 and Feb 28 15:00 are both "This Month".
  const mar31 = Date.parse("2027-03-31T12:00:00Z");
  assert.equal(relativeGroup(Date.parse("2027-03-01T12:00:00Z"), mar31), "This Month");
  assert.equal(relativeGroup(Date.parse("2027-02-28T15:00:00Z"), mar31), "This Month");
  assert.equal(relativeGroup(Date.parse("2027-02-28T09:00:00Z"), mar31), "Earlier");
  // Week boundary is exclusive at exactly 7 days (date > weekAgo).
  assert.equal(relativeGroup(NOW - 7 * DAY, NOW), "This Month");
  assert.equal(relativeGroup(NOW - 7 * DAY + 1, NOW), "This Week");
});

test("relative rows: fixed bucket order with counts, empty buckets omitted, sort ignored for order", () => {
  const mk = (rel: string, ms: number): NoteRecord => ({ ...applyHead(recordFromEntry({ rel, size: 1, mtimeMs: ms, placeholder: false }), "---\nplatform: meet\n---\n"), dateMs: ms });
  const recs = [mk("old.md", NOW - 90 * DAY), mk("today-a.md", NOW - 1000), mk("week.md", NOW - 2 * DAY), mk("today-b.md", NOW - 5000)];
  const rows = buildRows(recs, { sectionId: "meeting", filters: NO_FILTERS, sort: "date-asc", group: "relative", now: NOW });
  assert.deepEqual(
    rows.map((r) => (r.kind === "header" ? `# ${r.label} (${r.count})` : r.rec.rel)),
    ["# Today (2)", "today-b.md", "today-a.md", "# This Week (1)", "week.md", "# Earlier (1)", "old.md"],
  );
});

test("the store defaults to the Mac's relative grouping when no preference is saved", async () => {
  const { LibraryStore } = await import("../library-store.ts");
  const { FakeHost } = await import("./fake-host.ts");
  const store = new LibraryStore({ host: new FakeHost(), now: () => NOW });
  assert.equal(store.getSnapshot().group, "relative");
});
