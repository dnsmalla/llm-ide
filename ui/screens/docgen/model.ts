// Doc Gen / Visual request model. Pure (no React, no DOM, no I/O); mirrors the core's limits in
// extension/routes/doc-gen.mjs so the screen refuses what the server would refuse, and can tell the
// user what the server will drop BEFORE a long, billed run.

/** Per-source ceiling on the server (`MAX_SOURCE_CONTENT`). */
export const MAX_SOURCE_CONTENT = 50_000;
/** Smallest slice worth sending; a source that cannot get this much is omitted (`MIN_SOURCE_CONTENT`). */
export const MIN_SOURCE_CONTENT = 200;
/** Total budget for the rendered source block (`MAX_TOTAL_SOURCE_CHARS`). */
export const MAX_TOTAL_SOURCE_CHARS = 400_000;
/** The core names at most this many sources per list in its answer (counts are exact). */
export const MAX_REPORTED_NAMES = 50;
export const MAX_COMMAND = 10_000;
export const MAX_PROMPT = 2_000;
export const MAX_SECTIONS = 30;
/** The core refuses request bodies over 8 MB; stay well under so JSON escaping cannot push us over. */
export const MAX_BODY_CHARS = 5_000_000;
/** Selection cap in the UI (ids only, no content): a guard against a runaway "select all". */
export const MAX_SELECTED_SOURCES = 5_000;

export type Surface = "doc" | "visual";

export interface DocTemplate {
  id: string;
  name: string;
  sections: string[];
  rawContent: string;
  isBuiltin: boolean;
  folderName: string | null;
  isProjectTemplate: boolean;
  surface: Surface;
}

export interface DocCommand {
  id: string;
  name: string;
  instruction: string;
  rawContent: string;
  isBuiltin: boolean;
  folderName: string | null;
  isProjectCommand: boolean;
  surface: Surface;
}

export interface SourcePayload {
  name: string;
  content: string;
}

export interface GenerateBody {
  templateName?: string;
  sections?: string[];
  command?: string;
  prompt?: string;
  sources: SourcePayload[];
}

export interface Selection {
  template: DocTemplate | null;
  /** A saved command's instruction, or free text the user typed. */
  command: string;
  prompt: string;
}

export type ValidationResult = { ok: true; hasTemplate: boolean; hasCommand: boolean } | { ok: false; code: ValidationCode; message: string };
export type ValidationCode = "needs_template_or_command" | "needs_sources" | "command_too_long" | "prompt_too_long" | "body_too_large";

/** Mirror of the core's `validateDocRequest` (template needs name AND at least one section; command needs non-blank text). */
export function validateDocRequest(body: { templateName?: unknown; sections?: unknown; command?: unknown; sources?: unknown }): ValidationResult {
  const hasTemplate = Boolean(body.templateName) && Array.isArray(body.sections) && body.sections.length > 0;
  const hasCommand = typeof body.command === "string" && body.command.trim().length > 0;
  if (!hasTemplate && !hasCommand) return { ok: false, code: "needs_template_or_command", message: "Choose a template or write a command." };
  if (!Array.isArray(body.sources) || body.sources.length === 0) return { ok: false, code: "needs_sources", message: "Select at least one source." };
  return { ok: true, hasTemplate, hasCommand };
}

/** Builds the request body exactly as the core expects; trims, applies the core's caps and omits empty fields. */
export function buildGenerateBody(sel: Selection, sources: readonly SourcePayload[]): { ok: true; body: GenerateBody } | { ok: false; code: ValidationCode; message: string } {
  const body: GenerateBody = { sources: sources.map((s) => ({ name: s.name, content: s.content })) };
  const t = sel.template;
  if (t && t.name && t.sections.length > 0) {
    body.templateName = t.name;
    body.sections = t.sections.slice(0, MAX_SECTIONS);
  }
  const command = sel.command.trim();
  if (command) {
    if (command.length > MAX_COMMAND) return { ok: false, code: "command_too_long", message: `The command is over ${MAX_COMMAND.toLocaleString("en")} characters.` };
    body.command = command;
  }
  const prompt = sel.prompt.trim();
  if (prompt) {
    if (prompt.length > MAX_PROMPT) return { ok: false, code: "prompt_too_long", message: `The request is over ${MAX_PROMPT.toLocaleString("en")} characters.` };
    body.prompt = prompt;
  }
  const v = validateDocRequest(body);
  if (!v.ok) return v;
  let total = 0;
  for (const s of body.sources) total += s.name.length + s.content.length;
  if (total > MAX_BODY_CHARS) return { ok: false, code: "body_too_large", message: "The selected sources are too large to send in one request." };
  return { ok: true, body };
}

