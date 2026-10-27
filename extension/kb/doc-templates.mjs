// Doc Gen template and command logic — PURE (no disk, no DB).
//
// Port of the Swift models that own the project-folder file format:
//   mac/Sources/LlmIdeMac/Core/Generation/Models/DocTemplate.swift
//   mac/Sources/LlmIdeMac/Core/Generation/Models/DocCommand.swift
//   mac/Sources/LlmIdeMac/Core/Generation/Models/TemplateSurface.swift
// Every function names the Swift function it mirrors. The on-disk bytes are
// the contract: an older Mac build must read what this module writes (see
// docs/kits/docs-kit.md §5a), so `renderTemplateMarkdown` /
// `renderCommandMarkdown` must produce byte-identical output to the Swift
// `renderedMarkdown()` for the same input. The golden tests pin that.
//
// Disk IO lives in kb/doc-project-files.mjs; this file only turns text into
// objects and objects into text.

import { createHash } from 'node:crypto';

export const TEMPLATE_MARKER = '<!-- llmide:doc-template -->';
export const COMMAND_MARKER = '<!-- llmide:doc-command -->';
export const INGEST_TEMPLATE_STEM = 'llmide:ingest-template';

export const SURFACES = Object.freeze(['doc', 'visual']);
export const DEFAULT_SURFACE = 'doc';

const SURFACE_LABEL = Object.freeze({ doc: 'Doc Gen', visual: 'Visual' });

// Swift `Character.isNewline` / `components(separatedBy: .newlines)`: a CRLF
// pair is ONE separator, and the other Unicode line breaks split too.
const NEWLINE_RE = new RegExp("\\r\\n|[\\n\\r\\v\\f\\u0085\\u2028\\u2029]");

// Swift `.whitespaces` (Zs + tab) — NOT including newlines.
const WS_RE = /^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu;

function trimWs(s) {
  return s.replace(WS_RE, '');
}

/** Lines exactly as Swift splits them (CRLF is one separator). */
export function splitLines(text) {
  return String(text).split(NEWLINE_RE);
}

/** `TemplateSurface`: an unknown or absent value is Doc Gen. */
export function normalizeSurface(value) {
  return SURFACES.includes(value) ? value : DEFAULT_SURFACE;
}

/** `TemplateSurfaceMarker.line(base:surface:)`. `.doc` writes the bare marker. */
export function surfaceMarkerLine(base, surface) {
  const s = normalizeSurface(surface);
  if (s === DEFAULT_SURFACE) return base;
  const inner = trimWs(base.replaceAll('<!--', '').replaceAll('-->', ''));
  return `<!-- ${inner} surface=${s} -->`;
}

function markerStem(base) {
  return trimWs(base.replaceAll('<!--', '').replaceAll('-->', ''));
}

/** `TemplateSurfaceMarker.surface(in:base:)`. First marker line wins. */
export function readSurface(markdown, base) {
  const stem = markerStem(base);
  for (const raw of splitLines(markdown)) {
    const line = trimWs(raw);
    if (!line.startsWith('<!--') || !line.includes(stem)) continue;
    const at = line.indexOf('surface=');
    if (at < 0) return DEFAULT_SURFACE;
    const value = line.slice(at + 'surface='.length).split(/[\t\p{Zs}\n\r\v\f>-]/u)[0];
    // An unrecognised value falls back to Doc Gen rather than hiding the file.
    return SURFACES.includes(value) ? value : DEFAULT_SURFACE;
  }
  return DEFAULT_SURFACE;
}

/** `TemplateSurfaceMarker.ensure(in:base:surface:)`: stamp, replacing any marker. */
export function ensureSurfaceMarker(markdown, base, surface) {
  const stem = markerStem(base);
  const marker = surfaceMarkerLine(base, surface);
  const lines = splitLines(markdown);
  const idx = lines.findIndex((l) => {
    const t = trimWs(l);
    return t.startsWith('<!--') && t.includes(stem);
  });
  if (idx >= 0) {
    lines[idx] = marker;
    return lines.join('\n');
  }
  const titleIdx = lines.findIndex((l) => trimWs(l).startsWith('# '));
  if (titleIdx >= 0) {
    lines.splice(titleIdx + 1, 0, '', marker);
  } else {
    lines.splice(0, 0, marker, '');
  }
  return lines.join('\n');
}

/**
 * Swift `String.capitalized` for a folder slug: `release-notes` → `Release Notes`.
 * Good enough for ASCII slugs; Unicode case rules may differ at word edges.
 */
