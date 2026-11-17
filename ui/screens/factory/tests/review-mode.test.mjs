import { test } from "node:test";
import assert from "node:assert/strict";
import { memFs } from "./mem-fs.mjs";
import { TEMPLATE_FILE, defaultFactoryTemplate, formatFactoryTemplate } from "../../loop/native/factory-template.ts";
import { readReviewMode, writeReviewMode } from "../review-mode.ts";

const original = formatFactoryTemplate({ ...defaultFactoryTemplate(), budget: { maxIterations: 7 } });

test("Human then Auto round-trips the template text and leaves other keys alone", async () => {
  const fs = memFs({ [TEMPLATE_FILE]: original });
  assert.equal(await readReviewMode(fs), "auto");
  assert.equal((await writeReviewMode(fs, "human")).ok, true);
  const human = fs.files.get(TEMPLATE_FILE);
  assert.equal(JSON.parse(human).reviewMode, "human");
  assert.equal(JSON.parse(human).budget.maxIterations, 7);
  assert.equal(await readReviewMode(fs), "human");
  assert.equal((await writeReviewMode(fs, "auto")).ok, true);
  assert.equal(fs.files.get(TEMPLATE_FILE), original);
});

test("an invalid or missing template is refused without writing", async () => {
  const bad = memFs({ [TEMPLATE_FILE]: "{ nope" });
  const r = await writeReviewMode(bad, "human");
  assert.equal(r.ok, false);
  assert.equal(bad.files.get(TEMPLATE_FILE), "{ nope");
  const none = memFs({});
  assert.equal((await writeReviewMode(none, "human")).ok, false);
  assert.equal(await readReviewMode(none), null);
});

test("a read error is returned as a failure, not thrown", async () => {
  const fs = { read: async () => { throw new Error("disk gone"); }, write: async () => { throw new Error("must not write"); } };
  const r = await writeReviewMode(fs, "human");
  assert.deepEqual(r, { ok: false, message: "disk gone" });
});
