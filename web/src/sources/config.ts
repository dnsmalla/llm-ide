// App settings for direct reads (decisions D5, D6): the GitLab application ID and the Box app's client ID and secret,
// in IndexedDB `llmide-sources`. Never tokens. Known risk: script running on this origin could read the Box secret; the
// CSP allows no inline or third-party script, and the secret works only with the user's own Box login and redirect URI.
import type { ProviderConfig } from "./oauth.ts";

export interface SourcesConfig { v: 1; gitlab: ProviderConfig | null; box: ProviderConfig | null }
export interface SourcesConfigStore { load(): Promise<SourcesConfig | null>; save(c: SourcesConfig): Promise<void> }

export function memorySourcesConfig(): SourcesConfigStore {
  let c: SourcesConfig | null = null;
  return { load: async () => c, save: async (x) => { c = x; } };
}

const DB = "llmide-sources"; const STORE = "config"; const KEY = "config";
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export function indexedDbSourcesConfig(idb: IDBFactory | undefined = globalThis.indexedDB): SourcesConfigStore | null {
  if (!idb) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= new Promise<IDBDatabase>((res, rej) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
  return {
    async load() { return ((await req((await db()).transaction(STORE, "readonly").objectStore(STORE).get(KEY))) as SourcesConfig | undefined) ?? null; },
    async save(c) { const t = (await db()).transaction(STORE, "readwrite"); const end = done(t); t.objectStore(STORE).put(c, KEY); await end; },
  };
}
