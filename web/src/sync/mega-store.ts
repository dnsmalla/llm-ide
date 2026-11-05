// The browser's view of the MEGA sync folder (design 8.3; the desktop side is extension/connectors/sync-store/mega.mjs).
// It logs in to the dedicated account with a password typed this session; megajs drops the password after deriving the
// key and nothing here keeps it. Reads take the newest node of a name (the desktop replaces by upload-then-delete).
// Writes create only new, uniquely named files and never replace or delete anything (one writer per file, design 3).
import type { DeviceStore } from "./device.ts";

export interface OpenedStore extends DeviceStore { close(): Promise<void> }
export const MAX_FILE_BYTES = 1048576 + 4096;
const SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const RATE_LIMITED = new Set([-3, -4, -6, -18, -19]); // EAGAIN, ERATELIMIT, ETOOMANY, ETEMPUNAVAIL, ETOOMANYCONNECTIONS
const NETWORK_RE = /Failed to fetch|NetworkError|Load failed|fetch failed/i;

export class SyncStoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "SyncStoreError"; }
}

export function checkPath(path: string): string[] {
  const segs = typeof path === "string" ? path.split("/") : [];
  if (segs.length < 1 || segs.length > 6 || segs.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) throw new SyncStoreError("SYNC_BAD_PATH");
  return segs;
}

/** megajs reports API errors as plain Errors whose message reads "ENAME (-n): ..." (its ERRORS table). */
export const megaErrorNumber = (e: unknown): number | null => {
  const m = /\((-\d+)\)/.exec(String((e as Error | undefined)?.message ?? ""));
  return m ? Number(m[1]) : null;
};

/** The SP1 table (extension/connectors/sync-store/mega.mjs classifyMegaError), with browsers' fetch failure texts. */
export function classifyMegaError(e: unknown, duringLogin = false): string {
  const n = megaErrorNumber(e);
  const text = String((e as Error | undefined)?.message ?? "");
  if (n === -15) return "SYNC_SESSION_EXPIRED";
  if (n === -26) return "SYNC_MFA_REQUIRED";
  if ((n !== null && RATE_LIMITED.has(n)) || /maybe caused by rate limit/.test(text)) return "SYNC_RATE_LIMITED";
  if (n === -17 || n === -24 || /returned a 509 status/.test(text)) return "SYNC_QUOTA";
  if (n === -16) return "SYNC_AUTH_FAILED"; // EBLOCKED
  if (duringLogin && (n === -9 || /invalid credentials|Account version not supported/.test(text))) return "SYNC_AUTH_FAILED";
  if (n === null && NETWORK_RE.test(text)) return "SYNC_UNREACHABLE";
  return "SYNC_IO";
}

interface MegaNode {
  nodeId: string; name: string; directory: boolean; size?: number; timestamp?: number; children?: MegaNode[];
  mkdir(name: string): Promise<MegaNode>;
  upload(o: { name: string; size: number }, data: Uint8Array): { complete: Promise<unknown> };
  downloadBuffer(o: object): Promise<Uint8Array>;
}
export interface MegaSession { root: MegaNode; close(): Promise<void> | void }
export type MegaLogin = (c: { email: string; password: string }, o: { onLost: (e: unknown) => void }) => Promise<MegaSession>;

export const megaLogin: MegaLogin = async ({ email, password }, { onLost }) => {
  const { Storage } = await import("megajs"); // its own chunk: loaded only when sync is used
  // A fresh options object: megajs deletes options.password once it has derived the key. No 2FA code is ever sent.
  const s = new Storage({ email, password, keepalive: true, autoload: true });
  const api = s.api as unknown as { on(ev: string, fn: (e: unknown) => void): void; close(): void };
  api.on("error", onLost); // a dead keepalive poll: the next operation reports SYNC_SESSION_EXPIRED
  try { return (await s.ready) as unknown as MegaSession; } catch (e) { try { api.close(); } catch { /* already closed */ } throw e; }
};

export async function openMegaStore({ email, password, folder }: { email: string; password: string; folder: string },
  { login = megaLogin }: { login?: MegaLogin } = {}): Promise<OpenedStore> {
  if (typeof email !== "string" || !EMAIL_RE.test(email)) throw new SyncStoreError("SYNC_BAD_EMAIL");
  if (typeof password !== "string" || password.length < 1 || password.length > 1024) throw new SyncStoreError("SYNC_BAD_PASSWORD");
  if (!SEGMENT.test(folder) || folder === "." || folder === "..") throw new SyncStoreError("SYNC_BAD_PATH");
  let lost = false;
  let session: MegaSession;
  try { session = await login({ email, password }, { onLost: () => { lost = true; } }); }
  catch (e) { throw new SyncStoreError(classifyMegaError(e, true)); }

  const kids = (n: MegaNode | null) => n?.children ?? [];
  const folderNamed = (n: MegaNode | null, name: string) => kids(n).find((c) => c.directory && c.name === name) ?? null;
  const newest = (n: MegaNode, name: string) => kids(n).filter((c) => !c.directory && c.name === name)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).at(-1) ?? null;
  const op = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (lost) throw new SyncStoreError("SYNC_SESSION_EXPIRED");
    try { return await fn(); } catch (e) { throw e instanceof SyncStoreError ? e : new SyncStoreError(classifyMegaError(e)); }
  };
  /** Folders below the sync folder; segments at index >= mkdirFrom may be created, the rest must exist. */
  const walk = async (segs: string[], mkdirFrom: number) => {
    let node = folderNamed(session.root, folder);
    if (!node) return null; // the desktop creates the sync folder; a device never does
    for (let i = 0; i < segs.length; i++) {
      const next = folderNamed(node, segs[i]);
      if (next) node = next;
      else if (i >= mkdirFrom) node = await node.mkdir(segs[i]);
      else return null;
    }
    return node;
  };

  return {
    get: (path) => op(async () => {
      const segs = checkPath(path);
      const dir = await walk(segs.slice(0, -1), Infinity);
      const f = dir ? newest(dir, segs[segs.length - 1]) : null;
      if (!f) return null;
      if ((f.size ?? 0) > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
      try { return new Uint8Array(await f.downloadBuffer({})); }
      catch (e) { if (megaErrorNumber(e) === -9) return null; throw e; }
    }),
    put: (path, bytes, mkdirFrom = Infinity) => op(async () => {
      const segs = checkPath(path);
      if (bytes.length > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
      const dir = await walk(segs.slice(0, -1), mkdirFrom);
      if (!dir) throw new SyncStoreError("SYNC_MISSING");
      const name = segs[segs.length - 1];
      if (newest(dir, name)) return; // names are unique per write, so this is a retry of a write that landed
      await dir.upload({ name, size: bytes.length }, bytes).complete;
    }),
    async close() { lost = true; try { await session.close(); } catch { /* already closed */ } },
  };
}
