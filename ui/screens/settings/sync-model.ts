// Settings → Phone and web sync: the model for the /kb/sync/* routes (schema/http/sync.schema.json). Strict decoding;
// the card hides when the core does not serve these routes to this UI (no bus host proof). The MEGA password is sent
// once, on Save, and is never read back; the own server's SSH private key never leaves the core (the status carries only its public line).
import { ApiError, call, type CoreClient } from "./core-api.ts";

export interface MegaSetup { email: string; password: string; folder: string }
export type StoreKind = "mega" | "box" | "sftp";
export interface MegaStore { folder: string; account: string }
export interface SftpSetup { host: string; port: number; username: string; hostFingerprint: string; webHost: string }
export interface SftpStore extends SftpSetup { publicKey: string }
export const isSftpStore = (s: MegaStore | SftpStore | null): s is SftpStore => !!s && "publicKey" in s;
export interface SyncDevice { deviceId: string; name: string; tier: "web" | "ios"; addedAt: number; folderHint: string }
export interface SyncStatus {
  configured: boolean; enabled: boolean; storeKind: string | null; store: MegaStore | SftpStore | null;
  syncId: string | null; epoch: number | null; signingFingerprint: string | null; devices: SyncDevice[]; rotationPending: boolean;
  lastPublishAt: number | null; lastError: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const intOrNull = (v: unknown) => v === null || Number.isInteger(v);

const PUBLIC_KEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9_.@-]{1,80})?$/;
function decodeSftpStore(s: unknown): SftpStore | null {
  if (!isRecord(s) || typeof s.host !== "string" || !Number.isInteger(s.port) || typeof s.username !== "string" || typeof s.hostFingerprint !== "string"
    || typeof s.webHost !== "string" || typeof s.publicKey !== "string" || !PUBLIC_KEY_RE.test(s.publicKey)) return null;
  return { host: s.host, port: s.port as number, username: s.username, hostFingerprint: s.hostFingerprint, webHost: s.webHost, publicKey: s.publicKey };
}

export function decodeSyncStatus(v: unknown): SyncStatus {
  if (!isRecord(v) || typeof v.configured !== "boolean" || typeof v.enabled !== "boolean" || !strOrNull(v.storeKind)
    || !strOrNull(v.syncId) || !intOrNull(v.epoch) || !strOrNull(v.signingFingerprint) || !Array.isArray(v.devices)
    || !intOrNull(v.lastPublishAt) || !strOrNull(v.lastError)) throw new ApiError(0, "BAD_RESPONSE");
  const s = v.store;
  const store = v.storeKind === "sftp" ? decodeSftpStore(s)
    : isRecord(s) && typeof s.folder === "string" && typeof s.account === "string" ? { folder: s.folder, account: s.account } : null;
  const devices = (v.devices as unknown[]).filter((d): d is SyncDevice => isRecord(d) && typeof d.deviceId === "string" && typeof d.name === "string"
    && (d.tier === "web" || d.tier === "ios") && typeof d.addedAt === "number")
    .map((d) => ({ deviceId: d.deviceId, name: d.name, tier: d.tier, addedAt: d.addedAt, folderHint: typeof d.folderHint === "string" ? d.folderHint : "" }));
  return { configured: v.configured, enabled: v.enabled, storeKind: v.storeKind as string | null, store,
    syncId: v.syncId as string | null, epoch: v.epoch as number | null, signingFingerprint: v.signingFingerprint as string | null, devices,
    rotationPending: v.rotationPending === true, lastPublishAt: v.lastPublishAt as number | null, lastError: v.lastError as string | null };
}

const SYNC_ERROR_TEXT: Record<string, string> = {
  SYNC_AUTH_FAILED: "MEGA refused the email or password. Check them, then Save again. Sync was turned off so MEGA does not lock the account.",
  SYNC_MFA_REQUIRED: "This MEGA account has two-factor login on. The desktop logs in by itself, so use a separate MEGA account with two-factor off (keep it on for your personal account).",
  SYNC_RATE_LIMITED: "MEGA asked LLM-IDE to slow down. Sync retries by itself in a few minutes.",
  SYNC_QUOTA: "The MEGA account is over its storage or transfer quota.",
  SYNC_UNREACHABLE: "MEGA could not be reached. Check the network; sync retries by itself.",
  SYNC_IO: "A MEGA operation failed. Sync retries by itself.",
  SYNC_BUSY: "Sync is finishing a cycle. Try again in a moment.",
};
const SFTP_ERROR_TEXT: Record<string, string> = {
  SYNC_HOST_KEY_CHANGED: "The server's identity changed: it showed a different host key than the fingerprint you pasted, so the desktop did not connect and sync was turned off. If you reinstalled the server, read its new fingerprint on it and Save again. Otherwise, do not connect: someone may be in between.",
  SYNC_AUTH_FAILED: "The server refused this desktop's key. Run the command below on the server as root (it writes /etc/ssh/authorized_keys/llmidesync), then Test connection. Sync was turned off until then.",
  SYNC_UNREACHABLE: "Your server could not be reached. Check the address, the SSH port and the network; sync retries by itself.",
  SYNC_IO: "A file operation on your server failed. Check the folders with deploy/vps/check-sync.sh server; sync retries by itself.",
  SYNC_TIMEOUT: "Your server did not answer in time. Sync retries by itself.",
};
export const syncErrorText = (code: string, kind?: string | null): string | null =>
  (kind === "box" ? BOX_ERROR_TEXT[code] : kind === "sftp" ? SFTP_ERROR_TEXT[code] : undefined) ?? SYNC_ERROR_TEXT[code] ?? null;
