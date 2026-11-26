// Thin wrapper over the pty_* Tauri commands. Output comes back on a Channel as raw
// batches: Rust sends `Response` bytes, which arrive here as an ArrayBuffer (no JSON
// number arrays, no base64).
import { createChannel } from "../tauriChannel";
import { invokeHost as invoke } from "@llmide/screens/shell/host";

// Every call goes through invokeHost (SSH/remote-mode gate, root_missing hooks, error reporting); the Channel
// arguments pass through to the installed bridge unchanged.

export interface PtyHandle {
  id: number;
  /** Basename of the login shell (e.g. "zsh"), for the tab label. */
  shell: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** Flow control: credit `bytes` of output that xterm has finished parsing. */
  ack(bytes: number): Promise<void>;
  kill(): Promise<void>;
}

/**
 * Spawns the login shell; `onBytes` receives each output batch in order, and `onExit` fires once the shell has
 * exited and its last output was delivered (so a tab can say "(exited)" at once).
 */
export async function spawnShell(cols: number, rows: number, onBytes: (bytes: Uint8Array) => void, onExit: () => void = () => undefined): Promise<PtyHandle> {
  const channel = createChannel<ArrayBuffer, Uint8Array>((message) => new Uint8Array(message), onBytes);
  const exit = createChannel<unknown, true>(() => true, () => onExit());
  const { id, shell } = await invoke<{ id: number; shell: string }>("pty_spawn", { cols, rows, onData: channel, onExit: exit });
  return {
    id,
    shell,
    write: (data) => invoke<void>("pty_write", { id, data }),
    ack: (bytes) => invoke<void>("pty_ack", { id, bytes }).catch(() => undefined),
    resize: (c, r) => invoke<void>("pty_resize", { id, cols: c, rows: r }),
    kill: () => invoke<void>("pty_kill", { id }).catch(() => undefined),
  };
}
