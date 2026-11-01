// Reads a project image for Visual/Doc Gen sources as the core's `[binary:<mime>]\n<base64>` attachment content.
import type { SourceReaders } from "./sources.ts";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function imageReader(invoke: Invoke): SourceReaders["image"] {
  return async (rel, signal) => {
    if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
    const raw = await invoke<unknown>("fs_read_image", { path: rel });
    const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (typeof o.mime !== "string" || typeof o.dataUrl !== "string") return { content: null };
    const comma = o.dataUrl.indexOf(",");
    if (comma < 0) return { content: null };
    return { content: `[binary:${o.mime}]\n${o.dataUrl.slice(comma + 1)}` };
  };
}
