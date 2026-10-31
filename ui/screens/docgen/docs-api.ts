// Typed calls to the core for Doc Gen: project registration, templates and commands (docs-kit K1 routes,
// `/kb/docs/*`), and generation (`POST /generate-doc`). Takes the shell's core client (token handling, loopback
// guard, timeouts live there). Every path is built from validated pieces; the project is addressed by an id the
// webview derives from the host-reported root, never by a path in a URL.
import type { CoreClient } from "../shell/core";
import { decodeCommands, decodeDeleted, decodeGenerateResult, decodeRegistered, decodeSeed, decodeTemplateWrite, decodeTemplates, type Page } from "./decode.ts";
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
  register(signal?: AbortSignal): Promise<void>;
  templates(signal?: AbortSignal): Promise<Page<DocTemplate>>;
  commands(signal?: AbortSignal): Promise<Page<DocCommand>>;
  putTemplate(folder: string, t: { name: string; sections: string[]; surface: Surface }, signal?: AbortSignal): Promise<DocTemplate>;
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
      decodeRegistered(await client.request("/kb/projects/register", { method: "POST", body: { id: projectId, root: projectRoot }, signal }));
    },
    async templates(signal) {
      return decodeTemplates(await client.request(`/kb/docs/templates${q}`, { signal }));
    },
    async commands(signal) {
      return decodeCommands(await client.request(`/kb/docs/commands${q}`, { signal }));
    },
    async putTemplate(folder, t, signal) {
      return decodeTemplateWrite(await client.request(folderPath("templates", folder), { method: "PUT", body: { name: t.name, sections: t.sections, surface: t.surface }, signal }));
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
