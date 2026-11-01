import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEntry } from "./helpers.mjs";

const m = await loadEntry();

test("markdown template import reads the # name and ## sections", () => {
  assert.deepEqual(m.parseMarkdownTemplate("# Weekly review\n\n## Wins\n\n## Risks\n"), { name: "Weekly review", sections: ["Wins", "Risks"] });
  assert.deepEqual(m.parseMarkdownTemplate("## One\nbody\n## Two"), { name: "Imported template", sections: ["One", "Two"] });
  assert.equal(m.parseMarkdownTemplate("   \n"), null);
});
