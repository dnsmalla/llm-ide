// Non-secret source settings (hosts, folders, channel ids, look-back windows): validators and a small
// persisted store. Pure; the store takes a storage object so tests do not need a DOM.
//
// Where it lives: `localStorage` of the desktop webview, under one versioned key. This is convenience state,
// not a secret and not a copy of any note: losing it means retyping a form. It is re-validated on every load
// (a hand-edited or corrupt value is dropped, never trusted). Credentials are NOT here: they go to the core's
// vault (`source-core.ts`). The Mac keeps the same settings in its app config; there is no shared copy yet.

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  mailbox: string;
  authMethod: "password" | "google";
  lookbackDays: number;
  unreadOnly: boolean;
  fromFilter: string;
  markRead: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
}

export interface SlackConfig {
  channels: SlackChannel[];
  lookbackDays: number;
}

export interface BoxConfig {
  clientId: string;
  subjectType: "enterprise" | "user";
  subjectId: string;
  folderId: string;
}

export interface GithubIssuesConfig {
  repo: string;
  state: "open" | "closed" | "all";
}

export interface SourceConfigs {
  email: EmailConfig | null;
  slack: SlackConfig | null;
  box: BoxConfig | null;
  github: GithubIssuesConfig | null;
}

export const EMPTY_CONFIGS: SourceConfigs = { email: null, slack: null, box: null, github: null };

export const DEFAULT_EMAIL: EmailConfig = { host: "imap.gmail.com", port: 993, secure: true, user: "", mailbox: "INBOX", authMethod: "password", lookbackDays: 7, unreadOnly: false, fromFilter: "", markRead: false };
export const DEFAULT_SLACK: SlackConfig = { channels: [], lookbackDays: 7 };
export const DEFAULT_BOX: BoxConfig = { clientId: "", subjectType: "enterprise", subjectId: "", folderId: "0" };
export const DEFAULT_GITHUB: GithubIssuesConfig = { repo: "", state: "open" };

export type Problems<T> = Partial<Record<keyof T, string>>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOST = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const intIn = (n: unknown, lo: number, hi: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

export function validateEmail(c: EmailConfig): Problems<EmailConfig> {
  const p: Problems<EmailConfig> = {};
  if (!HOST.test(c.host.trim())) p.host = "Enter a server name such as imap.gmail.com (no https:// and no slashes).";
  if (!intIn(c.port, 1, 65535)) p.port = "Use a port from 1 to 65535 (993 is the usual secure IMAP port).";
  if (c.user.trim() === "" || c.user.length > 254 || CONTROL.test(c.user) || /\s/.test(c.user.trim())) p.user = "Enter the mailbox user name, usually the full email address.";
  if (c.mailbox.trim() === "" || c.mailbox.length > 200 || CONTROL.test(c.mailbox)) p.mailbox = "Enter a mailbox name such as INBOX.";
  if (c.authMethod !== "password" && c.authMethod !== "google") p.authMethod = "Choose how to sign in.";
  if (!intIn(c.lookbackDays, 1, 90)) p.lookbackDays = "Use 1 to 90 days.";
  if (c.fromFilter.length > 200 || CONTROL.test(c.fromFilter)) p.fromFilter = "Use at most 200 characters on one line.";
  return p;
}

export function validateSlackChannelId(id: string): boolean {
  return /^[CGD][A-Z0-9]{8,14}$/.test(id.trim());
}

export function validateSlack(c: SlackConfig): Problems<SlackConfig> {
  const p: Problems<SlackConfig> = {};
  if (c.channels.length === 0) p.channels = "Pick at least one channel.";
  else if (c.channels.length > 100) p.channels = "Pick at most 100 channels.";
  else if (c.channels.some((ch) => !validateSlackChannelId(ch.id))) p.channels = "A channel id looks wrong (ids start with C, G or D).";
  if (!intIn(c.lookbackDays, 1, 90)) p.lookbackDays = "Use 1 to 90 days.";
  return p;
}

export function validateBox(c: BoxConfig): Problems<BoxConfig> {
  const p: Problems<BoxConfig> = {};
  if (!/^[A-Za-z0-9]{6,64}$/.test(c.clientId.trim())) p.clientId = "The client id is letters and digits only (from your Box app's configuration).";
  if (c.subjectType !== "enterprise" && c.subjectType !== "user") p.subjectType = "Choose enterprise or user.";
  if (!/^\d{1,20}$/.test(c.subjectId.trim())) p.subjectId = "The enterprise or user id is a number.";
  if (!/^\d{1,20}$/.test(c.folderId.trim())) p.folderId = "The folder id is the number at the end of the folder's Box address (0 is the root).";
  return p;
}

export function validateGithub(c: GithubIssuesConfig): Problems<GithubIssuesConfig> {
  const p: Problems<GithubIssuesConfig> = {};
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(c.repo.trim())) p.repo = "Use owner/name, for example acme/website.";
  if (!["open", "closed", "all"].includes(c.state)) p.state = "Choose open, closed or all.";
  return p;
}

