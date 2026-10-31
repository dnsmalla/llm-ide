// One-shot actions of the source panes (test a connection, sign in, index, list/add/remove). Each is a thin,
// typed wrapper over a core route that decodes the answer defensively and throws `SourceError` on any failure.
// Credentials are never arguments here except the two documented write-once cases (Box/Slack/Email secrets go
// through `saveSecret`; the Google bring-your-own client secret goes in the body of `/auth/google/start`, which
// stores it in the vault server-side).

import { callOk, SourceError, type SourcesCore } from "./source-core.ts";
import type { BoxConfig, EmailConfig, GithubIssuesConfig } from "./source-config.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.slice(0, 500) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const SHORT = 60_000;
const LONG = 600_000;

// ---- OAuth polling ---------------------------------------------------------------------------

export interface PollOptions {
  intervalMs: number;
  maxMs: number;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Calls `check` until it returns a non-null value, the deadline passes (`timeout`) or the signal aborts (`cancelled`). */
export async function pollUntil<T>(check: () => Promise<T | null>, o: PollOptions): Promise<T> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const start = now();
  for (;;) {
    if (o.signal.aborted) throw new SourceError("cancelled");
    const v = await check();
    if (v !== null) return v;
    if (now() - start >= o.maxMs) throw new SourceError("timeout");
    await sleep(o.intervalMs, o.signal);
  }
}

// ---- email -----------------------------------------------------------------------------------

export interface EmailTest {
  mailbox: string;
  total: number;
  recent: number;
}

/** Probes the mailbox. `password`, when given, is tested as typed and NOT saved. */
export async function testEmail(core: SourcesCore, cfg: EmailConfig, password: string | null, signal: AbortSignal): Promise<EmailTest> {
  const b = await callOk<unknown>(core, "POST", "/kb/email/test", { host: cfg.host.trim(), port: cfg.port, secure: cfg.secure, user: cfg.user.trim(), mailbox: cfg.mailbox, authMethod: cfg.authMethod, ...(password ? { password } : null) }, signal, SHORT);
  const r = isRecord(b) ? b : {};
  return { mailbox: str(r.mailbox), total: num(r.total), recent: num(r.recent) };
}

export interface OAuthStart {
  authUrl: string;
  state: string;
}

export function decodeOAuthStart(b: unknown): OAuthStart {
  const r = isRecord(b) ? b : {};
  if (typeof r.authUrl !== "string" || typeof r.state !== "string") throw new SourceError("failed");
  return { authUrl: r.authUrl, state: r.state };
}

export async function googleStart(core: SourcesCore, own: { clientId: string; clientSecret: string } | null, signal: AbortSignal): Promise<OAuthStart> {
  return decodeOAuthStart(await callOk<unknown>(core, "POST", "/auth/google/start", own ?? {}, signal, SHORT));
}

export interface OAuthStatus {
  status: "pending" | "complete" | "error" | "unknown";
  /** Account label from the provider (email or team name): shown as text. */
  account: string | null;
}

export function decodeOAuthStatus(b: unknown): OAuthStatus {
  const r = isRecord(b) ? b : {};
  const s = r.status;
  const status = s === "pending" || s === "complete" || s === "error" ? s : "unknown";
  return { status, account: str(r.email) || str(r.teamName) || null };
}

export async function googleStatus(core: SourcesCore, state: string, signal: AbortSignal): Promise<OAuthStatus> {
  return decodeOAuthStatus(await callOk<unknown>(core, "GET", `/auth/google/status?state=${encodeURIComponent(state)}`, undefined, signal, SHORT));
}

// ---- slack -----------------------------------------------------------------------------------

export interface SlackTest {
  team: string;
  user: string;
}

/** Tests a saved connection, or (with `token`) a typed token without saving it. */
export async function testSlack(core: SourcesCore, token: string | null, signal: AbortSignal): Promise<SlackTest> {
  const b = await callOk<unknown>(core, "POST", "/kb/slack/test", token ? { token } : {}, signal, SHORT);
  const r = isRecord(b) ? b : {};
  return { team: str(r.team), user: str(r.user) };
}

