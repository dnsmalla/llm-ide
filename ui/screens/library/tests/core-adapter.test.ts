import { test } from "node:test";
import assert from "node:assert/strict";
import { indexCoreFrom, searchCoreFrom } from "../core-adapter.ts";

const ac = () => new AbortController().signal;

test("success becomes status 200 with the parsed body; request shape is passed through", async () => {
  const seen: unknown[] = [];
  const client = { request: async <T,>(path: string, opts?: unknown) => (seen.push([path, opts]), { ok: 1 } as T) };
  const r = await searchCoreFrom(client).request("GET", "/kb/index/search?q=x", undefined, ac());
  assert.deepEqual(r, { status: 200, body: { ok: 1 } });
  const s = ac();
  await indexCoreFrom(client).request("POST", "/kb/index/scan", { a: 1 }, s);
  assert.deepEqual((seen[1] as [string, { method: string; body: unknown; signal: AbortSignal }])[1], { method: "POST", body: { a: 1 }, signal: s });
});

test("an HTTP error keeps only its status; transport failures and aborts propagate", async () => {
  const http = { request: async () => { throw Object.assign(new Error("secret server text"), { status: 404 }); } };
  assert.deepEqual(await indexCoreFrom(http as never).request("POST", "/x", {}, ac()), { status: 404, body: {} });
  const net = { request: async () => { throw Object.assign(new Error("network"), { status: 0 }); } };
  await assert.rejects(indexCoreFrom(net as never).request("POST", "/x", {}, ac()));
  const a = new AbortController();
  const aborted = { request: async () => { a.abort(); throw Object.assign(new Error("aborted"), { status: 500 }); } };
  await assert.rejects(searchCoreFrom(aborted as never).request("GET", "/x", undefined, a.signal));
});
