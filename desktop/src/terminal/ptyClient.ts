// Thin wrapper over the pty_* Tauri commands. Output comes back on a Channel as raw
// batches: Rust sends `Response` bytes, which arrive here as an ArrayBuffer (no JSON
// number arrays, no base64).
import { Channel, invoke } from "@tauri-apps/api/core";

export interface PtyHandle {
  id: number;
  /** Basename of the login shell (e.g. "zsh"), for the tab label. */
  shell: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
}

/** Spawns the login shell; `onBytes` receives each output batch in order. */
export async function spawnShell(cols: number, rows: number, onBytes: (bytes: Uint8Array) => void): Promise<PtyHandle> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) => onBytes(new Uint8Array(message));
  const { id, shell } = await invoke<{ id: number; shell: string }>("pty_spawn", { cols, rows, onData: channel });
  return {
    id,
    shell,
    write: (data) => invoke<void>("pty_write", { id, data }),
    resize: (c, r) => invoke<void>("pty_resize", { id, cols: c, rows: r }),
    kill: () => invoke<void>("pty_kill", { id }).catch(() => undefined),
  };
}