export async function slackStart(core: SourcesCore, signal: AbortSignal): Promise<OAuthStart> {
  return decodeOAuthStart(await callOk<unknown>(core, "POST", "/auth/slack/start", {}, signal, SHORT));
}

export async function slackStatus(core: SourcesCore, state: string, signal: AbortSignal): Promise<OAuthStatus> {
  return decodeOAuthStatus(await callOk<unknown>(core, "GET", `/auth/slack/status?state=${encodeURIComponent(state)}`, undefined, signal, SHORT));
}

export interface SlackConversations {
  channels: { id: string; name: string }[];
  /** False: the list was cut short (rate limit, page cap, timeout). */
  complete: boolean;
}

export async function slackConversations(core: SourcesCore, signal: AbortSignal): Promise<SlackConversations> {
  const b = await callOk<unknown>(core, "GET", "/kb/slack/conversations", undefined, signal, 120_000);
  const r = isRecord(b) ? b : {};
  const channels = (Array.isArray(r.channels) ? r.channels : [])
    .filter(isRecord)
    .filter((c) => typeof c.id === "string")
    .slice(0, 2000)
    .map((c) => ({ id: c.id as string, name: str(c.name) }));
  return { channels, complete: r.complete !== false };
}

// ---- box -------------------------------------------------------------------------------------

export interface BoxTest {
  folderName: string;
  itemCount: number;
}

function boxBody(c: BoxConfig): Record<string, string> {
  return { clientId: c.clientId.trim(), subjectType: c.subjectType, subjectId: c.subjectId.trim(), folderId: c.folderId.trim() };
}

export async function testBox(core: SourcesCore, c: BoxConfig, signal: AbortSignal): Promise<BoxTest> {
  const r = await callOk<unknown>(core, "POST", "/kb/box/test", boxBody(c), signal, SHORT);
  const o = isRecord(r) ? r : {};
  return { folderName: str(o.folderName), itemCount: num(o.itemCount) };
}

export interface BoxIndexed {
  indexed: number;
  files: number;
  skipped: number;
  truncated: boolean;
}

/** Wholesale re-index of the folder into the core's knowledge base (Pattern A: no note files are written). */
export async function indexBox(core: SourcesCore, c: BoxConfig, signal: AbortSignal): Promise<BoxIndexed> {
  const r = await callOk<unknown>(core, "POST", "/kb/connect-box", boxBody(c), signal, LONG);
  const o = isRecord(r) ? r : {};
  return { indexed: num(o.indexed), files: num(o.files), skipped: num(o.skipped), truncated: o.truncated === true };
}

// ---- repos -----------------------------------------------------------------------------------

export interface RepoEntry {
  path: string;
  label: string | null;
}

export async function listRepos(core: SourcesCore, signal: AbortSignal): Promise<RepoEntry[]> {
  const b = await callOk<unknown>(core, "GET", "/auth/me/repos", undefined, signal, SHORT);
  const list = isRecord(b) && Array.isArray(b.repos) ? b.repos : [];
  return list.filter(isRecord).filter((r) => typeof r.path === "string").slice(0, 500).map((r) => ({ path: r.path as string, label: typeof r.label === "string" ? r.label.slice(0, 200) : null }));
}

export async function addRepo(core: SourcesCore, path: string, label: string | null, signal: AbortSignal): Promise<string> {
  const b = await callOk<unknown>(core, "POST", "/auth/me/repos", { path, ...(label ? { label } : null) }, signal, SHORT);
  return isRecord(b) && typeof b.path === "string" ? b.path : path;
}

export async function removeRepo(core: SourcesCore, path: string, signal: AbortSignal): Promise<void> {
  await callOk(core, "DELETE", `/auth/me/repos?path=${encodeURIComponent(path)}`, undefined, signal, SHORT);
}

export interface IndexResult {
  /** Counts the core reported, by name, as numbers only. */
  counts: Record<string, number>;
}