// ---- fit estimate ---------------------------------------------------------------------------

export interface FitInput {
  name: string;
  /** Characters the source has (UTF-16 units, as the server counts), or an estimate from bytes. */
  chars: number;
}

export interface FitReport {
  /** Sources the model will see whole. */
  whole: number;
  /** Sources shortened (per-source cap or the shared budget). */
  shortened: number;
  /** Sources the server will not send at all (dropped from the end). */
  omitted: number;
  /** Total characters the model will read (estimate of the packed source block). */
  packedChars: number;
  /** Rough input tokens (chars / 4). */
  tokens: number;
}

const heading = (name: string) => `### ${name}\n`.length;

/**
 * Estimate of what `packSources` will do with these sources, in selection order. Same algorithm (prefix that fits
 * with MIN_SOURCE_CONTENT each, then equal-share water-filling); only the sanitiser's length change is unknown, so
 * treat it as an estimate. O(n log n), no content needed.
 */
export function estimateFit(items: readonly FitInput[], budget = MAX_TOTAL_SOURCE_CHARS): FitReport {
  const sized = items.map((s, i) => ({ i, len: Math.min(Math.max(0, Math.floor(s.chars)), MAX_SOURCE_CONTENT), capped: s.chars > MAX_SOURCE_CONTENT, name: s.name }));
  let keptCount = 0;
  let need = 0;
  for (const it of sized) {
    const step = heading(it.name) + Math.min(MIN_SOURCE_CONTENT, it.len) + (keptCount > 0 ? 2 : 0);
    if (need + step > budget) break;
    need += step;
    keptCount += 1;
  }
  const kept = sized.slice(0, keptCount);
  const omitted = sized.length - keptCount;
  const overhead = kept.reduce((n, it, k) => n + heading(it.name) + (k > 0 ? 2 : 0), 0);
  const contentBudget = budget - overhead;
  const lens = kept.map((k) => k.len);
  const shortenedFlags = kept.map((k) => k.capped);
  if (lens.reduce((a, b) => a + b, 0) > contentBudget) {
    let remaining = contentBudget;
    let pending = kept.length;
    const order = kept.map((_, k) => k).sort((a, b) => lens[a]! - lens[b]!);
    for (const k of order) {
      const share = Math.floor(remaining / pending);
      pending -= 1;
      if (lens[k]! <= share) {
        remaining -= lens[k]!;
        continue;
      }
      lens[k] = share;
      remaining -= share;
      shortenedFlags[k] = true;
    }
  }
  const shortened = shortenedFlags.filter(Boolean).length;
  const packedChars = overhead + lens.reduce((a, b) => a + b, 0);
  return { whole: keptCount - shortened, shortened, omitted, packedChars, tokens: Math.ceil(packedChars / 4) };
}

/** What the core reports back on a 200. */
export interface GenerateResult {
  content: string;
  truncated: string[];
  truncatedCount: number;
  omitted: string[];
  omittedCount: number;
  /** False for a server older than API v52 that does not report what it dropped. */
  reportsFit: boolean;
}

/** Plain-language notice for what the core could not fit; null when everything was sent whole. */
export function fitNotice(r: Pick<GenerateResult, "truncated" | "truncatedCount" | "omitted" | "omittedCount" | "reportsFit">, sentCount: number): string | null {
  if (!r.reportsFit) return sentCount > 20 ? "This core does not report what it dropped; it may have used only the first 20 sources." : null;
  const parts: string[] = [];
  if (r.omittedCount > 0) parts.push(`${r.omittedCount} ${r.omittedCount === 1 ? "source was" : "sources were"} left out${listNames(r.omitted, r.omittedCount)}`);
  if (r.truncatedCount > 0) parts.push(`${r.truncatedCount} ${r.truncatedCount === 1 ? "source was" : "sources were"} shortened to fit${listNames(r.truncated, r.truncatedCount)}`);
  return parts.length ? `${parts.join("; ")}.` : null;
}

function listNames(names: readonly string[], count: number): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, 3).join(", ");
  const more = count - Math.min(3, names.length);
  return ` (${shown}${more > 0 ? ` and ${more} more` : ""})`;
}

/** Characters -> readable size ("1.2 MB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
