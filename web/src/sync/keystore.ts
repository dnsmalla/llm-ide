// This browser's sync identity (design 5.1): P-256 ECDH and ECDSA pairs generated non-extractable, and one device record
// in IndexedDB holding CryptoKey objects (structured clone keeps them non-extractable), public SPKIs, the pinned desktop
// SPKI, the epoch, the wrap keys and counters. Never the MEGA password, never a Box token, never decrypted content. For a
// Box store it keeps the user's own Box app id and secret from the pairing link (SP6 D2): not a user credential, useless
// without the user's Box login.
import type { WrapKeys } from "./envelope.ts";

const subtle: any = globalThis.crypto.subtle;
export interface DeviceKeyPairs { ecdhPrivate: CryptoKey; ecdhSpki: Uint8Array; signingPrivate: CryptoKey; signingSpki: Uint8Array }
export interface LinkedDevice extends DeviceKeyPairs {
  v: 1; sid: string; dir: string; st: string; tier: "web"; name: string; deviceId: string; userId: string;
  desktopSpki: Uint8Array; epoch: number; keys: WrapKeys; prevReply: { epoch: number; key: CryptoKey; until: number } | null;
  manifestSeq: number; reqSeq: number; pending: Array<{ requestId: string; issuedAt: number }>; megaEmail: string;
  box?: { clientId: string; clientSecret: string };
}
export interface KeyStore { load(): Promise<LinkedDevice | null>; save(d: LinkedDevice): Promise<void>; clear(): Promise<void> }

export async function generateDeviceKeys(): Promise<DeviceKeyPairs> {
  const ecdh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const sig = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return {
    ecdhPrivate: ecdh.privateKey, ecdhSpki: new Uint8Array(await subtle.exportKey("spki", ecdh.publicKey)),
    signingPrivate: sig.privateKey, signingSpki: new Uint8Array(await subtle.exportKey("spki", sig.publicKey)),
  };
}

/** Tests, and the fallback when this browser has no usable IndexedDB (the link then lasts for this page only). */
export function memoryKeyStore(): KeyStore {
  let rec: LinkedDevice | null = null;
  return { load: async () => rec, save: async (d) => { rec = d; }, clear: async () => { rec = null; } };
}

const DB = "llmide-sync"; const STORE = "device"; const KEY = "device";
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export function indexedDbKeyStore(idb: IDBFactory | undefined = globalThis.indexedDB): KeyStore | null {
  if (!idb) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= new Promise<IDBDatabase>((res, rej) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const write = async (fn: (s: IDBObjectStore) => void) => { const t = (await db()).transaction(STORE, "readwrite"); const end = done(t); fn(t.objectStore(STORE)); await end; };
  return {
    async load() { return ((await req((await db()).transaction(STORE, "readonly").objectStore(STORE).get(KEY))) as LinkedDevice | undefined) ?? null; },
    save: (d) => write((s) => { s.put(d, KEY); }),
    clear: () => write((s) => { s.delete(KEY); }),
  };
}