function counts(b: unknown): IndexResult {
  const out: Record<string, number> = {};
  if (isRecord(b)) for (const [k, v] of Object.entries(b)) if (typeof v === "number" && Number.isFinite(v) && k.length <= 40) out[k] = v;
  return { counts: out };
}

/** Indexes an approved local repo (replacing its previous rows). The core refuses a path that is not approved. */
export async function indexRepo(core: SourcesCore, path: string, signal: AbortSignal): Promise<IndexResult> {
  return counts(await callOk<unknown>(core, "POST", "/kb/connect-git", { path, replace: true }, signal, LONG));
}

export async function indexGithubIssues(core: SourcesCore, c: GithubIssuesConfig, signal: AbortSignal): Promise<IndexResult> {
  return counts(await callOk<unknown>(core, "POST", "/kb/connect-github-issues", { repo: c.repo.trim(), state: c.state }, signal, LONG));
}

// ---- connector catalog (per-user selection) and MCP-backed connectors ------------------------------

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  authKind: string;
  docsUrl: string | null;
  pipelineReady: boolean;
  selected: boolean;
}

export async function listCatalog(core: SourcesCore, signal: AbortSignal): Promise<CatalogEntry[]> {
  const b = await callOk<unknown>(core, "GET", "/auth/me/connectors/catalog", undefined, signal, SHORT);
  const list = isRecord(b) && Array.isArray(b.catalog) ? b.catalog : [];
  return list
    .filter(isRecord)
    .filter((e) => typeof e.id === "string" && /^[a-z][a-z0-9-]{1,20}$/.test(e.id as string))
    .slice(0, 100)
    .map((e) => ({ id: e.id as string, name: str(e.name) || (e.id as string), description: str(e.description), authKind: str(e.authKind), docsUrl: typeof e.docsUrl === "string" && /^https:\/\//.test(e.docsUrl) ? e.docsUrl.slice(0, 500) : null, pipelineReady: e.pipelineReady === true, selected: e.selected === true }));
}

/** Selection is a VISIBILITY setting: it hides or shows the connector's card. It does not revoke tokens or stop fetching. */
export async function selectConnector(core: SourcesCore, id: string, selected: boolean, signal: AbortSignal): Promise<void> {
  if (!/^[a-z][a-z0-9-]{1,20}$/.test(id)) throw new SourceError("validation");
  if (selected) await callOk(core, "POST", "/auth/me/connectors/add", { id }, signal, SHORT);
  else await callOk(core, "DELETE", `/auth/me/connectors/${id}`, undefined, signal, SHORT);
}

export async function mcpStart(core: SourcesCore, id: string, signal: AbortSignal): Promise<{ authUrl: string | null; state: string; alreadyConnected: boolean }> {
  const b = await callOk<unknown>(core, "POST", "/auth/mcp-connector/start", { id }, signal, SHORT);
  const r = isRecord(b) ? b : {};
  if (typeof r.state !== "string") throw new SourceError("failed");
  return { authUrl: typeof r.authUrl === "string" ? r.authUrl : null, state: r.state, alreadyConnected: r.alreadyConnected === true };
}

export async function mcpStatus(core: SourcesCore, id: string, state: string | null, signal: AbortSignal): Promise<{ connected: boolean; status: string }> {
  const q = `id=${encodeURIComponent(id)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
  const b = await callOk<unknown>(core, "GET", `/auth/mcp-connector/status?${q}`, undefined, signal, SHORT);
  const r = isRecord(b) ? b : {};
  return { connected: r.connected === true, status: str(r.status) };
}

export async function mcpTest(core: SourcesCore, id: string, signal: AbortSignal): Promise<{ server: string; tools: string[] }> {
  const b = await callOk<unknown>(core, "POST", "/kb/mcp-connector/test", { id }, signal, 90_000);
  const r = isRecord(b) ? b : {};
  const tools = (Array.isArray(r.tools) ? r.tools : []).map((t) => (typeof t === "string" ? t : isRecord(t) ? str(t.name) : "")).filter((t) => t !== "").slice(0, 200);
  return { server: str(r.server), tools };
}
