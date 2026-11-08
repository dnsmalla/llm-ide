// Typed calls to the core for Doc Gen: project registration, templates and commands (docs-kit K1 routes,
// `/kb/docs/*`), and generation (`POST /generate-doc`). Takes the shell's core client (token handling, loopback
// guard, timeouts live there). Every path is built from validated pieces; the project is addressed by an id the
// webview derives from the host-reported root, never by a path in a URL.
import type { CoreClient } from "../shell/core";
import { decodeCommandWrite, decodeCommands, decodeDeleted, decodeGenerateResult, decodeRegistered, decodeSeed, decodeTemplateWrite, decodeTemplates, type Page } from "./decode.ts";
import type { DocCommand, DocTemplate, GenerateBody, GenerateResult, Surface } from "./model.ts";

export type DocsClient = Pick<CoreClient, "request">;

/** The core's `PROJECT_ID_RE`. */
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** The core's folder-name rule is enforced server side; this is a cheap local pre-check. */
export const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** No client-side deadline for generation (the core has none either; cancel is the user's control). */
const GENERATE_TIMEOUT_MS = 60 * 60 * 1000;

/** Stable project id from the host-reported root: `p` + 32 hex of SHA-256. Same root, same id. */
export async function projectIdFor(root: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(root));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `p${hex.slice(0, 32)}`;
}

export interface DocsApi {
  register(signal?: AbortSignal): Promise<{ id: string }>;
  templates(signal?: AbortSignal): Promise<Page<DocTemplate>>;
  commands(signal?: AbortSignal): Promise<Page<DocCommand>>;
  putTemplate(folder: string, t: { name: string; sections: string[]; surface: Surface; rawContent?: string; createOnly?: boolean }, signal?: AbortSignal): Promise<DocTemplate>;
  putCommand(folder: string, c: { name: string; instruction: string; surface: Surface; createOnly?: boolean }, signal?: AbortSignal): Promise<DocCommand>;
  deleteCommand(folder: string, signal?: AbortSignal): Promise<boolean>;
  deleteTemplate(folder: string, signal?: AbortSignal): Promise<boolean>;
  seed(signal?: AbortSignal): Promise<{ written: number }>;
  generate(body: GenerateBody, signal: AbortSignal): Promise<GenerateResult>;
}

export function createDocsApi(client: DocsClient, projectId: string, projectRoot: string): DocsApi {
  if (!PROJECT_ID_RE.test(projectId)) throw new Error("invalid project id");
  const q = `?project=${encodeURIComponent(projectId)}`;
  const folderPath = (kind: "templates" | "commands", folder: string) => {
    if (!FOLDER_RE.test(folder)) throw Object.assign(new Error("invalid folder"), { code: "INVALID_FOLDER", status: 400 });
    return `/kb/docs/${kind}/${encodeURIComponent(folder)}${q}`;
  };
  return {
    async register(signal) {
      // R-021 #4: the server issues a new project's id; report it so the caller can address the project with it.
      const registered = decodeRegistered(await client.request("/kb/projects/register", { method: "POST", body: { id: projectId, root: projectRoot }, signal }));
      return { id: registered.id };
    },
    async templates(signal) {
      return decodeTemplates(await client.request(`/kb/docs/templates${q}`, { signal }));
    },
    async commands(signal) {
      return decodeCommands(await client.request(`/kb/docs/commands${q}`, { signal }));
    },
    async putTemplate(folder, t, signal) {
      // rawContent: an import stores the whole file as written (the core keeps it verbatim; rawContent wins over rewrite).
      // Otherwise rewrite: the core keeps the template.md body (the instructions) and changes only its title and ## sections.
      // Without it an edit regenerates the file from the section list and drops the body.
      // createOnly (API 106): the core answers 409 TEMPLATE_EXISTS for an existing folder. Sent only when set, so an
      // edit's body is unchanged. An older core ignores the field.
      const body = t.rawContent !== undefined
        ? { name: t.name, surface: t.surface, rawContent: t.rawContent, ...(t.createOnly ? { createOnly: true } : {}) }
        : { name: t.name, sections: t.sections, surface: t.surface, rewrite: true, ...(t.createOnly ? { createOnly: true } : {}) };
      return decodeTemplateWrite(await client.request(folderPath("templates", folder), { method: "PUT", body, signal }));
    },
    async putCommand(folder, c, signal) {
      const body = { name: c.name, instruction: c.instruction, surface: c.surface, ...(c.createOnly ? { createOnly: true } : {}) };
      return decodeCommandWrite(await client.request(folderPath("commands", folder), { method: "PUT", body, signal }));
    },
    async deleteCommand(folder, signal) {
      return decodeDeleted(await client.request(folderPath("commands", folder), { method: "DELETE", signal }));
    },
    async deleteTemplate(folder, signal) {
      return decodeDeleted(await client.request(folderPath("templates", folder), { method: "DELETE", signal }));
    },
    async seed(signal) {
      return decodeSeed(await client.request(`/kb/docs/seed${q}`, { method: "POST", body: {}, signal }));
    },
    async generate(body, signal) {
      return decodeGenerateResult(await client.request("/generate-doc", { method: "POST", body, signal, timeoutMs: GENERATE_TIMEOUT_MS }));
    },
  };
}

/** Folder name for a new template from its display name (lowercase, dashes); null when nothing usable remains. */
export function folderForName(name: string): string | null {
  const s = name
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return FOLDER_RE.test(s) ? s : null;
}
