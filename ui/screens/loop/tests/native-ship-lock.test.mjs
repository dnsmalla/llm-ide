import { test } from "node:test";
import assert from "node:assert/strict";
import { withShipLock } from "../native/ship-lock.ts";

test("one ship per branch at a time: a second ship of the same run is refused while the first runs, others are not", async () => {
  let release;
  const first = withShipLock("r1", () => "busy", () => new Promise((resolve) => { release = () => resolve("shipped"); }));
  assert.equal(await withShipLock("r1", () => "busy", async () => "second"), "busy");
  assert.equal(await withShipLock("r2", () => "busy", async () => "other run"), "other run");
  release();
  assert.equal(await first, "shipped");
  assert.equal(await withShipLock("r1", () => "busy", async () => "again"), "again", "released after the ship ends");
  await assert.rejects(withShipLock("r1", () => "busy", async () => { throw new Error("push failed"); }), /push failed/);
  assert.equal(await withShipLock("r1", () => "busy", async () => "again"), "again", "released after a failed ship too");
});
