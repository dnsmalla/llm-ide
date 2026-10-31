// Reads the start of a project file through the host's bounded range read (never the whole file).
import type { FsApi } from "../explorer/fs";
import type { SourceReaders } from "./sources.ts";

export function fileReader(fs: Pick<FsApi, "readRange">): SourceReaders["file"] {
  return async (rel, maxBytes, signal) => {
    if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
    const r = await fs.readRange(rel, 0, maxBytes);
    return { text: r.binary ? null : r.text, truncated: r.next_offset !== null };
  };
}
