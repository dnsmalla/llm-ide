import { test } from "node:test";
import assert from "node:assert/strict";
import { copyReadiness } from "../native/readiness-copy.ts";

test("copyReadiness tolerates a copy that already exists (a retried record write)", async () => {
  const fs = {
    async read() { return { status: "ok", text: "# ready", hash: "h" }; },
    async create() { throw Object.assign(new Error("exists"), { code: "exists" }); },
    async write() { throw Object.assign(new Error("exists"), { code: "exists" }); },
  };
  assert.equal(await copyReadiness(fs, "", "r1", new Date("2026-11-25T00:00:00Z")), true);
});
