// Welcome page logic: new-project name rules, core registration after creation, and the guide text. Pure
// apart from the injected core client, so it is tested with node.
import { projectIdFor } from "../docgen/docs-api";
import { safeText } from "../shell/safe-text";
import type { ProjectInfo } from "../shell/host";

export const NAME_MAX = 80;
/** Language written into a new project's files (the Mac seeds it from the user's preference; the desktop has none yet). */
export const DEFAULT_LANGUAGE = "en";

// The host validates again and is the authority; this gives the user the reason before the folder dialog opens.
const BAD_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const RESERVED = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

export function validateProjectName(raw: string): NameCheck {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { ok: false, error: "Enter a project name." };
  if (Array.from(name).length > NAME_MAX) return { ok: false, error: `Use at most ${NAME_MAX} characters.` };
  if (name.startsWith(".")) return { ok: false, error: "The name cannot start with a dot." };
  if (name.endsWith(".")) return { ok: false, error: "The name cannot end with a dot." };
  if (BAD_CHARS.test(name)) return { ok: false, error: "The name cannot contain / \\ : * ? \" < > | or control characters." };
  if (RESERVED.has(name.split(".")[0]!.toLowerCase())) return { ok: false, error: "That name is reserved by the operating system." };
  return { ok: true, name };
}

export interface RegisterDeps {
  core: { request<T = unknown>(path: string, opts?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> };
  idFor?: (root: string) => Promise<string>;
}

const reason = (e: unknown) => safeText(e instanceof Error ? e.message : String(e), 160) || "unknown error";

/**
 * Registers a project root with the core under the id Doc Gen derives from it. Throws when the core refuses. Opening an
 * existing folder uses this alone: unlike a new project it installs no agent skills into the folder.
 */
export async function registerProject(root: string, deps: RegisterDeps): Promise<void> {
  const id = await (deps.idFor ?? projectIdFor)(root);
  await deps.core.request("/kb/projects/register", { method: "POST", body: { id, root } });
}

/**
 * After the host created the project: register it with the core (the same id Doc Gen derives from the root, so
 * both agree) and install the agent skills kit. Both are best effort, like the Mac app: failures become warnings,
 * never errors, because the project itself is already usable.
 */
export async function registerNewProject(project: ProjectInfo, deps: RegisterDeps): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await registerProject(project.root, deps);
  } catch (e) {
    warnings.push(`It could not be registered with the core yet (${reason(e)}). Doc Gen registers it when you open it.`);
  }
  try {
    const res = await deps.core.request<{ ok?: boolean } | null>("/kb/project/install-skills", { method: "POST", body: { path: project.root, language: DEFAULT_LANGUAGE } });
    if (res && res.ok === false) warnings.push("The agent skills were not installed (the core declined). The project works without them; open it again to retry.");
  } catch (e) {
    warnings.push(`The agent skills were not installed (${reason(e)}). The project works without them; open it again to retry.`);
  }
  return warnings;
}

export interface GuideSection {
  id: string;
  title: string;
  /** Plain text paragraphs, rendered as text. */
  paragraphs: readonly string[];
  steps?: readonly string[];
}


export const PROJECT_EXPLAINER =
  "A project is a folder. system/ holds the data LLM-IDE manages and llm-doc/ holds the notes it writes for you, next to your own source, code and data. Choose a new folder to start, an existing project to resume, or a cloned code repo: LLM-IDE adds what it needs without overwriting your files.";
