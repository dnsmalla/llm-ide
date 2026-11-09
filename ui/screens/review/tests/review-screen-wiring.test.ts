import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("file reads are latest-wins: an earlier pick that resolves late is dropped, and so is its failure", () => {
  const review = read("../ReviewScreen.tsx");
  assert.match(review, /const fileGate = useRef\(refreshGate\(\)\)\.current;/);
  assert.match(review, /const token = fileGate\.begin\(\);/);
  assert.match(review, /if \(!fileGate\.isCurrent\(token\)\) return;/);
  assert.match(review, /if \(fileGate\.isCurrent\(token\)\) setFileError\("The file could not be read\."\);/);
});

test("a project switch drops the tabs, selection, expanded folders and in-flight reads", () => {
  const review = read("../ReviewScreen.tsx");
  assert.match(review, /useEffect\(\(\) => \{\s*fileGate\.begin\(\);\s*setTabs\(\[\]\);\s*setSelected\(null\);\s*setFileError\(null\);\s*setExpanded\(new Set\(\)\);\s*setChildren\(new Map\(\)\);\s*\}, \[fileGate, projectRoot\]\);/);
});

test("the linked repo is re-read when the section is shown or the project changes, not frozen at mount", () => {
  const review = read("../ReviewScreen.tsx");
  assert.match(review, /useMemo\(\(\) => pickLinkedRepo\(readRepoConfig\(\)\.saved\), \[active, projectRoot\]\)/);
});

test("a root listing that stops at the page limit says so", () => {
  const review = read("../ReviewScreen.tsx");
  assert.match(review, /listTruncation\(body\)/);
  assert.match(review, /the rest of \{root\.path\}\/ is not listed/);
});
