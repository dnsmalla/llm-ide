import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../tests/helpers.mjs";
import { entry } from "./fakes.mjs";

const m = await load("scm/model.ts");

test("grouping: staged/changes/untracked/conflicts, an entry can be in two groups, sorted by path", () => {
  const g = m.buildGroups([
    entry("b.txt", "M", "M"),
    entry("a.txt", ".", "M"),
    entry("c.txt", "A", "."),
    entry("z.txt", ".", "?", "untracked"),
    entry("x.txt", "U", "U", "unmerged"),
    entry("new.txt", "R", ".", "renamed", { orig_path: "old.txt" }),
  ]);
  assert.deepEqual(g.staged.map((i) => i.entry.path), ["b.txt", "c.txt", "new.txt"]);
  assert.deepEqual(g.changes.map((i) => i.entry.path), ["a.txt", "b.txt"]);
  assert.deepEqual(g.untracked.map((i) => i.entry.path), ["z.txt"]);
  assert.deepEqual(g.conflicts.map((i) => i.entry.path), ["x.txt"]);
  assert.deepEqual(g.staged.map((i) => i.letter), ["M", "A", "R"]);
  assert.equal(g.staged[0].key, "staged:b.txt");
  assert.equal(g.changes[1].key, "changes:b.txt");
});

test("flatten: headers, collapsed groups keep only the header, empty groups vanish", () => {
  const g = m.buildGroups([entry("a", ".", "M"), entry("b", "M", ".")]);
  let rows = m.flatten(g, new Set());
  assert.deepEqual(rows.map(m.rowKey), ["h:staged", "staged:b", "h:changes", "changes:a"]);
  rows = m.flatten(g, new Set(["staged"]));
  assert.deepEqual(rows.map(m.rowKey), ["h:staged", "h:changes", "changes:a"]);
  assert.equal(rows[0].collapsed, true);
});

test("windowing: a 50,000 row list renders only a small window; spacers add up", () => {
  const w = m.windowRows(50_000, 12_000, 480);
  assert.ok(w.end - w.start < 60, `${w.end - w.start}`);
  assert.equal(w.padTop + (w.end - w.start) * m.ROW_HEIGHT + w.padBottom, 50_000 * m.ROW_HEIGHT);
  assert.equal(m.windowRows(0, 0, 480).end, 0);
  const top = m.windowRows(100, 0, 480);
  assert.equal(top.start, 0);
  // scrolled past the end clamps instead of producing negative padding
  const past = m.windowRows(10, 99_999, 480);
  assert.ok(past.padBottom >= 0 && past.padTop <= 10 * m.ROW_HEIGHT && past.end <= 10);
  assert.equal(m.scrollToReveal(0, 100, 480), 0);
  assert.equal(m.scrollToReveal(50, 0, 480), 50 * 24 + 24 - 480);
  assert.equal(m.scrollToReveal(5, 0, 480), null);
});

test("windowing handles 10k+ entries fast (grouping + flatten + window)", () => {
  const entries = Array.from({ length: 20_000 }, (_, i) => entry(`d${i % 200}/f${i}.txt`, ".", "M"));
  const t = performance.now();
  const g = m.buildGroups(entries);
  const rows = m.flatten(g, new Set());
  const w = m.windowRows(rows.length, 0, 480);
  const ms = performance.now() - t;
  assert.equal(rows.length, 20_001);
  assert.ok(w.end <= 60);
  assert.ok(ms < 1500, `${ms}ms`);
});

test("selection: plain, toggle, shift range across files only, prune after refresh", () => {
  const g = m.buildGroups([entry("a", ".", "M"), entry("b", ".", "M"), entry("c", ".", "M"), entry("s", "M", ".")]);
  const rows = m.flatten(g, new Set());
  let sel = m.selectRow(m.NO_SELECTION, rows, "changes:a", { shift: false, toggle: false });
  assert.deepEqual([...sel.keys], ["changes:a"]);
  sel = m.selectRow(sel, rows, "changes:c", { shift: true, toggle: false });
  assert.deepEqual([...sel.keys].sort(), ["changes:a", "changes:b", "changes:c"]);
  sel = m.selectRow(sel, rows, "changes:b", { shift: false, toggle: true });
  assert.deepEqual([...sel.keys].sort(), ["changes:a", "changes:c"]);
  assert.equal(m.selectRow(sel, rows, "h:changes", { shift: false, toggle: false }), sel, "headers are not selectable");
  const g2 = m.buildGroups([entry("a", ".", "M")]);
  assert.deepEqual([...m.pruneSelection(sel, g2).keys], ["changes:a"]);
  const acts = m.actionsFor(m.selectedItems(g, m.selectRow(m.NO_SELECTION, rows, "staged:s", { shift: false, toggle: false })));
  assert.equal(acts.unstage.length, 1);
  assert.equal(acts.stage.length + acts.discard.length, 0);
});

