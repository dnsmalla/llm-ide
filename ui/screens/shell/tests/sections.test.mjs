import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleSectionsFor, isSelectableFor, REMOTE_SECTIONS, REMOTE_GROUP_HIDDEN, LOCAL_ONLY_NOTICE } from "../sections.ts";

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
