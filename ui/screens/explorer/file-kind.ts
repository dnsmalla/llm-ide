// The Mac FileIconKit grouping shared by every desktop file/folder tree: one colour and glyph family
// per kind, so Explorer and Library do not drift.
import type { IconName } from "@llmide/ui-kit";

export type FileKind = "code" | "config" | "doc" | "image" | "data" | "other";
const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "swift", "py", "go", "rs", "rb", "java", "kt", "c", "h", "cpp", "m", "mm", "sh", "bash", "zsh", "html", "htm", "css", "scss", "sql", "xml"]);
const CONFIG_EXT = new Set(["json", "yml", "yaml", "toml", "ini", "cfg", "conf", "env"]);
const DOC_EXT = new Set(["md", "markdown", "txt", "log", "pdf", "doc", "docx", "pages"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "tiff", "bmp"]);
const DATA_EXT = new Set(["csv", "tsv", "xlsx", "xls", "numbers"]);

/** The Mac FileIconKit grouping: one colour and glyph family per file kind. */
export function fileKind(name: string, isDir = false): FileKind | "folder" {
  if (isDir) return "folder";
  const dot = name.lastIndexOf(".");
  const ext = (dot > 0 ? name.slice(dot + 1) : name).toLowerCase();
  if (name.toLowerCase() === "dockerfile" || name.toLowerCase() === "makefile") return "code";
  if (CODE_EXT.has(ext)) return "code";
  if (CONFIG_EXT.has(ext)) return "config";
  if (DOC_EXT.has(ext)) return "doc";
  if (IMAGE_EXT.has(ext)) return "image";
  if (DATA_EXT.has(ext)) return "data";
  return "other";
}

export function fileKindIcon(kind: FileKind | "folder"): IconName {
  if (kind === "code") return "file-code";
  if (kind === "doc") return "file-text";
  if (kind === "image") return "images";
  if (kind === "data") return "table";
  return "file-text";
}