test("discard excludes staged-only and submodules", () => {
  const g = m.buildGroups([entry("sub", ".", "M", "changed", { submodule: true }), entry("f", ".", "M"), entry("u", ".", "?", "untracked")]);
  const items = [...g.changes, ...g.untracked];
  assert.deepEqual(m.actionsFor(items).discard.map((i) => i.entry.path), ["f", "u"]);
});

test("hunk selection builds sorted, in-range, unique indexes", () => {
  let s = new Set();
  s = m.toggleHunk(s, 2); s = m.toggleHunk(s, 0); s = m.toggleHunk(s, 2); s = m.toggleHunk(s, 1);
  assert.deepEqual(m.hunkIndexes(s, 3), [0, 1]);
  assert.deepEqual(m.hunkIndexes(new Set([5, -1, 1.5, 1]), 3), [1]);
  assert.deepEqual([...m.selectAllHunks(3)], [0, 1, 2]);
});

test("commit form validation mirrors the host", () => {
  const ok = (msg, staged = 1, conflicts = 0) => m.validateCommit(msg, staged, conflicts);
  assert.equal(ok("fix: a").ok, true);
  assert.match(ok("fix", 0).reason, /staged/);
  assert.match(ok("   \n").reason, /message/);
  assert.match(ok("-n x").reason, /"-"/);
  assert.match(ok("x", 1, 2).reason, /conflict/i);
  assert.equal(ok("é".repeat(10_001)).ok, false, "byte length, not characters");
  assert.equal(ok("é".repeat(9_999)).ok, true);
  assert.equal(ok("a‮b").ok, true);
  assert.equal(ok("‮​  ").ok, false, "only invisible characters is empty");
  assert.equal(m.utf8Length("aé€😀"), 1 + 2 + 3 + 4);
});

test("branch names", () => {
  for (const ok of ["main", "feature/x-1", "fix_é", "a.b"]) assert.equal(m.branchNameError(ok), null, ok);
  for (const bad of ["", "-x", "--force", "a..b", "a b", "a\tb", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "/a", "a/", "a//b", ".a", "a/.b", "a.lock", "a.", "@", "HEAD", "head", "a@{b", "a‮b", "a\u0000b", "x".repeat(201)]) {
    assert.notEqual(m.branchNameError(bad), null, JSON.stringify(bad));
  }
  // The invisible-character check keeps no regex state between calls.
  assert.notEqual(m.branchNameError("a‮b"), null);
  assert.notEqual(m.branchNameError("a‮b"), null);
  assert.equal(m.branchNameError("fine"), null);
});

test("untrusted text: control and bidi characters never reach the display", () => {
  assert.equal(m.displayText("a‮b​c\u0007d\u001b[31me\nf\tg"), "abcd[31me\nf\tg");
  assert.equal(m.displayLine("a\nb\tc"), "a b c");
  assert.deepEqual(m.splitPath("src/a/b.ts"), { dir: "src/a", name: "b.ts" });
  assert.deepEqual(m.splitPath("newdir/"), { dir: "", name: "newdir/" });
  assert.deepEqual(m.splitPath("x/newdir/"), { dir: "x", name: "newdir/" });
});

test("error wording: untrusted config explains and gives no trust button; identity gives exact commands", () => {
  const u = m.describeError("untrusted_repo_config", "the repository config contains a setting that runs programs (filter driver)");
  assert.match(u.detail, /filter driver/);
  assert.match(u.detail, /cannot mark a repository as trusted/);
  const i = m.describeError("identity_missing", "x");
  assert.deepEqual(i.steps, ['git config --global user.name "Your Name"', 'git config --global user.email "you@example.com"']);
  assert.equal(m.describeError("not_a_repo", "").title, "Not a git repository");
  assert.match(m.describeError("weird", "‮boom").detail, /^boom$/);
});

test("relative time", () => {
  const now = Date.UTC(2026, 9, 31, 12) ;
  assert.equal(m.relativeTime(now / 1000 - 30, now), "just now");
  assert.equal(m.relativeTime(now / 1000 - 600, now), "10 min ago");
  assert.equal(m.relativeTime(now / 1000 - 7200, now), "2 h ago");
  assert.equal(m.relativeTime(now / 1000 - 86400 * 3, now), "3 d ago");
  assert.match(m.relativeTime(now / 1000 - 86400 * 400, now), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(m.relativeTime(0, now), "");
});

test("chunk", () => {
  assert.deepEqual(m.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(m.chunk([], 3), []);
});
