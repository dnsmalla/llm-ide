// Settings → Phone and web sync: the model for the /kb/sync/* routes (schema/http/sync.schema.json). Strict decoding;
// the card hides when the core does not serve these routes to this UI (no bus host proof). The MEGA password is sent
// once, on Save, and is never read back: no route returns it, and the decoder keeps only folder + masked account.
import { ApiError, call, type CoreClient } from "./core-api.ts";

export interface MegaSetup { email: string; password: string; folder: string }
export interface MegaStore { folder: string; account: string }
export interface SyncDevice { deviceId: string; name: string; tier: "web" | "ios"; addedAt: number }
export interface SyncStatus {
  configured: boolean; enabled: boolean; storeKind: string | null; store: MegaStore | null;
  syncId: string | null; epoch: number | null; signingFingerprint: string | null; devices: SyncDevice[];
  lastPublishAt: number | null; lastError: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const intOrNull = (v: unknown) => v === null || Number.isInteger(v);

export function decodeSyncStatus(v: unknown): SyncStatus {
  if (!isRecord(v) || typeof v.configured !== "boolean" || typeof v.enabled !== "boolean" || !strOrNull(v.storeKind)
    || !strOrNull(v.syncId) || !intOrNull(v.epoch) || !strOrNull(v.signingFingerprint) || !Array.isArray(v.devices)
    || !intOrNull(v.lastPublishAt) || !strOrNull(v.lastError)) throw new ApiError(0, "BAD_RESPONSE");
  const s = v.store;
  const store = isRecord(s) && typeof s.folder === "string" && typeof s.account === "string" ? { folder: s.folder, account: s.account } : null;
  const devices = (v.devices as unknown[]).filter((d): d is SyncDevice => isRecord(d) && typeof d.deviceId === "string" && typeof d.name === "string"
    && (d.tier === "web" || d.tier === "ios") && typeof d.addedAt === "number");
  return { configured: v.configured, enabled: v.enabled, storeKind: v.storeKind as string | null, store,
    syncId: v.syncId as string | null, epoch: v.epoch as number | null, signingFingerprint: v.signingFingerprint as string | null, devices,
    lastPublishAt: v.lastPublishAt as number | null, lastError: v.lastError as string | null };
}

const SYNC_ERROR_TEXT: Record<string, string> = {
  SYNC_AUTH_FAILED: "MEGA refused the email or password. Check them, then Save again. Sync was turned off so MEGA does not lock the account.",
  SYNC_MFA_REQUIRED: "This MEGA account has two-factor login on. The desktop logs in by itself, so use a separate MEGA account with two-factor off (keep it on for your personal account).",
  SYNC_RATE_LIMITED: "MEGA asked LLM-IDE to slow down. Sync retries by itself in a few minutes.",
  SYNC_QUOTA: "The MEGA account is over its storage or transfer quota.",
  SYNC_UNREACHABLE: "MEGA could not be reached. Check the network; sync retries by itself.",
  SYNC_IO: "A MEGA operation failed. Sync retries by itself.",
};
export const syncErrorText = (code: string): string | null => SYNC_ERROR_TEXT[code] ?? null;
export const describeSyncError = (e: unknown): string | null => (e instanceof ApiError ? syncErrorText(e.code) : null);

export async function loadSyncStatus(client: CoreClient): Promise<SyncStatus | null> {
  try { return decodeSyncStatus(await call(client, "GET", "/kb/sync/status")); }
  catch (e) { if (e instanceof ApiError && e.code === "HOST_PROOF_REQUIRED") return null; throw e; }
}
export const saveMega = async (client: CoreClient, cfg: MegaSetup) => decodeSyncStatus(await call(client, "POST", "/kb/sync/mega", cfg));
export const testSync = async (client: CoreClient) => { await call(client, "POST", "/kb/sync/test", {}); };
export const setSyncEnabled = async (client: CoreClient, enabled: boolean) => decodeSyncStatus(await call(client, "POST", "/kb/sync/enabled", { enabled }));
export const publishNow = async (client: CoreClient) => call(client, "POST", "/kb/sync/publish", {});
