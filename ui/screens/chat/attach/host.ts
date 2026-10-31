// The real AttachHost over the Rust commands `attach_pick_files` / `attach_read` / `attach_release`
// (desktop/src-tauri/src/attach.rs). The webview never supplies a path.
import type { AttachHost, PickResult } from "./manager";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error("unexpected attach_read answer");
}

export function createHostAttach(invoke: Invoke): AttachHost {
  return {
    async pick(): Promise<PickResult> {
      const r = await invoke<{ files?: unknown; rejected?: unknown }>("attach_pick_files");
      const files = Array.isArray(r?.files) ? r.files.flatMap((f) => {
        const o = f as Record<string, unknown>;
        return typeof o.handle === "string" && typeof o.name === "string" && typeof o.size === "number" && typeof o.mime === "string"
          ? [{ handle: o.handle, name: o.name, size: o.size, mime: o.mime }] : [];
      }) : [];
      const rejected = Array.isArray(r?.rejected) ? r.rejected.flatMap((f) => {
        const o = f as Record<string, unknown>;
        return typeof o.name === "string" && typeof o.reason === "string" ? [{ name: o.name, reason: o.reason }] : [];
      }) : [];
      return { files, rejected };
    },
    async read(handle, offset, len) { return asBytes(await invoke<unknown>("attach_read", { handle, offset, len })); },
    async release(handle) { await invoke<void>("attach_release", { handle }).catch(() => undefined); },
  };
}
