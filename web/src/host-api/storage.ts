// Browser storage for the device token (spec: "token in Keychain/browser storage") and the last host URL.
// Every access is guarded: a private window or blocked site data falls back to memory for this page only.
export interface KeyValue { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export function browserStorage(): KeyValue | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const TOKEN_PREFIX = "llmide.hostApi.v1.token:"; // legacy: one token per exact URL, migrated on first read
const DEVICES = "llmide.hostApi.v1.devices";
const LAST_URL = "llmide.hostApi.v1.lastUrl";
const validToken = (v: unknown): v is string => typeof v === "string" && v.length >= 16 && v.length <= 512;

/** One paired desktop. Stored under DEVICES as a JSON object keyed by id: the certificate fingerprint when the host
 *  has one, else the URL (dev/plaintext). `fingerprint` is null until the first hello that carries one. */
export interface DeviceRecord { token: string; fingerprint: string | null; url: string; hostName: string }
export interface HostIdentity { fingerprint: string | null; hostName: string }
export interface DeviceStore {
  get(): string | null;
  set(token: string | null): void;
  /** The paired desktop's known identity (null when nothing is paired here). */
  identity(): { fingerprint: string | null; borrowed?: boolean } | null;
  /** The hello's identity, remembered so set()/confirm() can record it. */
  observe(info: HostIdentity): void;
  /** A stored token was accepted: fill in the fingerprint if unknown, refresh the name and move the record to this URL. */
  confirm(): void;
}

const recordId = (r: DeviceRecord) => r.fingerprint ?? r.url;
const validRecord = (v: unknown): v is DeviceRecord => {
  const r = v as DeviceRecord | null;
  return typeof r === "object" && r !== null && validToken(r.token) && typeof r.url === "string" && typeof r.hostName === "string"
    && (r.fingerprint === null || typeof r.fingerprint === "string");
};

/** `from`: reuse the record stored for another URL (Change address). It is only moved to `url` by confirm(), after the
 *  host there proved the same fingerprint, so a failed attempt leaves the old record untouched. */
export function tokenStoreFor(url: string, storage: KeyValue | null = browserStorage(), from: string | null = null): DeviceStore {
  let cache: Record<string, DeviceRecord> = {};
  let seen: HostIdentity | null = null;
  const write = (list: Record<string, DeviceRecord>) => {
    cache = list;
    try { if (Object.keys(list).length) storage?.setItem(DEVICES, JSON.stringify(list)); else storage?.removeItem(DEVICES); } catch { /* memory keeps it */ }
  };
  const read = (): Record<string, DeviceRecord> => {
    let list: Record<string, DeviceRecord> | null = null;
    try {
      const raw = storage?.getItem(DEVICES);
      if (raw) {
        list = {};
        for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) if (validRecord(v)) list[k] = v;
      } else if (storage) list = {};
    } catch { list = null; }
    if (list === null) list = { ...cache };
    for (const u of from && from !== url ? [url, from] : [url]) { // migrate the URL-keyed token (fingerprint unknown yet)
      if (Object.values(list).some((r) => r.url === u)) continue;
      try {
        const legacy = storage?.getItem(TOKEN_PREFIX + u);
        if (validToken(legacy)) { list[u] = { token: legacy, fingerprint: null, url: u, hostName: "" }; storage?.removeItem(TOKEN_PREFIX + u); write(list); }
      } catch { /* leave it */ }
    }
    return list;
  };
  const active = (list: Record<string, DeviceRecord>): DeviceRecord | null =>
    Object.values(list).find((r) => r.url === url) ?? (from ? Object.values(list).find((r) => r.url === from) ?? null : null);
  const without = (list: Record<string, DeviceRecord>, drop: (r: DeviceRecord) => boolean) =>
    Object.fromEntries(Object.entries(list).filter(([, r]) => !drop(r)));
  return {
    get: () => active(read())?.token ?? null,
    identity() { const a = active(read()); return a ? { fingerprint: a.fingerprint, borrowed: a.url !== url } : null; },
    observe(info) { seen = info; },
    set(token) {
      const list = read();
      const cur = active(list);
      if (!token) return write(without(list, (r) => r === cur));
      const rec: DeviceRecord = { token, url, fingerprint: seen ? seen.fingerprint : cur?.fingerprint ?? null, hostName: seen?.hostName || cur?.hostName || "" };
      // Pairing again at this address replaces whatever was recorded for it; other desktops stay.
      write({ ...without(list, (r) => r.url === url || recordId(r) === recordId(rec)), [recordId(rec)]: rec });
    },
    confirm() {
      const list = read();
      const cur = active(list);
      if (!cur) return;
      const rec: DeviceRecord = { ...cur, url, fingerprint: cur.fingerprint ?? seen?.fingerprint ?? null, hostName: seen?.hostName || cur.hostName };
      write({ ...without(list, (r) => r === cur || r.url === url || recordId(r) === recordId(rec)), [recordId(rec)]: rec });
    },
  };
}

