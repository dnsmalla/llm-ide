process.env.TZ = "UTC";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadEntry, react, server } from "./helpers.mjs";

let L;
let h;
let html;
before(async () => {
  L = await loadEntry();
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});

const deps = (mutate) => ({
  list: async () => ({ entries: [] }),
  read: async () => ({ status: "binary", text: null }),
  ...(mutate ? { mutate } : {}),
});
const noopMutate = {
  pick: async () => ({ files: [], rejected: [] }),
  read: async () => new Uint8Array(),
  release: async () => {},
  create: async (p) => p,
  writeNew: async () => {},
  trash: async () => {},
};

test("the remove confirmation is an alertdialog that names the item, says Trash, and focuses Cancel", () => {
  const plan = L.planRemove("code/<img onerror=1>.ts", "file", null);
  assert.ok(plan.ok);
  const out = html(h(L.RemoveDialog, { plan, onConfirm() {}, onCancel() {} }));
  assert.match(out, /role="alertdialog"/);
  assert.match(out, /aria-labelledby="lib-dlg-move-/);
  assert.match(out, /&lt;img onerror=1&gt;\.ts/, "the name is text, never markup");
  assert.match(out, /will be moved to the Trash/);
  assert.match(out, /Nothing is deleted permanently/);
  const cancel = out.indexOf(">Cancel</button>");
  const confirm = out.indexOf(">Move to Trash</button>");
  assert.ok(cancel > 0 && confirm > cancel, "Cancel comes first");
  assert.match(out, /<button[^>]*data-autofocus[^>]*>Cancel<\/button>/, "Cancel is the focused button");
  assert.match(out, /<button[^>]*lib-btn-danger[^>]*>Move to Trash<\/button>/);
});

test("the new-folder dialog starts with Create disabled and a field that is focused", () => {
  const out = html(h(L.NewFolderDialog, { folder: "code/src", onCreate() {}, onCancel() {} }));
  assert.match(out, /An empty folder is created in code\/src\//);
  assert.match(out, /<input[^>]*data-autofocus/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Create folder<\/button>/);
});

test("the project tree shows an add menu button only with the desktop mutations, and Explorer otherwise", () => {
  const desktop = html(h(L.ProjectFilesNav, { deps: deps(noopMutate), selected: null, onSelect() {} }));
  assert.match(desktop, /aria-haspopup="menu" aria-label="Add to Code"/);
  assert.match(desktop, /aria-label="Add to Data"/);
  const readOnly = html(h(L.ProjectFilesNav, { deps: deps(null), selected: null, onSelect() {} }));
  assert.match(readOnly, /aria-label="Open Explorer to add Code"/);
  assert.doesNotMatch(readOnly, /aria-haspopup="menu"/);
});