export function humanizeFolder(folderName) {
  return String(folderName)
    .replaceAll('-', ' ')
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/**
 * Derive a filesystem-safe slug from a display name (`DocTemplate.slug(for:)`,
 * `DocCommand.slug(for:)`). Keeps letters, digits and `-`; spaces become `-`.
 * Unicode letters are kept, as Swift's `CharacterSet.alphanumerics` keeps them.
 */
export function slugFor(name, kind = 'template') {
  let slug = String(name).toLowerCase().replaceAll(' ', '-');
  slug = Array.from(slug).filter((c) => /[\p{L}\p{N}-]/u.test(c)).join('');
  while (slug.includes('--')) slug = slug.replaceAll('--', '-');
  slug = slug.replace(/^-+|-+$/g, '');
  return slug || (kind === 'command' ? 'command' : 'template');
}

/**
 * A slug for `name` that is free in `existing` (a Set of folder names):
 * `base`, then `base-2`, `base-3`, ... (`uniqueFolderSlug` in the Swift stores).
 */
export function uniqueSlug(base, existing) {
  let slug = base;
  let n = 2;
  while (existing.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

/** `slugFor` + `uniqueSlug`: the folder a new template or command is written to. */
export function slugForUnique(name, existing, kind = 'template') {
  return uniqueSlug(slugFor(name, kind), existing);
}

/**
 * Stable id for a project folder across rescans (`stableID(forFolder:)`).
 * SHA-256 of a kind-namespaced folder name, first 16 bytes, version-4 and
 * variant bits set, formatted as an uppercase UUID (Swift's `uuidString`).
 */
export function stableId(folderName, kind = 'template') {
  const ns = kind === 'command' ? 'llmide.doc-command.' : 'llmide.doc-template.';
  const digest = createHash('sha256').update(ns + folderName, 'utf8').digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * `DocTemplate.sections(from:)`: every line that starts with `## ` is a
 * section; no headings means one section named `Content`.
 */
export function sectionsFrom(markdown) {
  const headings = splitLines(markdown)
    .filter((l) => l.startsWith('## '))
    .map((l) => trimWs(l.slice(3)))
    .filter((s) => s !== '');
  return headings.length ? headings : ['Content'];
}

/**
 * `DocTemplate.displayName(from:folderName:)`. The first `# ` line with a
 * non-empty title wins; a `# ` line with an empty title is skipped.
 */
export function templateDisplayName(markdown, folderName) {
  for (const line of splitLines(markdown)) {
    if (line.startsWith('# ')) {
      const title = trimWs(line.slice(2));
      if (title !== '') return title;
    }
  }
  return humanizeFolder(folderName);
}

/**
 * `DocTemplate.markdownBody(name:sections:surface:)`: the file written for a
 * template with no raw content. Section headings are followed by one blank
 * line; the file ends with a single newline after the last heading.
 */
export function renderTemplateBody(name, sections, surface = DEFAULT_SURFACE) {
  const s = normalizeSurface(surface);
  const lines = [
    `# ${name}`,
    '',
    surfaceMarkerLine(TEMPLATE_MARKER, s),
    '',
    `Template for ${SURFACE_LABEL[s]}. Edit the \`##\` sections below to change structure.`,
    '',
  ];
  for (const section of sections) {
    if (section === '') continue;
    lines.push(`## ${section}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** `DocTemplate.renderedMarkdown()`: raw content when present, else the body. */
export function renderTemplateMarkdown({ rawContent, name, sections, surface }) {
  if (typeof rawContent === 'string' && rawContent !== '') return rawContent;
  return renderTemplateBody(name, sections, surface);
}

/**
 * `DocTemplate.rewriting(raw:name:sections:)`. Applies an edited title and
 * section list to an existing template file WITHOUT losing body text: the
 * title line is replaced, everything before the first `## ` is kept, each
 * surviving section keeps its text in the new order, a removed section goes
 * with its text, an added one is an empty heading. Duplicate names keep their
 * bodies in order.
 */
export function rewriteTemplateMarkdown(raw, name, sections) {
  const lines = splitLines(raw);
  const trimmedName = trimWs(String(name));
  const titleIdx = lines.findIndex((l) => l.startsWith('# '));
  if (titleIdx >= 0) {
    lines[titleIdx] = `# ${trimmedName}`;
  } else if (trimmedName !== '') {
    lines.splice(0, 0, `# ${trimmedName}`, '');
  }
  const preamble = [];
  const blocks = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      blocks.push({ heading: trimWs(line.slice(3)), body: [] });
    } else if (blocks.length === 0) {
      preamble.push(line);
    } else {
      blocks[blocks.length - 1].body.push(line);
    }
  }
  const byName = new Map();
  for (const b of blocks) {
    if (!byName.has(b.heading)) byName.set(b.heading, []);
    byName.get(b.heading).push(b.body);
  }
  trimRunOfBlankLines(preamble);
  if (preamble[preamble.length - 1] !== '') preamble.push('');
  const out = [...preamble];
  for (const raw2 of sections) {
    const section = trimWs(String(raw2));
    if (section === '') continue;
    out.push(`## ${section}`);
    const queue = byName.get(section);
    if (queue && queue.length) {
      const kept = queue.shift();
      trimRunOfBlankLines(kept);
      if (kept[kept.length - 1] !== '') kept.push('');
      out.push(...kept);
    } else {
      out.push('');
    }
  }
  return out.join('\n');
}

// Swift: `while x.count > 1, x.last == "", x[x.count-2] == "" { removeLast }`.
function trimRunOfBlankLines(arr) {
  while (arr.length > 1 && arr[arr.length - 1] === '' && arr[arr.length - 2] === '') {
    arr.pop();
  }
}

// ---------------------------------------------------------------------------
// Commands (DocCommand)
// ---------------------------------------------------------------------------

/** `DocCommand.isTitleLine`: the first line whose trimmed form starts `# `. */
function isCommandTitleLine(line) {
  return trimWs(line).startsWith('# ');
}

function commandTitleText(line) {
  return trimWs(trimWs(line).slice(2));
}

/**
 * `DocCommand.instruction(from:)`: the body with the FIRST `# ` line (the
 * title) and every marker line removed. Later `# ` lines (a markdown H1, a
 * fenced shell comment) are content and are kept.
 */
export function commandInstruction(markdown) {
  let titleDropped = false;
  const kept = [];
  for (const line of splitLines(markdown)) {
    if (!titleDropped && isCommandTitleLine(line)) {
      titleDropped = true;
      continue;
    }
    const t = trimWs(line);
    if (t.startsWith('<!--') && t.includes('llmide:doc-command')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/** `DocCommand.displayName(from:folderName:)`: the first title line only. */
export function commandDisplayName(markdown, folderName) {
  const line = splitLines(markdown).find(isCommandTitleLine);
  if (line !== undefined) {
    const title = commandTitleText(line);
    if (title !== '') return title;
  }
  return humanizeFolder(folderName);
}

/**
 * `DocCommand.markdownBody(name:instruction:surface:)`. No trailing newline:
 * the Swift multi-line literal does not end with one.
 */
export function renderCommandBody(name, instruction, surface = DEFAULT_SURFACE) {
  return [
    `# ${name}`,
    '',
    surfaceMarkerLine(COMMAND_MARKER, surface),
    '',
    instruction,
  ].join('\n');
}

/** `DocCommand.renderedMarkdown()`: raw content when present, else the body. */
export function renderCommandMarkdown({ rawContent, name, instruction, surface }) {
  if (typeof rawContent === 'string' && rawContent !== '') return rawContent;
  return renderCommandBody(name, instruction, surface);
}

/**
 * Whether a template file is an ingest layout (`IngestTemplateRenderer`
 * `{{placeholder}}` templates). The scanner skips these: they are not Doc Gen
 * material.
 */
export function isIngestTemplate(markdown) {
  return String(markdown).includes(INGEST_TEMPLATE_STEM);
}

/** Folder names a project template or command may not use (`auto_task` is Auto Task's). */
export const RESERVED_TEMPLATE_FOLDERS = Object.freeze(['auto_task']);

/** Shape of a folder name a route may write: letters/digits first, then letters, digits, `_`, `-`. */
export const FOLDER_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u;

/**
 * Presentation object for a scanned or written template (mirrors `DocTemplate`
 * Codable, so the Mac decoder reads it with no new model).
 */
export function templateRecord({ folderName, content }) {
  return {
    id: stableId(folderName, 'template'),
    name: templateDisplayName(content, folderName),
    sections: sectionsFrom(content),
    rawContent: content,
    isBuiltin: false,
    folderName,
    isProjectTemplate: true,
    surface: readSurface(content, TEMPLATE_MARKER),
  };
}

/** Presentation object for a scanned or written command (mirrors `DocCommand`). */
export function commandRecord({ folderName, content }) {
  return {
    id: stableId(folderName, 'command'),
    name: commandDisplayName(content, folderName),
    instruction: commandInstruction(content),
    rawContent: content,
    isBuiltin: false,
    folderName,
    isProjectCommand: true,
    surface: readSurface(content, COMMAND_MARKER),
  };
}

/** Name order as the Swift stores sort: `localizedCaseInsensitiveCompare`. */
export function compareNames(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}
