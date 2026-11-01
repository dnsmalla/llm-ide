import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTestStructure } from "../native/testmap.ts";

function mem(files) {
  return {
    async read(p) { if (!(p in files)) throw Object.assign(new Error("missing"), { code: "missing" }); return { status: "ok", text: files[p] }; },
    async list(dir) {
      const prefix = dir === "." ? "" : `${dir}/`;
      const names = new Map();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length); const seg = rest.split("/")[0];
        names.set(seg, rest.includes("/") ? "dir" : "file");
      }
      if (names.size === 0 && dir !== ".") throw Object.assign(new Error("missing"), { code: "missing" });
      return { entries: [...names].map(([name, kind]) => ({ name, kind, path: `${prefix}${name}` })) };
    },
    async create() {}, async write() {},
  };
}

test("test structure detects a Swift package and a Node package", async () => {
  const fs = mem({
    "Package.swift": 'let package = Package(name: "X", targets: [.testTarget(name: "XTests")])',
    "Tests/XTests/a.swift": "",
    "web/package.json": '{"scripts":{"test":"vitest"}}',
    "web/tests/a.test.ts": "",
  });
  const s = await detectTestStructure(fs, "", new Date("2026-01-01T00:00:00Z"));
  assert.equal(s.status, "ok");
  assert.deepEqual(s.roots.map((r) => r.runner).sort(), ["npm", "xctest"]);
  assert.equal(s.roots.find((r) => r.runner === "npm").command, "cd web && npm test");
});

test("missing test roots are reported, not invented", async () => {
  const s = await detectTestStructure(mem({ "README.md": "" }), "", new Date("2026-01-01T00:00:00Z"));
  assert.equal(s.status, "missing");
  assert.equal(s.roots.length, 0);
});
