// How a file is shown (decision D2): code/text as plain text, Markdown through the no-HTML Markdown view, PDF as a
// download, Office files via Box's extracted text, everything else "not shown". HTML and SVG are code: source text.
import { languageFor } from "../../../ui/screens/explorer/lang.ts";
import type { Got } from "./http.ts";
import type { Entry, Opened } from "./model.ts";
import type { Provider } from "./oauth.ts";

export type PreviewKind = "code" | "markdown" | "text" | "pdf" | "extracted" | "unsupported";
export const CAPS = { text: 1_048_576, extracted: 2_097_152, pdf: 20_971_520, json: 2_097_152 } as const;
const EXTRACT = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key"]);
const BINARY = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "ico", "zip", "gz", "tgz", "tar", "7z", "rar", "jar", "war",
  "mp3", "mp4", "mov", "wav", "m4a", "avi", "mkv", "woff", "woff2", "ttf", "otf", "eot", "exe", "dll", "so", "dylib", "bin", "dmg", "iso",
  "class", "o", "a", "wasm", "pyc", "sqlite", "db"]);

export function previewKind(name: string, provider: Provider): { kind: PreviewKind; language: string } {
  const lower = name.toLowerCase(); const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  if (ext === "pdf") return { kind: "pdf", language: "PDF" };
  if (EXTRACT.has(ext)) return { kind: provider === "box" ? "extracted" : "unsupported", language: ext.toUpperCase() };
  if (BINARY.has(ext)) return { kind: "unsupported", language: ext.toUpperCase() };
  const lang = languageFor(name);
  if (lang === "markdown") return { kind: "markdown", language: "Markdown" };
  return lang === "plaintext" ? { kind: "text", language: "Text" } : { kind: "code", language: lang };
}

/** null when the first 8 KiB hold a NUL byte (binary). */
export function decodeText(b: Uint8Array): string | null {
  if (b.subarray(0, 8192).includes(0)) return null;
  return new TextDecoder("utf-8").decode(b);
}

export async function loadPreview(entry: Entry, p: { kind: PreviewKind; language: string }, webUrl: string | null, get: (cap: number) => Promise<Got>): Promise<Opened> {
  const o: Opened = { entry, kind: p.kind, language: p.language, text: null, bytes: null, truncated: false, webUrl, reason: null };
  if (p.kind === "unsupported") return { ...o, reason: "type" };
  if (p.kind === "pdf") { const g = await get(CAPS.pdf); return g.truncated ? { ...o, reason: "too_large" } : { ...o, bytes: g.bytes }; }
  const g = await get(p.kind === "extracted" ? CAPS.extracted : CAPS.text);
  const text = decodeText(g.bytes);
  return text === null ? { ...o, kind: "unsupported", reason: "binary" } : { ...o, text, truncated: g.truncated };
}