export function lastHostUrl(storage: KeyValue | null = browserStorage()) {
  return {
    get(): string | null { try { return storage?.getItem(LAST_URL) ?? null; } catch { return null; } },
    set(url: string): void { try { storage?.setItem(LAST_URL, url); } catch { /* not remembered */ } },
  };
}

// The selected project is not a secret (the host's `projects.list` returns it to any paired device), but like the
// token it is per host and every access is guarded so a blocked browser keeps the choice in memory for this page only.
const PROJECT_PREFIX = "llmide.hostApi.v1.project:";
const validProjectId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);

export interface ProjectStore { get(): string | null; set(id: string | null): void }
export interface CachedProject { id: string; name: string }
export interface ProjectListStore { get(): CachedProject[]; set(list: readonly CachedProject[]): void }

const PROJECT_LIST_PREFIX = "llmide.hostApi.v1.projectList:";
const MAX_CACHED_PROJECTS = 200;

/** The desktop's identity for per-desktop browser state: its certificate fingerprint when a device record has one, else
 *  the URL (so it survives Change address). `legacy` are the URL keys older builds wrote. */
function desktopKeys(storage: KeyValue | null, url: string, from: string | null): { id: string; legacy: string[] } {
  const urls = from && from !== url ? [url, from] : [url];
  try {
    const raw = storage?.getItem(DEVICES);
    if (raw) for (const rec of Object.values(JSON.parse(raw) as Record<string, DeviceRecord>)) {
      if (rec && urls.includes(rec.url) && typeof rec.fingerprint === "string" && rec.fingerprint) return { id: `fp:${rec.fingerprint}`, legacy: urls };
    }
  } catch { /* fall back to the URL */ }
  return { id: url, legacy: urls.slice(1) };
}

/** Selection per paired desktop. The old URL-keyed value is migrated on first read once the identity is known. */
export function projectStoreFor(url: string, storage: KeyValue | null = browserStorage(), from: string | null = null): ProjectStore {
  let memory: string | null = null;
  return {
    get(): string | null {
      try {
        const k = desktopKeys(storage, url, from);
        const v = storage?.getItem(PROJECT_PREFIX + k.id);
        if (validProjectId(v)) return v;
        for (const u of k.legacy) {
          const old = storage?.getItem(PROJECT_PREFIX + u);
          if (validProjectId(old)) { storage?.setItem(PROJECT_PREFIX + k.id, old); storage?.removeItem(PROJECT_PREFIX + u); return old; }
        }
      } catch { /* fall back to memory */ }
      return memory;
    },
    set(id: string | null): void {
      memory = validProjectId(id) ? id : null;
      try {
        const key = PROJECT_PREFIX + desktopKeys(storage, url, from).id;
        if (memory) storage?.setItem(key, memory); else storage?.removeItem(key);
      } catch { /* memory keeps it */ }
    },
  };
}

/** The last project list of a live session (ids and names only, bounded), for the offline prompt picker. */
export function projectListStoreFor(url: string, storage: KeyValue | null = browserStorage(), from: string | null = null): ProjectListStore {
  return {
    get(): CachedProject[] {
      try {
        const raw = storage?.getItem(PROJECT_LIST_PREFIX + desktopKeys(storage, url, from).id);
        const list = raw ? (JSON.parse(raw) as unknown) : [];
        if (!Array.isArray(list)) return [];
        return list.filter((p): p is CachedProject => !!p && validProjectId(p.id) && typeof p.name === "string").slice(0, MAX_CACHED_PROJECTS)
          .map((p) => ({ id: p.id, name: p.name.slice(0, 120) }));
      } catch { return []; }
    },
    set(list): void {
      try {
        const key = PROJECT_LIST_PREFIX + desktopKeys(storage, url, from).id;
        const keep = list.filter((p) => validProjectId(p.id)).slice(0, MAX_CACHED_PROJECTS).map((p) => ({ id: p.id, name: String(p.name).slice(0, 120) }));
        if (keep.length) storage?.setItem(key, JSON.stringify(keep)); else storage?.removeItem(key);
      } catch { /* not cached */ }
    },
  };
}

/** What the offline compose offers: the last live session's project list and selection for the last used desktop. */
export function offlineProjectChoice(storage: KeyValue | null = browserStorage()): { projects: CachedProject[]; selectedId: string | null } {
  const url = lastHostUrl(storage).get();
  if (!url) return { projects: [], selectedId: null };
  const projects = projectListStoreFor(url, storage).get();
  const selected = projectStoreFor(url, storage).get();
  return { projects, selectedId: projects.some((p) => p.id === selected) ? selected : null };
}
