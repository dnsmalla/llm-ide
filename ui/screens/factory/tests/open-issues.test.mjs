import { test } from "node:test";
import assert from "node:assert/strict";
import { walkOpenIssues } from "../open-issues.ts";

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, number: i, title: `t${i}` }));

test("walks pages until a short one and reports no failure", async () => {
  const paths = [];
  const r = await walkOpenIssues(async (p) => { paths.push(p); return { status: 200, body: { issues: rows(paths.length === 1 ? 100 : 3) } }; }, "github");
  assert.equal(paths.length, 2);
  assert.equal(r.issues.length, 103);
  assert.equal(r.failed, false);
});

test("a failed page keeps the rows read so far and says the list is partial", async () => {
  let n = 0;
  const r = await walkOpenIssues(async () => (++n === 1 ? { status: 200, body: { issues: rows(100) } } : { status: 500, body: null }), "gitlab");
  assert.equal(r.issues.length, 100);
  assert.equal(r.failed, true);
  assert.equal((await walkOpenIssues(async () => { throw new Error("down"); }, "gitlab")).failed, true);
});

test("an aborted walk sends no further request and is not a failure", async () => {
  const ctrl = new AbortController();
  let n = 0;
  const r = await walkOpenIssues(async () => { n++; ctrl.abort(); return { status: 200, body: { issues: rows(100) } }; }, "github", ctrl.signal);
  assert.equal(n, 1);
  assert.equal(r.failed, false);
});