export const describeSyncError = (e: unknown, kind: string | null = "mega"): string | null => (e instanceof ApiError ? syncErrorText(e.code, kind) : null);

export async function loadSyncStatus(client: CoreClient): Promise<SyncStatus | null> {
  try { return decodeSyncStatus(await call(client, "GET", "/kb/sync/status")); }
  catch (e) { if (e instanceof ApiError && e.code === "HOST_PROOF_REQUIRED") return null; throw e; }
}
export const saveMega = async (client: CoreClient, cfg: MegaSetup) => decodeSyncStatus(await call(client, "POST", "/kb/sync/mega", cfg));
export const saveSftp = async (client: CoreClient, cfg: SftpSetup) => decodeSyncStatus(await call(client, "POST", "/kb/sync/sftp", cfg));
export const authorizedKeysCommand = (publicKey: string, user: string) => `printf 'restrict %s\\n' '${publicKey}' > /etc/ssh/authorized_keys/${user}`;
export function storeSummary(s: SyncStatus): string {
  if (isSftpStore(s.store)) return `Server ${s.store.username}@${s.store.host}:${s.store.port}. Phones and browsers use https://${s.store.webHost}/sync/.`;
  if (s.storeKind === "box" && s.store) return `Connected Box account ${s.store.account}, folder ${s.store.folder} in its Box files.`;
  return s.store ? `Connected account ${s.store.account}, folder ${s.store.folder} in its Cloud Drive.` : "";
}
export const testSync = async (client: CoreClient) => { await call(client, "POST", "/kb/sync/test", {}); };
export const setSyncEnabled = async (client: CoreClient, enabled: boolean) => decodeSyncStatus(await call(client, "POST", "/kb/sync/enabled", { enabled }));
export const publishNow = async (client: CoreClient) => call(client, "POST", "/kb/sync/publish", {});

export interface EnrollStart { qr: string; expiresAt: number; tier: "web" | "ios" }
export interface EnrollPoll { phase: "none" | "waiting" | "confirm" | "failed" | "expired"; sas: string | null; name: string | null; code: string | null }
const PHASES = new Set(["none", "waiting", "confirm", "failed", "expired"]);

export function decodeEnrollStart(v: unknown): EnrollStart {
  if (isRecord(v) && typeof v.qr === "string" && /^(llmide:\/\/pair\?|https?:\/\/)/.test(v.qr) && Number.isInteger(v.expiresAt) && (v.tier === "web" || v.tier === "ios")) {
    return { qr: v.qr, expiresAt: v.expiresAt as number, tier: v.tier };
  }
  throw new ApiError(0, "BAD_RESPONSE");
}
export function decodeEnrollPoll(v: unknown): EnrollPoll {
  if (isRecord(v) && typeof v.phase === "string" && PHASES.has(v.phase) && (v.sas === null || (typeof v.sas === "string" && /^[0-9]{6}$/.test(v.sas)))
    && strOrNull(v.name) && strOrNull(v.code)) {
    return { phase: v.phase as EnrollPoll["phase"], sas: v.sas as string | null, name: v.name as string | null, code: v.code as string | null };
  }
  throw new ApiError(0, "BAD_RESPONSE");
}
const ENROLL_FAILURES: Record<string, string> = {
  contested: "Two devices answered this code, so someone else may have seen it. Nothing was added. Start again, with the screen out of view of others.",
  claim_invalid: "The device's answer could not be verified, or it is a different kind of device (iPhone app vs browser). Nothing was added.",
  expired: "The code expired. Nothing was added. Start again.",
  store: "The sync storage could not be reached. Nothing was added.",
};
/** Which enrollment screen to show. "none" mid-enrollment means the backend restarted and lost it: back to the start. */
export function enrollScreen(start: EnrollStart | null, poll: EnrollPoll | null): "start" | "qr" | "confirm" | "failed" {
  if (!start || poll?.phase === "none") return "start";
  if (poll?.phase === "confirm") return "confirm";
  return poll?.phase === "failed" || poll?.phase === "expired" ? "failed" : "qr";
}
export const enrollFailureText = (code: string | null): string => ENROLL_FAILURES[code ?? ""] ?? "Adding the device stopped. Nothing was added.";
export const startEnroll = async (client: CoreClient, tier: "web" | "ios") => decodeEnrollStart(await call(client, "POST", "/kb/sync/devices/enroll", { tier }));
export const pollEnroll = async (client: CoreClient) => decodeEnrollPoll(await call(client, "POST", "/kb/sync/devices/enroll/poll", {}));
export const confirmEnroll = async (client: CoreClient) => decodeSyncStatus(await call(client, "POST", "/kb/sync/devices/enroll/confirm", {}));
/** Poll one at a time: the next poll starts intervalMs after the previous one settled, never overlapping (review C1). */
export function pollEnrollSerially(client: CoreClient, onPoll: (p: EnrollPoll) => void, onError: (e: unknown) => void, intervalMs = 2000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { const p = await pollEnroll(client); if (!stopped) onPoll(p); } catch (e) { if (!stopped) onError(e); }
    if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
  };
  timer = setTimeout(() => { void tick(); }, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}
