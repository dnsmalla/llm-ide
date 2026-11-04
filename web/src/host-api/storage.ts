// Browser storage for the device token (spec: "token in Keychain/browser storage") and the last host URL.
// Every access is guarded: a private window or blocked site data falls back to memory for this page only.
export interface KeyValue { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export function browserStorage(): KeyValue | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const TOKEN_PREFIX = "llmide.hostApi.v1.token:";
const LAST_URL = "llmide.hostApi.v1.lastUrl";
const validToken = (v: unknown): v is string => typeof v === "string" && v.length >= 16 && v.length <= 512;

export function tokenStoreFor(url: string, storage: KeyValue | null = browserStorage()) {
  const key = TOKEN_PREFIX + url;
  let memory: string | null = null;
  return {
    get(): string | null {
      try { const v = storage?.getItem(key); if (validToken(v)) return v; } catch { /* fall back to memory */ }
      return memory;
    },
    set(token: string | null): void {
      memory = token;
      try { if (token) storage?.setItem(key, token); else storage?.removeItem(key); } catch { /* memory keeps it */ }
    },
  };
}

export function lastHostUrl(storage: KeyValue | null = browserStorage()) {
  return {
    get(): string | null { try { return storage?.getItem(LAST_URL) ?? null; } catch { return null; } },
    set(url: string): void { try { storage?.setItem(LAST_URL, url); } catch { /* not remembered */ } },
  };
}
