import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleSectionsFor, isSelectableFor, REMOTE_SECTIONS, REMOTE_GROUP_HIDDEN, LOCAL_ONLY_NOTICE, localOnlyNotice } from "../sections.ts";

test("remote mode lists only the screens that work over a hub", () => {
  assert.deepEqual(visibleSectionsFor("remote").map((s) => s.id), ["welcome", "issues", "gantt", "library", "chat", "settings"]);
  assert.equal(isSelectableFor("explorer", "remote"), false);
  assert.equal(isSelectableFor("chat", "remote"), true);
  assert.equal(isSelectableFor("explorer", "local"), true);
  assert.match(LOCAL_ONLY_NOTICE, /local computer/);
  assert.ok(REMOTE_GROUP_HIDDEN.includes("workspace"));
  assert.deepEqual(REMOTE_SECTIONS, ["welcome", "issues", "gantt", "library", "chat", "settings"]);
});

import { navReducer, initialNav, sectionForShortcut, selectableSections } from "../sections.ts";

const key = (n) => ({ key: String(n), ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });

test("connected to a hub, a local-only section cannot be selected", () => {
  const remote = { ...initialNav("chat"), mode: "remote" };
  assert.equal(navReducer(remote, { type: "select", id: "explorer" }), remote, "reducer refuses Explorer");
  assert.equal(navReducer(remote, { type: "select", id: "library" }).active, "library", "a hub section still works");
  assert.equal(navReducer(initialNav("chat"), { type: "select", id: "explorer" }).active, "explorer", "local mode is unchanged");
  const stepped = navReducer(remote, { type: "step", delta: 1 });
  assert.ok(isSelectableFor(stepped.active, "remote"), "stepping skips local-only sections");
  assert.ok(selectableSections("remote").every((s) => isSelectableFor(s.id, "remote")));
});

test("a local-only section restored before the hub connected falls back when the mode turns remote", () => {
  const next = navReducer(initialNav("explorer"), { type: "mode", mode: "remote" });
  assert.equal(next.mode, "remote");
  assert.equal(next.active, "welcome");
  const same = initialNav("chat");
  assert.equal(navReducer(same, { type: "mode", mode: "local" }), same);
});

test("the Cmd+N shortcut only resolves to sections the mode can show", () => {
  const local = selectableSections("local").filter((s) => s.shortcut != null && !isSelectableFor(s.id, "remote"));
  assert.ok(local.length > 0);
  for (const s of local) {
    assert.equal(sectionForShortcut(key(s.shortcut), "local"), s.id);
    assert.equal(sectionForShortcut(key(s.shortcut), "remote"), null);
  }
});

test("sections: ssh mode lists the hub screens plus the Explorer, which runs on the server", () => {
  assert.deepEqual(visibleSectionsFor("ssh").map((s) => s.id), ["welcome", "explorer", "issues", "gantt", "library", "chat", "settings"]);
  assert.equal(isSelectableFor("chat", "ssh"), true);
  assert.equal(isSelectableFor("explorer", "ssh"), true);
  // A hub has no server folder to browse: its list is unchanged.
  assert.equal(isSelectableFor("explorer", "remote"), false);
  assert.deepEqual(visibleSectionsFor("remote").map((s) => s.id), ["welcome", "issues", "gantt", "library", "chat", "settings"]);
});

test("the local-only notice names a hub in hub mode and an SSH server in ssh mode", () => {
  assert.equal(localOnlyNotice("remote"), "This screen reads files or runs processes on the local computer. It is unavailable when the app is connected to a hub.");
  assert.equal(localOnlyNotice("remote"), LOCAL_ONLY_NOTICE);
  assert.equal(localOnlyNotice("ssh"), "This screen reads files or runs processes on the local computer. It is unavailable when the app is connected to an SSH server.");
});

test("a stored id of the removed Remote screen falls back to Home", async () => {
  const { initialNav, isSelectable, DEFAULT_SECTION } = await import("../sections.ts");
  assert.equal(isSelectable("remote"), false);
  assert.equal(initialNav("remote").active, DEFAULT_SECTION);
});

test("mount adds a section to visited without activating it", () => {
  const start = initialNav("chat");
  const next = navReducer(start, { type: "mount", id: "loop" });
  assert.equal(next.active, "chat");
  assert.deepEqual(next.visited, ["chat", "loop"]);
  assert.equal(navReducer(next, { type: "mount", id: "loop" }), next, "already visited is a no-op");
  const remote = { ...initialNav("chat"), mode: "remote" };
  assert.equal(navReducer(remote, { type: "mount", id: "explorer" }), remote, "not selectable in this mode");
});
