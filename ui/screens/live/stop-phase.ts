import type { CaptureStatus } from "./host";

/** The screen phase after a Stop save failed and the status read ran. A null status (the read failed too) is unknown,
 * not "stopped": the host may still be recording, so the screen stays in recording and must not release the tray state. */
export function phaseAfterFailedStop(status: CaptureStatus | null): { phase: "recording" | "done"; releaseRecording: boolean } {
  if (status === null) return { phase: "recording", releaseRecording: false };
  if (status.recording) return { phase: "recording", releaseRecording: false };
  return { phase: "done", releaseRecording: true };
}
