// Reads one Markdown template from the user's disk through the host's native picker and the attachment commands
// (`attach_pick_files` / `attach_read` / `attach_release`, desktop/src-tauri/src/attach.rs). The webview never supplies
// a path: the host hands back an opaque handle, and every handle is released on every path out of this function.
// Only the bytes of the one chosen file are read, capped at TEMPLATE_FILE_MAX_BYTES, and decoded strictly as UTF-8.

import type { Surface } from "./model.ts";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** A template is a short instruction document; a larger file is refused before its bytes are read. */
export const TEMPLATE_FILE_MAX_BYTES = 256 * 1024;
/** The host reads at most 4 MiB per call; the cap above is far below it, so one call normally suffices. */
const READ_CHUNK = 1024 * 1024;
const TEMPLATE_EXT = /\.(md|txt)$/i;

export type PickedTemplateFile =
  | { kind: "cancelled" }
  | { kind: "error"; message: string }
  | { kind: "ok"; name: string; text: string };

interface PickedHandle { handle: string; name: string; size: number; mime: string }

const asHandle = (v: unknown): PickedHandle | null => {
  const o = v as Record<string, unknown> | null;
  return o && typeof o.handle === "string" && typeof o.name === "string" && typeof o.size === "number" && typeof o.mime === "string"
    ? { handle: o.handle, name: o.name, size: o.size, mime: o.mime }
    : null;
};

function bytesOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error("unexpected attach_read answer");
}

/** Runs a picker; a host failure becomes an error result the dialog can show, not an unhandled rejection. */
export async function settlePick(pick: () => Promise<PickedTemplateFile>): Promise<PickedTemplateFile> {
  try {
    return await pick();
  } catch {
    return { kind: "error", message: "The file picker could not be opened." };
  }
}

export async function pickTemplateFile(invoke: Invoke): Promise<PickedTemplateFile> {
  const picked = await invoke<{ files?: unknown; rejected?: unknown }>("attach_pick_files");
  const files = Array.isArray(picked?.files) ? picked.files.map(asHandle).filter((f): f is PickedHandle => f !== null) : [];
  const release = (handle: string) => invoke<void>("attach_release", { handle }).catch(() => undefined);
  if (files.length === 0) {
    const rejected = Array.isArray(picked?.rejected) ? picked.rejected as Array<{ reason?: unknown }> : [];
    if (rejected.length > 0) return { kind: "error", message: "That file could not be opened." };
    return { kind: "cancelled" };
  }
  // Only the first file is used; the rest are released at once so no handle outlives the pick.
  const [first, ...others] = files;
  await Promise.all(others.map((f) => release(f.handle)));
  const file = first!;
  try {
    if (!TEMPLATE_EXT.test(file.name)) return { kind: "error", message: "Choose a .md or .txt file." };
    if (file.size > TEMPLATE_FILE_MAX_BYTES) return { kind: "error", message: "That file is larger than 256 KB. Templates are short; split the instructions." };
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < file.size) {
      const part = bytesOf(await invoke<unknown>("attach_read", { handle: file.handle, offset, len: Math.min(READ_CHUNK, file.size - offset) }));
      if (part.length === 0) break;
      chunks.push(part);
      offset += part.length;
    }
    const all = new Uint8Array(offset);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    if (all.includes(0)) return { kind: "error", message: "That file is not Markdown text." };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(all);
    } catch {
      return { kind: "error", message: "That file is not UTF-8 text. Save it as UTF-8 and try again." };
    }
    return { kind: "ok", name: file.name, text };
  } finally {
    await release(file.handle);
  }
}

// ---- import text ------------------------------------------------------------------------------------------------
// The whole file is what the core stores (the Mac's DocTemplateStore.importMarkdownFile writes the raw content). The
// core does not stamp the surface onto raw content, so the import stamps it here, as the Mac does: a Visual import
// that were not stamped would come back as a Doc Gen template and vanish from the menu it was imported into.

const TEMPLATE_STEM = "llmide:doc-template";
/** Lines split as the Swift side does (a CRLF pair is one break); the separator is kept so line endings survive. */
const LINE_BREAK = /(\r\n|[\n\r\v\f\u0085\u2028\u2029])/;

/** The marker line for a surface. Doc Gen writes the bare marker; Visual adds `surface=visual`. */
export function surfaceMarkerLine(surface: Surface): string {
  return surface === "visual" ? `<!-- ${TEMPLATE_STEM} surface=visual -->` : `<!-- ${TEMPLATE_STEM} -->`;
}

/**
 * Stamps the surface marker into a template's text, as the core's `ensureSurfaceMarker` and the Mac do: an existing
 * marker is replaced in place; otherwise one is inserted after the `# ` title (or at the top when there is none). Every
 * other byte is kept, including each line's own line ending, so the rest of the file reads back unchanged.
 */
export function stampSurfaceMarker(text: string, surface: Surface): string {
  const parts = text.split(LINE_BREAK);
  type Line = { text: string; eol: string };
  const lines: Line[] = [];
  for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i] ?? "", eol: parts[i + 1] ?? "" });
  // The file's first line break decides the line ending of any line the stamp adds.
  const eol = parts[1] ?? "\n";
  const marker = surfaceMarkerLine(surface);
  const isMarker = (l: Line) => { const t = l.text.trim(); return t.startsWith("<!--") && t.includes(TEMPLATE_STEM); };
  const existing = lines.findIndex(isMarker);
  if (existing >= 0) {
    lines[existing] = { text: marker, eol: lines[existing]!.eol };
  } else {
    const title = lines.findIndex((l) => l.text.trim().startsWith("# "));
    if (title >= 0) {
      // A title that ends the file gets a line break first, so the inserted lines sit after it, as the core's join does.
      const last = title === lines.length - 1;
      if (last) lines[title] = { text: lines[title]!.text, eol };
      lines.splice(title + 1, 0, { text: "", eol }, { text: marker, eol: last ? "" : eol });
    } else {
      lines.splice(0, 0, { text: marker, eol }, { text: "", eol });
    }
  }
  return lines.map((l) => l.text + l.eol).join("");
}

/**
 * The text an import stores: the file with the surface stamped in, checked against the same 256 KB cap the core
 * applies to a stored file (the stamp adds bytes, so the picked file's size alone is not enough).
 */
export function templateImportText(raw: string, surface: Surface): { kind: "ok"; text: string } | { kind: "error"; message: string } {
  const text = stampSurfaceMarker(raw, surface);
  if (new TextEncoder().encode(text).length > TEMPLATE_FILE_MAX_BYTES) {
    return { kind: "error", message: "That file is larger than 256 KB once the surface marker is added. Templates are short; split the instructions." };
  }
  return { kind: "ok", text };
}
