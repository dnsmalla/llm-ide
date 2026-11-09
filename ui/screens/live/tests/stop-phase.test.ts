import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseAfterFailedStop } from "../stop-phase.ts";
import type { CaptureStatus } from "../host.ts";

const status = (recording: boolean): CaptureStatus => ({ supported: true, trusted: true, recording, sessionId: "s", startedAtMs: 1, notesRoot: true, macAppRunning: false, devBuild: false });

test("a failed status read after a failed Stop is unknown: stays recording and keeps the tray state", () => {
  assert.deepEqual(phaseAfterFailedStop(null), { phase: "recording", releaseRecording: false });
});

test("a failed Stop whose status says the host still records stays recording", () => {
  assert.deepEqual(phaseAfterFailedStop(status(true)), { phase: "recording", releaseRecording: false });
});

test("a failed Stop whose status says the host stopped releases the recording", () => {
  assert.deepEqual(phaseAfterFailedStop(status(false)), { phase: "done", releaseRecording: true });
});
