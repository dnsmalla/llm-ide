// Strict decoders for the core's Doc Gen answers (schema/http/docs.schema.json, notes-generation.schema.json).
// Unknown or malformed fields are dropped, never trusted: a bad item is skipped rather than failing the list.
import { MAX_REPORTED_NAMES, type DocCommand, type DocTemplate, type GenerateResult, type Surface } from "./model.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 100_000): string => (typeof v === "string" ? v.slice(0, max) : "");
const count = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_REPORTED_NAMES).map((x) => x.slice(0, 200)) : []);
const surface = (v: unknown): Surface => (v === "visual" ? "visual" : "doc");

export class DecodeError extends Error {
  readonly code = "BAD_RESPONSE";
  readonly status = 502;
  constructor(what: string) {
    super(`unreadable ${what}`);
    this.name = "DecodeError";
  }
}

export function decodeGenerateResult(v: unknown): GenerateResult {
  if (!isRecord(v) || typeof v.content !== "string") throw new DecodeError("generate-doc answer");
  const truncated = names(v.truncated);
  const omitted = names(v.omitted);
  const reportsFit = "truncatedCount" in v || "omittedCount" in v || "truncated" in v || "omitted" in v;
  return {
    content: v.content,
    truncated,
    truncatedCount: count(v.truncatedCount, truncated.length),
    omitted,
    omittedCount: count(v.omittedCount, omitted.length),
    reportsFit,
  };
}

export function decodeTemplate(v: unknown): DocTemplate | null {
  if (!isRecord(v) || typeof v.name !== "string" || v.name === "") return null;
  const sections = Array.isArray(v.sections) ? v.sections.filter((s): s is string => typeof s === "string").slice(0, 100).map((s) => s.slice(0, 200)) : [];
  return {
    id: str(v.id, 200) || str(v.folderName, 200) || v.name,
    name: v.name.slice(0, 200),
    sections,
    rawContent: str(v.rawContent, 600_000),
    isBuiltin: v.isBuiltin === true,
    folderName: typeof v.folderName === "string" ? v.folderName : null,
    isProjectTemplate: v.isProjectTemplate === true,
    surface: surface(v.surface),
  };
}

export function decodeCommand(v: unknown): DocCommand | null {
  if (!isRecord(v) || typeof v.name !== "string" || v.name === "") return null;
  return {
    id: str(v.id, 200) || str(v.folderName, 200) || v.name,
    name: v.name.slice(0, 200),
    instruction: str(v.instruction, 20_000),
    rawContent: str(v.rawContent, 600_000),
    isBuiltin: v.isBuiltin === true,
    folderName: typeof v.folderName === "string" ? v.folderName : null,
    isProjectCommand: v.isProjectCommand === true,
    surface: surface(v.surface),
  };
}

export interface Page<T> {
  items: T[];
  truncated: boolean;
}

export function decodeTemplates(v: unknown): Page<DocTemplate> {
  if (!isRecord(v) || !Array.isArray(v.templates)) throw new DecodeError("templates list");
  return { items: v.templates.map(decodeTemplate).filter((t): t is DocTemplate => t !== null), truncated: v.truncated === true };
}

export function decodeCommands(v: unknown): Page<DocCommand> {
  if (!isRecord(v) || !Array.isArray(v.commands)) throw new DecodeError("commands list");
  return { items: v.commands.map(decodeCommand).filter((c): c is DocCommand => c !== null), truncated: v.truncated === true };
}

export function decodeTemplateWrite(v: unknown): DocTemplate {
  const t = isRecord(v) ? decodeTemplate(v.template) : null;
  if (!t) throw new DecodeError("template");
  return t;
}

export function decodeDeleted(v: unknown): boolean {
  if (!isRecord(v) || typeof v.deleted !== "boolean") throw new DecodeError("delete answer");
  return v.deleted;
}

export function decodeSeed(v: unknown): { written: number } {
  if (!isRecord(v) || !Array.isArray(v.written)) throw new DecodeError("seed answer");
  return { written: count(v.count, v.written.length) };
}

export function decodeRegistered(v: unknown): void {
  if (!isRecord(v)) throw new DecodeError("register answer");
}
