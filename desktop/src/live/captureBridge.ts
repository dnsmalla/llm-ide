import { Channel } from "@tauri-apps/api/core";
export function createCaptureChannel(onEvent: (raw: unknown) => void): Channel<unknown> { const ch = new Channel<unknown>(); ch.onmessage = (m) => onEvent(m); return ch; }
