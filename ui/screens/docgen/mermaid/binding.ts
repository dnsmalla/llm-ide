// Binds the runtime API to the host commands. `mermaid_runtime_read` returns raw bytes (an ArrayBuffer through Tauri's
// IPC); they are decoded as strict UTF-8 text and handed on, never executed here.
import type { MermaidRuntimeApi } from "./renderer.ts";

interface RawStatus {
  installed?: unknown;
  version?: unknown;
  sizeBytes?: unknown;
}

export function normalizeStatus(r: unknown): { installed: boolean; version: string; sizeBytes: number } {
  const o = (r && typeof r === "object" ? r : {}) as RawStatus;
  return {
    installed: o.installed === true,
    version: typeof o.version === "string" ? o.version.slice(0, 32) : "",
    sizeBytes: typeof o.sizeBytes === "number" && Number.isFinite(o.sizeBytes) && o.sizeBytes >= 0 ? o.sizeBytes : 0,
  };
}

export function decodeRuntimeBytes(raw: unknown): string {
  let bytes: Uint8Array;
  if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
  else if (raw instanceof Uint8Array) bytes = raw;
  else if (Array.isArray(raw) && raw.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) bytes = Uint8Array.from(raw as number[]);
  else throw new Error("The diagram renderer could not be read.");
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) throw new Error("The diagram renderer has an unexpected size.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function hostMermaidRuntime(invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>): MermaidRuntimeApi {
  return {
    status: async () => normalizeStatus(await invoke("mermaid_runtime_status")),
    install: async () => normalizeStatus(await invoke("mermaid_runtime_install")),
    read: async () => decodeRuntimeBytes(await invoke("mermaid_runtime_read")),
  };
}