export type SecretKind = "email" | "slack" | "box";

/** Why a typed secret cannot be saved, or null. Slack tokens get a prefix check; nothing else is guessed about shape. */
export function secretProblem(kind: SecretKind, value: string): string | null {
  if (value === "") return "Enter a value.";
  if (value.length > 4096) return "That is too long to be a credential.";
  if (CONTROL.test(value) || value !== value.trim()) return "Remove spaces and line breaks around the value.";
  if (kind === "slack" && !/^xox[bpas]-/.test(value)) return "A Slack token starts with xoxb- (bot) or xoxp- (user).";
  return null;
}

// ---- persistence -----------------------------------------------------------------------------

export const CONFIG_KEY = "llmide.library.sources.v1";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** Re-validates an untrusted value into `SourceConfigs`: every section that fails its validator is dropped. */
export function sanitizeConfigs(raw: unknown): SourceConfigs {
  if (!isRecord(raw)) return EMPTY_CONFIGS;
  const out: SourceConfigs = { email: null, slack: null, box: null, github: null };
  if (isRecord(raw.email)) {
    const e = raw.email;
    const c: EmailConfig = {
      host: s(e.host).trim(),
      port: typeof e.port === "number" ? e.port : 993,
      secure: e.secure !== false,
      user: s(e.user).trim(),
      mailbox: s(e.mailbox, "INBOX"),
      authMethod: e.authMethod === "google" ? "google" : "password",
      lookbackDays: typeof e.lookbackDays === "number" ? e.lookbackDays : 7,
      unreadOnly: e.unreadOnly === true,
      fromFilter: s(e.fromFilter),
      markRead: e.markRead === true,
    };
    if (Object.keys(validateEmail(c)).length === 0) out.email = c;
  }
  if (isRecord(raw.slack)) {
    const chans: SlackChannel[] = [];
    for (const ch of Array.isArray(raw.slack.channels) ? raw.slack.channels : []) {
      if (isRecord(ch) && typeof ch.id === "string" && validateSlackChannelId(ch.id)) chans.push({ id: ch.id.trim(), name: s(ch.name).slice(0, 80).replace(CONTROL, "") });
    }
    const c: SlackConfig = { channels: chans.slice(0, 100), lookbackDays: typeof raw.slack.lookbackDays === "number" ? raw.slack.lookbackDays : 7 };
    if (Object.keys(validateSlack(c)).length === 0) out.slack = c;
  }
  if (isRecord(raw.box)) {
    const c: BoxConfig = { clientId: s(raw.box.clientId).trim(), subjectType: raw.box.subjectType === "user" ? "user" : "enterprise", subjectId: s(raw.box.subjectId).trim(), folderId: s(raw.box.folderId, "0").trim() };
    if (Object.keys(validateBox(c)).length === 0) out.box = c;
  }
  if (isRecord(raw.github)) {
    const st = raw.github.state;
    const c: GithubIssuesConfig = { repo: s(raw.github.repo).trim(), state: st === "closed" || st === "all" ? st : "open" };
    if (Object.keys(validateGithub(c)).length === 0) out.github = c;
  }
  return out;
}

export function loadConfigs(storage: KeyValueStorage | null): SourceConfigs {
  try {
    const raw = storage?.getItem(CONFIG_KEY);
    return raw ? sanitizeConfigs(JSON.parse(raw)) : EMPTY_CONFIGS;
  } catch {
    return EMPTY_CONFIGS;
  }
}

/** Persists (best effort: a blocked or full storage is not an error the user can act on). */
export function saveConfigs(storage: KeyValueStorage | null, c: SourceConfigs): boolean {
  try {
    storage?.setItem(CONFIG_KEY, JSON.stringify(c));
    return storage !== null;
  } catch {
    return false;
  }
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
