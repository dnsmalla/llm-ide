// Text-file attachments for chat.send, read in the browser. Only the file's own name (never a path) and its text go
// on the wire. Limits are the core's (extension/core/prompt-framing.mjs selectAttachments, mirrored in
// ui/screens/chat/attach/limits.ts) and the v1 schema's; schema/host-api/v1/fixtures/security/compose.json pins them.
export const ATTACH_LIMITS = Object.freeze({
  maxFiles: 10, maxNameChars: 300, maxCharsPerFile: 80_000, maxCharsTotal: 200_000, maxFileBytes: 25 * 1024 * 1024,
});
/** Bytes read from a file: enough for maxCharsPerFile characters even at 4 bytes each; the rest is never read. */
const READ_BYTES = ATTACH_LIMITS.maxCharsPerFile * 4;
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml",
  "application/javascript", "application/typescript", "application/x-sh", "application/sql",
]);
export const ACCEPT = "text/*,.md,.txt,.json,.yaml,.yml,.toml,.csv,.log,.xml,.html,.css,.js,.ts,.tsx,.py,.swift,.rs,.go,.java,.sh,.sql";

export interface FileLike { name: string; type: string; size: number; slice(start?: number, end?: number): { text(): Promise<string> } }
export interface WebAttachment { name: string; text: string; truncated: boolean }
export type AttachResult = { ok: true; attachment: WebAttachment } | { ok: false; reason: string };

/** The last path segment without control characters, clamped; browsers give a bare name already, this makes sure. */
export function cleanName(name: string): string {
  const base = (String(name).split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(0, ATTACH_LIMITS.maxNameChars) || "file.txt";
}

export async function readTextAttachment(f: FileLike, usedChars: number): Promise<AttachResult> {
  const name = cleanName(f.name);
  const type = typeof f.type === "string" ? f.type.toLowerCase() : "";
  if (type.startsWith("image/")) return { ok: false, reason: `${name}: images can't be sent from the web yet. Attach text files.` };
  if (type && !type.startsWith("text/") && !TEXT_TYPES.has(type)) return { ok: false, reason: `${name}: only text files can be attached.` };
  if (f.size > ATTACH_LIMITS.maxFileBytes) return { ok: false, reason: `${name}: larger than 25 MB.` };
  const room = ATTACH_LIMITS.maxCharsTotal - usedChars;
  if (room <= 0) return { ok: false, reason: "This message is at the 200,000-character limit for attachments." };
  const raw = await f.slice(0, READ_BYTES).text();
  if (raw.includes("\u0000")) return { ok: false, reason: `${name}: looks like a binary file, not text.` };
  const text = raw.slice(0, Math.min(ATTACH_LIMITS.maxCharsPerFile, room));
  return { ok: true, attachment: { name, text, truncated: text.length < raw.length || f.size > READ_BYTES } };
}
