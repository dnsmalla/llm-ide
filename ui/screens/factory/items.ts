// Work items of the Factory board, stored as facts in `<project>/system/factory/items.json`. A card's column is never
// stored here (see columns.ts): the file holds each item and the run ids it has had, nothing else.
import type { FsApi } from "../explorer/fs";

export const ITEMS_FILE = "system/factory/items.json";
export const ITEMS_SCHEMA_VERSION = 1;
export type ItemsFs = Pick<FsApi, "read" | "write" | "create">;
export type WorkItemSource = "issue" | "spec" | "text";
export type WorkItemProvider = "github" | "gitlab";
export interface WorkItemRecord { key: string; source: WorkItemSource; id: string | null; title: string; body: string; repo: string | null; provider: WorkItemProvider | null; addedAt: string; runIds: string[] }

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCES: readonly string[] = ["issue", "spec", "text"];
const MAX_KEY = 400, MAX_ID = 300, MAX_TITLE = 500, MAX_BODY = 20_000, MAX_REPO = 300, MAX_ITEMS = 500, MAX_RUNS = 50;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function codeOf(e: unknown): string {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
}

/** One stored item, or null when it is malformed. Unknown fields are dropped. */
function decodeItem(raw: unknown): WorkItemRecord | null {
  if (!isRecord(raw)) return null;
  const { key, source, id, title, body, repo, provider, addedAt, runIds } = raw;
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY) return null;
  if (typeof source !== "string" || !SOURCES.includes(source)) return null;
  if (id !== null && (typeof id !== "string" || id.length > MAX_ID)) return null;
  if (typeof title !== "string" || title.trim() === "") return null;
  if (typeof addedAt !== "string") return null;
  return {
    key,
    source: source as WorkItemSource,
    id: id as string | null,
    title: title.slice(0, MAX_TITLE),
    body: typeof body === "string" ? body.slice(0, MAX_BODY) : "",
    repo: typeof repo === "string" && repo.trim() !== "" ? repo.slice(0, MAX_REPO) : null,
    provider: provider === "github" || provider === "gitlab" ? provider : null,
    addedAt,
    runIds: Array.isArray(runIds) ? runIds.filter((r): r is string => typeof r === "string" && RUN_ID.test(r)).slice(-MAX_RUNS) : [],
  };
}

/** `{ schemaVersion, items }`; malformed items and repeated keys are dropped (first wins). */
export function decodeItems(raw: unknown): WorkItemRecord[] {
  const list = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  const out: WorkItemRecord[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const item = decodeItem(row);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export function encodeItems(items: readonly WorkItemRecord[]): string {
  return JSON.stringify({ schemaVersion: ITEMS_SCHEMA_VERSION, items }, null, 2) + "\n";
}

/** A new item. `key` is `${source}:${id}`, or a random id for free text; a text item never dedupes. */
export function newWorkItem(input: { source: WorkItemSource; id: string | null; title: string; body: string; repo: string | null; provider?: WorkItemProvider | null }, now: Date = new Date(), rand: () => number = Math.random): WorkItemRecord {
  const title = input.title.trim().slice(0, MAX_TITLE);
  if (title === "") throw new Error("a work item needs a title");
  const id = input.id?.trim() ? input.id.trim() : null;
  if (input.source !== "text" && id === null) throw new Error(`a ${input.source} work item needs an id`);
  const key = id !== null ? `${input.source}:${id}` : `text:${now.getTime().toString(36)}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}`;
  const repo = input.repo?.trim() ? input.repo.trim().slice(0, MAX_REPO) : null;
  const provider = input.provider === "github" || input.provider === "gitlab" ? input.provider : null;
  return { key, source: input.source, id, title, body: input.body.slice(0, MAX_BODY), repo, provider, addedAt: now.toISOString(), runIds: [] };
}

/** The stored file: items, the hash a write must match, and whether a newer app wrote it. */
async function load(fs: Pick<FsApi, "read">): Promise<{ items: WorkItemRecord[]; hash: string | null; newer: boolean }> {
  let read;
  try {
    read = await fs.read(ITEMS_FILE, 4_000_000);
  } catch (e) {
    const code = codeOf(e);
    if (code === "not_found" || code === "missing") return { items: [], hash: null, newer: false };
    throw e;
  }
  if (read.status !== "ok" || read.text === null) throw new Error(`${ITEMS_FILE} is not readable text.`);
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    throw new Error(`${ITEMS_FILE} is not valid JSON; fix or remove it.`);
  }
  const version = isRecord(raw) && typeof raw.schemaVersion === "number" ? raw.schemaVersion : ITEMS_SCHEMA_VERSION;
  return { items: decodeItems(raw), hash: read.hash ?? null, newer: version > ITEMS_SCHEMA_VERSION };
}

export async function readItems(fs: Pick<FsApi, "read">): Promise<WorkItemRecord[]> {
  return (await load(fs)).items;
}

async function ensureDir(fs: ItemsFs, path: string): Promise<void> {
  try { await fs.create(path, "dir"); } catch (e) { if (codeOf(e) !== "exists") throw e; }
}

/** Every write re-reads and re-applies against the fresh file, so a concurrent writer causes a retry, never a lost item. */
async function mutate<T>(fs: ItemsFs, change: (items: WorkItemRecord[]) => { next: WorkItemRecord[] | null; result: T }): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const cur = await load(fs);
    if (cur.newer) throw new Error(`${ITEMS_FILE} was written by a newer version of the app; it is not changed.`);
    const { next, result } = change(cur.items);
    if (next === null) return result;
    if (cur.hash === null) { await ensureDir(fs, "system"); await ensureDir(fs, "system/factory"); }
    try {
      await fs.write(ITEMS_FILE, encodeItems(next), { expected_hash: cur.hash });
      return result;
    } catch (e) {
      // Another writer (the Issues screen, a second board) changed the file between this read and write: re-read and re-apply.
      if ((codeOf(e) === "conflict" || codeOf(e) === "exists") && attempt < 3) continue;
      throw e;
    }
  }
}

/** Adds one item; an item with the same key (or the same source and id) keeps the stored record. */
export async function addItem(fs: ItemsFs, item: WorkItemRecord): Promise<{ record: WorkItemRecord; existed: boolean }> {
  const clean = decodeItem(item);
  if (!clean) throw new Error("not a valid work item");
  return mutate<{ record: WorkItemRecord; existed: boolean }>(fs, (items) => {
    const found = items.find((i) => i.key === clean.key || (clean.id !== null && i.source === clean.source && i.id === clean.id));
    if (found) return { next: null, result: { record: found, existed: true } };
    if (items.length >= MAX_ITEMS) throw new Error("The Factory holds at most 500 items; discard some first.");
    return { next: [...items, clean], result: { record: clean, existed: false } };
  });
}

/** Appends a run id to an item, once; an unknown key is a no-op. */
export async function attachRun(fs: ItemsFs, key: string, runId: string): Promise<void> {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
  await mutate(fs, (items) => {
    const item = items.find((i) => i.key === key);
    if (!item || item.runIds.includes(runId)) return { next: null, result: undefined };
    const runIds = [...item.runIds, runId].slice(-MAX_RUNS);
    return { next: items.map((i) => (i.key === key ? { ...i, runIds } : i)), result: undefined };
  });
}

/** Removes an item; an unknown key is a no-op. */
export async function removeItem(fs: ItemsFs, key: string): Promise<void> {
  await mutate(fs, (items) => (items.some((i) => i.key === key) ? { next: items.filter((i) => i.key !== key), result: undefined } : { next: null, result: undefined }));
}
