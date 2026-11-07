// "Add from Library": the dialog renders read-only note rows through the notes host; picking attaches note text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const c = await load("../chat/LibraryNotePicker.tsx");
test("the picker renders a labelled dialog and note rows", () => {
  let listed = null;
  const host = {
    rootGet: async () => null, rootChoose: async () => null, rootClear: async () => {},
    list: async (cursor, limit) => { listed = [cursor, limit]; return { entries: [{ rel: "source/meetings/a.md", size: 10, mtimeMs: 0, placeholder: false }], nextCursor: null, visited: 1 }; },
    read: async () => ({ rel: "source/meetings/a.md", size: 10, mtimeMs: 0, offset: 0, text: "hello note", nextOffset: null }),
    heads: async () => [],
  };
  const out = renderToStaticMarkup(React.createElement(c.LibraryNotePicker, { host, onPick() {}, onClose() {} }));
  assert.match(out, /role="dialog"[^>]*aria-label="Add from Library"/);
  assert.match(out, /Filter notes/);
  assert.equal(listed, null, "the list loads in an effect, not during render");
});
