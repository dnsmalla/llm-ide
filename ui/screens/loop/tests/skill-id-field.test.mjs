import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const req = createRequire(join(REPO, "desktop", "package.json"));
let X, h, html;
before(async () => {
  const outfile = join(bundleDir("loop-skill-id-field"), "entry.mjs");
  await req("esbuild").build({ entryPoints: [join(HERE, "../native/SkillIdField.tsx")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent" });
  X = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  h = req("react").createElement;
  html = (el) => req("react-dom/server").renderToStaticMarkup(el);
});

const skills = X => X.decodeSkillChoices({ skills: [{ id: "skills/doc-writer", name: "Doc writer" }, { id: "catalog/a__b/c", name: "Cat" }, { id: " pad", name: "x" }, { id: "skills/plan-director" }] });

test("the picker lists the available skills by id and drops malformed ones", () => {
  const list = skills(X);
  assert.deepEqual(list.map((s) => s.id), ["skills/doc-writer", "catalog/a__b/c", "skills/plan-director"]);
  const out = html(h(X.SkillIdField, { value: "skills/doc-writer", skills: list, onChange() {} }));
  assert.match(out, /<option value="skills\/doc-writer">Doc writer<\/option>/);
  assert.doesNotMatch(out, /not in your skill list/);
});

test("a stored id that is not in the list is kept and flagged, not rewritten", () => {
  const out = html(h(X.SkillIdField, { value: "mine/custom", skills: skills(X), onChange() {} }));
  assert.match(out, /value="mine\/custom"/);
  assert.match(out, /not in your skill list/);
});

test("with no list (loading or failed) it is a plain field", () => {
  const out = html(h(X.SkillIdField, { value: "mine/custom", skills: null, onChange() {} }));
  assert.match(out, /value="mine\/custom"/);
  assert.doesNotMatch(out, /<option/);
});

test("typing or choosing writes the id", () => {
  let got;
  // Call the component directly with a stub hook dispatcher (React 19 internals), since there is no DOM here.
  const internals = req("react").__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  internals.H = { useState: (v) => [v, () => {}] };
  const el = X.SkillIdField({ value: "", skills: [], onChange: (id) => { got = id; } });
  internals.H = null;
  el.props.children[1].props.onChange({ target: { value: "skills/doc-writer" } });
  assert.equal(got, "skills/doc-writer");
});
