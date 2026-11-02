// Project and session memory for the memory viewer: READ only. Two GET routes on the Node core
// (extension/routes/agent.mjs): /kb/agent/project-memory and /kb/agent/session-memory. Facts are text the model
// wrote, so they are returned as plain strings and rendered as text only. Forget and Clear are not here (HOLD).
import { call, type CoreClient } from "../../settings/core-api.ts";
import { displayLine } from "../scm/model.ts";

export interface ProjectMemory {
  facts: string[];
  /** The allow-listed repo root the core resolved, or null when no candidate was allowed. */
  repo: string | null;
}

/** What the viewer shows. `projectFailed` is a load error for the project section only. */
export interface MemoryLoad {
  /** Null when there was nothing to ask about (no repo candidates and no open folder). */
  project: ProjectMemory | null;
  projectFailed: boolean;
  session: string[];
}

export interface MemoryTarget {
  /** Candidate repo paths the core resolves against its allow-list (the first allowed one wins). */
  repos: readonly string[];
  workspaceRoot?: string | null;
  /** This chat's session id; blank or absent means no session section. */
  sessionId?: string | null;
}

const MAX_FACTS = 1_000;
const MAX_FACT_CHARS = 2_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function factList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new TypeError("memory facts are not a list");
  return raw.filter((f): f is string => typeof f === "string").slice(0, MAX_FACTS).map((f) => f.slice(0, MAX_FACT_CHARS));
}

/** Decodes `{ facts, repo }`; anything else throws, so a malformed reply is never shown as "nothing remembered". */
export function decodeProjectMemory(raw: unknown): ProjectMemory {
  if (!isRecord(raw)) throw new TypeError("project memory reply is not an object");
  return { facts: factList(raw.facts), repo: typeof raw.repo === "string" ? raw.repo : null };
}

/** Decodes `{ facts }`. */
export function decodeSessionMemory(raw: unknown): string[] {
  if (!isRecord(raw)) throw new TypeError("session memory reply is not an object");
  return factList(raw.facts);
}

/** The project route. Each repo candidate is a `repo` parameter, in order; the open folder goes last. */
export function projectMemoryPath(target: Pick<MemoryTarget, "repos" | "workspaceRoot">): string {
  const q = new URLSearchParams();
  for (const r of target.repos) if (r) q.append("repo", r);
  if (target.workspaceRoot) q.set("workspaceRoot", target.workspaceRoot);
  return `/kb/agent/project-memory?${q.toString()}`;
}

export function sessionMemoryPath(sessionId: string): string {
  return `/kb/agent/session-memory?${new URLSearchParams({ sessionId }).toString()}`;
}

/**
 * Loads both sections, as the Mac viewer does. Session memory is best-effort (a failure is an empty list), so a
 * project failure never hides this chat's facts or the reverse. The project section is skipped when there is no
 * candidate at all, which the viewer reads as "open a project folder".
 */
export async function loadMemory(client: CoreClient, target: MemoryTarget, signal?: AbortSignal): Promise<MemoryLoad> {
  const sessionId = (target.sessionId ?? "").trim();
  const wantsProject = target.repos.some((r) => r) || !!target.workspaceRoot;
  const [projectResult, sessionResult] = await Promise.all([
    wantsProject
      ? call(client, "GET", projectMemoryPath(target), undefined, signal).then(decodeProjectMemory).then(
        (project) => ({ project, failed: false }),
        (e: unknown) => {
          if (signal?.aborted) throw e;
          return { project: null, failed: true };
        },
      )
      : Promise.resolve({ project: null, failed: false }),
    sessionId
      ? call(client, "GET", sessionMemoryPath(sessionId), undefined, signal).then(decodeSessionMemory).catch((e: unknown) => {
        if (signal?.aborted) throw e;
        return [] as string[];
      })
      : Promise.resolve([] as string[]),
  ]);
  return { project: projectResult.project, projectFailed: projectResult.failed, session: sessionResult };
}

/** The fact without its `(t:YYYY-MM-DD)` recency stamp, for display (the stamp is shown as a date). Sanitised. */
export function factText(fact: string): string {
  return displayLine(fact.replace(/\s*\(t:\d{4}-\d{2}-\d{2}\)\s*$/, ""));
}

/** The date a fact was learned, from its stamp, or null for a fact stored before stamping existed. */
export function factLearned(fact: string): string | null {
  const m = /\(t:(\d{4}-\d{2}-\d{2})\)\s*$/.exec(fact);
  return m ? m[1] : null;
}
