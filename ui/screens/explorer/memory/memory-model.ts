// Project and session memory for the memory viewer. Two GET routes and two DELETE routes on the Node core
// (extension/routes/agent.mjs): /kb/agent/project-memory and /kb/agent/session-memory. Facts are text the model
// wrote, so they are returned as plain strings and rendered as text only. The writes are explicit, one fact or one section at a time.
import { call, type CoreClient } from "../../settings/core-api.ts";
import { displayLine } from "../scm/model.ts";
import { isRecord } from "../../../kit/src/decode.ts";

export interface ProjectMemory {
  facts: string[];
  /** Facts whose cited files are all gone from the project (API 155; empty from an older core). */
  stale: string[];
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


function factList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new TypeError("memory facts are not a list");
  return raw.filter((f): f is string => typeof f === "string").slice(0, MAX_FACTS).map((f) => f.slice(0, MAX_FACT_CHARS));
}

/** Decodes `{ facts, repo }`; anything else throws, so a malformed reply is never shown as "nothing remembered". */
export function decodeProjectMemory(raw: unknown): ProjectMemory {
  if (!isRecord(raw)) throw new TypeError("project memory reply is not an object");
  return { facts: factList(raw.facts), repo: typeof raw.repo === "string" ? raw.repo : null, stale: Array.isArray(raw.stale) ? factList(raw.stale) : [] };
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


/** The project facts in a DELETE reply. Throws on a malformed reply rather than showing a false empty list. */
export function decodeProjectFacts(raw: unknown): string[] {
  if (!isRecord(raw)) throw new TypeError("project memory reply is not an object");
  return factList(raw.facts);
}

/** Removes one project fact; returns the remaining facts. The untouched fact (with its stamp) is sent back. */
export async function deleteProjectFact(client: CoreClient, target: Pick<MemoryTarget, "workspaceRoot">, repo: string, fact: string, signal?: AbortSignal): Promise<string[]> {
  const body: Record<string, unknown> = { repo, fact };
  if (target.workspaceRoot) body.workspaceRoot = target.workspaceRoot;
  return decodeProjectFacts(await call(client, "DELETE", "/kb/agent/project-memory", body, signal));
}

/** Clears every project fact; returns the remaining facts (normally []). */
export async function clearProjectFacts(client: CoreClient, target: Pick<MemoryTarget, "workspaceRoot">, repo: string, signal?: AbortSignal): Promise<string[]> {
  const body: Record<string, unknown> = { repo, all: true };
  if (target.workspaceRoot) body.workspaceRoot = target.workspaceRoot;
  return decodeProjectFacts(await call(client, "DELETE", "/kb/agent/project-memory", body, signal));
}

/** Deletes this chat's session memory. Needs no repo: session memory is keyed by the chat session. */
export async function forgetSessionMemory(client: CoreClient, sessionId: string, signal?: AbortSignal): Promise<void> {
  await call(client, "DELETE", "/kb/agent/session-memory", { sessionId }, signal);
}

// ── Inbox: learned knowledge from another project (plan 2026-11-19, phase 5) ──
// GET/POST /kb/agent/self-improvement/inbox. Items are untrusted text from another project: rendered as text only,
// and nothing is used until the user adopts it.
export interface InboxSource {
  name: string;
  projectName: string;
  memory: string[];
  notes: string[];
  /** Waiting on the Loop page. */
  lessons: number;
  changes: number;
}
export interface Inbox { repo: string | null; moved: string | null; sources: InboxSource[] }

const MAX_NOTE_CHARS = 4_000;
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

export function decodeInbox(raw: unknown): Inbox {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) throw new TypeError("inbox reply is not an object");
  const sources = raw.sources.filter(isRecord).slice(0, 50).flatMap((s): InboxSource[] => (typeof s.name === "string" ? [{
    name: s.name.slice(0, 100),
    projectName: displayLine(typeof s.projectName === "string" ? s.projectName.slice(0, 100) : s.name),
    memory: Array.isArray(s.memory) ? factList(s.memory) : [],
    notes: Array.isArray(s.notes) ? s.notes.filter((n): n is string => typeof n === "string").slice(0, 200).map((n) => n.slice(0, MAX_NOTE_CHARS)) : [],
    lessons: count(s.lessons), changes: count(s.changes),
  }] : []));
  return { repo: typeof raw.repo === "string" ? raw.repo : null, moved: typeof raw.moved === "string" ? raw.moved : null, sources };
}

export function inboxPath(target: Pick<MemoryTarget, "repos" | "workspaceRoot">): string {
  return projectMemoryPath(target).replace("/kb/agent/project-memory?", "/kb/agent/self-improvement/inbox?");
}

export async function loadInbox(client: CoreClient, target: Pick<MemoryTarget, "repos" | "workspaceRoot">, signal?: AbortSignal): Promise<Inbox> {
  return decodeInbox(await call(client, "GET", inboxPath(target), undefined, signal));
}

export async function decideInbox(client: CoreClient, target: Pick<MemoryTarget, "workspaceRoot">, repo: string,
  item: { source: string; kind: "memory" | "note"; key: string; action: "adopt" | "dismiss" }, signal?: AbortSignal): Promise<Inbox> {
  const body: Record<string, unknown> = { repo, ...item };
  if (target.workspaceRoot) body.workspaceRoot = target.workspaceRoot;
  return decodeInbox(await call(client, "POST", "/kb/agent/self-improvement/inbox", body, signal));
}

/** The first line of a note section without its `## `, for display. */
export function noteTitle(note: string): string {
  return displayLine(note.split("\n")[0].replace(/^##\s*/, ""));
}
