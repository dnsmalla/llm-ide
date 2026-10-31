import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const L = await load("lang.ts");
const S = await load("session.ts");

test("language detection by name and extension", () => {
  const cases = { "src/App.tsx": "typescript", "a/b/Dockerfile": "dockerfile", "Dockerfile.dev": "dockerfile", Makefile: "makefile", "x.PY": "python", "pkg/Package.swift": "swift", "README.md": "markdown", ".gitignore": "ini", "noext": "plaintext", ".hidden": "plaintext", "a.unknownext": "plaintext", "Sources/Foo.swift": "swift", "z.rs": "rust" };
  for (const [p, lang] of Object.entries(cases)) assert.equal(L.languageFor(p), lang, p);
});

function memKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), m };
}

test("session key is stable per root and does not contain the path", () => {
  const k = S.projectKey("/Users/me/secret-project");
  assert.equal(k, S.projectKey("/Users/me/secret-project"));
  assert.notEqual(k, S.projectKey("/Users/me/other"));
  assert.ok(!k.includes("secret"));
});

test("session save/load round trip with clamping and filtering", () => {
  const kv = memKv();
  S.saveSession(kv, "/p", { tabs: { v: 1, tabs: [], active: null }, expanded: ["a", "a/b"], treeWidth: 300 });
  const s = S.loadSession(kv, "/p");
  assert.deepEqual(s.expanded, ["a", "a/b"]);
  assert.equal(s.treeWidth, 300);
  kv.m.set(S.projectKey("/q"), JSON.stringify({ expanded: ["ok", "../bad", "/abs", 5, "x\0y"], treeWidth: 99999 }));
  const q = S.loadSession(kv, "/q");
  assert.deepEqual(q.expanded, ["ok"]);
  assert.equal(q.treeWidth, 800);
});

test("storage failures never throw", () => {
  const boom = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); } };
  assert.deepEqual(S.loadSession(boom, "/p"), { tabs: null, expanded: [], treeWidth: null });
  assert.doesNotThrow(() => S.saveSession(boom, "/p", { tabs: null, expanded: [], treeWidth: null }));
  assert.deepEqual(S.loadSession(null, "/p").expanded, []);
  assert.deepEqual(S.loadSession(memKv({ [S.projectKey("/p")]: "{not json" }), "/p").expanded, []);
});
