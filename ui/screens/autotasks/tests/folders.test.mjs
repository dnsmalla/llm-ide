import { test } from "node:test";
import assert from "node:assert/strict";
import * as f from "../native/folders.ts";
import * as m from "../native/model.ts";

function fakeFs(tree) {
  // tree: { "source": ["a", "b"], "source/a": ["deep"], ... } directory -> child dir names; a child listed with a leading "." is hidden
  return {
    async list(path) {
      if (!(path in tree)) throw new Error("missing");
      return { entries: tree[path].map((n) => ({ name: n.replace(/^\./, ""), path: `${path}/${n}`, kind: "dir", hidden: n.startsWith("."), symlink: false, ignored: false, size: 0, mtime_ms: 0 })) };
    },
  };
}

test("the folder picker lists Library folders only, to depth four, hidden ones excluded", async () => {
  const fs = fakeFs({
    source: ["emails", ".git"],
    "source/emails": ["2026"],
    "source/emails/2026": ["11"],
    "source/emails/2026/11": ["01"],
    "source/emails/2026/11/01": ["too-deep"],
    code: [],
    data: [],
    "llm-doc": ["plans"],
    "llm-doc/plans": [],
  });
  const list = await f.scanLibraryFolders(fs);
  assert.deepEqual(list.map((x) => x.path), [
    "code", "data", "llm-doc", "llm-doc/plans", "source", "source/emails", "source/emails/2026", "source/emails/2026/11",
  ]); // depth 5 (11/01) is past the Mac limit of four
  assert.equal(list.find((x) => x.path === "source/emails/2026/11").depth, 4);
});

test("every offered folder is a valid project-relative path, and the list is capped", async () => {
  const fs = fakeFs({ source: Array.from({ length: 300 }, (_, i) => `s${i}`), code: Array.from({ length: 300 }, (_, i) => `c${i}`) });
  const list = await f.scanLibraryFolders(fs);
  assert.equal(list.length, f.FOLDER_MAX_RESULTS);
  for (const x of list) assert.equal(m.normalizeProjectPath(x.path), x.path);
});

test("a project without Library roots yields no folders, not an error", async () => {
  assert.deepEqual(await f.scanLibraryFolders(fakeFs({})), []);
});
