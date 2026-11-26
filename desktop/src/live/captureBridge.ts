import type { Channel } from "@tauri-apps/api/core";
import { createChannel } from "../tauriChannel";

export function createCaptureChannel(onEvent: (raw: unknown) => void): Channel<unknown> {
  return createChannel<unknown, unknown>((m) => m, onEvent);
}
