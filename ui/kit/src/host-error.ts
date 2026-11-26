// Host error (`{ code, message }`) to the sentence a user reads. One decoder, a table per caller.
import { isRecord } from "./decode.ts";

/** The host's error code, or "" when the error has none. */
export function hostErrorCode(e: unknown): string {
  return isRecord(e) && typeof e.code === "string" ? e.code : "";
}

/** A table entry is fixed text, or a function of the host's own (trimmed) message. */
export type HostErrorTable = Readonly<Record<string, string | ((message: string) => string)>>;

/**
 * The text for a host error. A known code gives its table entry; any other shows the host's message
 * (record `message`, else an Error's), cut to 300 characters, else `fallback`.
 */
export function hostErrorText(e: unknown, table: HostErrorTable, fallback: string): string {
  const message = (isRecord(e) && typeof e.message === "string" ? e.message : e instanceof Error ? e.message : "").trim();
  const code = hostErrorCode(e);
  if (code && Object.hasOwn(table, code)) {
    const entry = table[code]!;
    return typeof entry === "function" ? entry(message) : entry;
  }
  return message.slice(0, 300) || fallback;
}