export const cancelEnroll = async (client: CoreClient) => { await call(client, "POST", "/kb/sync/devices/enroll/cancel", {}); };
export const revokeSyncDevice = async (client: CoreClient, deviceId: string) => decodeSyncStatus(await call(client, "DELETE", `/kb/sync/devices/${encodeURIComponent(deviceId)}`));

/** C5: record that the storage password was changed after a revoke (the Settings reminder's Done). */
export const markSyncPasswordChanged = async (client: CoreClient) => decodeSyncStatus(await call(client, "POST", "/kb/sync/password-changed", {}));
export const rotateSyncKeys = async (client: CoreClient) => decodeSyncStatus(await call(client, "POST", "/kb/sync/rotate", {}));

export const STORE_CHOICES: ReadonlyArray<{ kind: StoreKind; label: string; built: boolean }> = [
  { kind: "mega", label: "MEGA", built: true },
  { kind: "box", label: "Box", built: true },
  { kind: "sftp", label: "Own server", built: true },
];
export const BOX_DESKTOP_REDIRECT = "http://127.0.0.1/kb/sync/box/callback";
export interface BoxSetup { clientId: string; clientSecret: string; folder: string }
export interface BoxConnectStart { authorizeUrl: string }
export interface BoxConnectPoll { phase: "none" | "waiting" | "done" | "failed"; code: string | null }
const BOX_PHASES = new Set(["none", "waiting", "done", "failed"]);
export function decodeBoxStart(v: unknown): BoxConnectStart {
  if (isRecord(v) && typeof v.authorizeUrl === "string" && v.authorizeUrl.startsWith("https://account.box.com/api/oauth2/authorize?")) return { authorizeUrl: v.authorizeUrl };
  throw new ApiError(0, "BAD_RESPONSE");
}
export function decodeBoxPoll(v: unknown): BoxConnectPoll {
  if (isRecord(v) && typeof v.phase === "string" && BOX_PHASES.has(v.phase) && strOrNull(v.code)) return { phase: v.phase as BoxConnectPoll["phase"], code: v.code as string | null };
  throw new ApiError(0, "BAD_RESPONSE");
}
export const startBoxConnect = async (client: CoreClient, cfg: BoxSetup) => decodeBoxStart(await call(client, "POST", "/kb/sync/box/start", cfg));
export const pollBoxConnect = async (client: CoreClient) => decodeBoxPoll(await call(client, "POST", "/kb/sync/box/poll", {}));
export async function waitBoxConnect(client: CoreClient, { intervalMs = 2000, timeoutMs = 600_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now = () => Date.now() }:
  { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<{ phase: "done" | "failed" | "timeout"; code: string | null }> {
  const until = now() + timeoutMs;
  for (;;) {
    const p = await pollBoxConnect(client);
    if (p.phase === "done" || p.phase === "failed") return { phase: p.phase, code: p.code };
    if (p.phase === "none" || now() >= until) return { phase: "timeout", code: null };
    await sleep(intervalMs);
  }
}
const BOX_ERROR_TEXT: Record<string, string> = {
  SYNC_AUTH_FAILED: "Box no longer accepts the saved sign-in: it was revoked, or the desktop was off for more than 60 days. Connect Box again. Sync was turned off until then.",
  SYNC_RATE_LIMITED: "Box asked LLM-IDE to slow down. Sync retries by itself in a few minutes.",
  SYNC_QUOTA: "The Box account is out of storage.",
  SYNC_UNREACHABLE: "Box could not be reached. Check the network; sync retries by itself.",
  SYNC_IO: "A Box operation failed. Sync retries by itself.",
  SYNC_BUSY: "Sync is finishing a cycle. Try again in a moment.",
};
const BOX_CONNECT_TEXT: Record<string, string> = {
  cancelled: "Box sign-in was cancelled. Nothing changed.",
  SYNC_BAD_CLIENT: "Box refused the client ID or secret. Copy both again from your Box app's Configuration page.",
  SYNC_AUTH_FAILED: "Box refused the sign-in. Check that your Box app lists the redirect URI shown here, then try again.",
  SYNC_UNREACHABLE: "Box could not be reached. Check the network and try again.",
  SYNC_BUSY: "Sync is finishing a cycle. Try again in a moment.",
  SYNC_QUOTA: "The Box account is out of storage.",
  SYNC_IO: "A Box operation failed. Try again.",
};
export const boxConnectFailureText = (code: string | null): string => BOX_CONNECT_TEXT[code ?? ""] ?? "Connecting Box stopped. Nothing changed.";
