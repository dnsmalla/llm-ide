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
 * After the host created the project: register it with the core (the same id Doc Gen derives from the root, so
 * both agree) and install the agent skills kit. Both are best effort, like the Mac app: failures become warnings,
 * never errors, because the project itself is already usable.
 */
export async function registerNewProject(project: ProjectInfo, deps: RegisterDeps): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const id = await (deps.idFor ?? projectIdFor)(project.root);
    await deps.core.request("/kb/projects/register", { method: "POST", body: { id, root: project.root } });
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

/** Condensed from the Mac app's Help & Guide (capture, notes, projects), adapted to what the desktop app has today. */
export const GUIDE: readonly GuideSection[] = [
  {
    id: "overview",
    title: "What LLM-IDE does",
    paragraphs: [
      "LLM-IDE captures meeting captions, turns them into structured notes, action items and summaries, and keeps them next to your documents and code so you can search, plan and generate from one place.",
      "Everything runs on this computer: the account, the notes and the server are local.",
    ],
  },
  {
    id: "capture",
    title: "Capture",
    paragraphs: [
      "Live capture reads captions from your meeting. Zoom and Teams desktop apps are captured by the Mac app; Google Meet, Teams web and Zoom web use the Chrome extension. Both share this account and server.",
    ],
    steps: [
      "Join a meeting and turn on captions or subtitles.",
      "Start capture in the Mac app or the Chrome extension.",
      "When the meeting ends, stop capture. Notes are generated for you.",
      "Find the notes in Library.",
    ],
  },
  {
    id: "notes",
    title: "Notes and the Library",
    paragraphs: [
      "The Library is your home base for notes. It lists every meeting note, document and plugin of the current project in one searchable list. Each meeting note is a markdown file with a summary, action items and the transcript.",
    ],
  },
  {
    id: "projects",
    title: "Projects",
    paragraphs: [
      "A project is a folder on your computer. Inside it, system/ holds the data LLM-IDE manages for itself (settings, caches, the code graph) and llm-doc/ holds the notes and plans it writes for you, next to your own source/, code/ and data/ folders.",
      "Create a new project to start fresh: pick where it should live and give it a name, and LLM-IDE sets up the folders. Open an existing project to continue, or pick a folder you already have: LLM-IDE adds what it needs and does not overwrite your files.",
      "Closing a project or removing it from the recent list never deletes anything on disk.",
    ],
  },
  {
    id: "first",
    title: "First steps",
    paragraphs: [],
    steps: [
      "Sign in with your LLM-IDE account (create one the first time).",
      "Create or open a project.",
      "Browse its files in Explorer, ask questions in Chat, find notes in Library.",
    ],
  },
];

export const PROJECT_EXPLAINER =
  "A project is a folder. system/ holds the data LLM-IDE manages and llm-doc/ holds the notes it writes for you, next to your own source, code and data. Choose a new folder to start, an existing project to resume, or a cloned code repo: LLM-IDE adds what it needs without overwriting your files.";
