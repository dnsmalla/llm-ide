import assert from "node:assert/strict";
import test from "node:test";
import { autoTaskBusy, releaseAutoTask, tryAcquireAutoTask } from "../native/lock.ts";

test("auto task lock is single-holder and releases", () => {
  releaseAutoTask();
  assert.equal(autoTaskBusy(), false);
  assert.equal(tryAcquireAutoTask(), true);
  assert.equal(autoTaskBusy(), true);
  assert.equal(tryAcquireAutoTask(), false);
  releaseAutoTask();
  assert.equal(tryAcquireAutoTask(), true);
  releaseAutoTask();
});
