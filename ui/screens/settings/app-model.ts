// Models for the Mac-mirrored groups that talk to the core: Tool permissions, Claude Agent SDK, General preferences.
// Same rules as the other models: typed decoders, errors only through describeError, a failed load never reads as
// an empty (healthy) state, and a mutation answers with the server's own view so the UI re-renders from it.
import { call, type CoreClient } from "./core-api.ts";
import {
  decodeAgentSdk,
  decodeAgentSdkUpdate,
  decodeToolPermissions,
  decodeUserPrefs,
  type AgentSdkStatus,
  type AgentSdkUpdate,
  type LegacyGrant,
  type ToolPermissions,
  type ToolRule,
  type UserPrefs,
} from "./decoders.ts";
import { describeError } from "./errors.ts";
import { scrubSecrets } from "./secret-field.ts";
import { Store } from "./store.ts";

// ---- Tool permissions -----------------------------------------------------------------------------

export const TOOL_PERMISSIONS_TEXT = {
  hint: 'Commands and tools you chose "Always allow" for, per project. Revoking one does not block it: the assistant just asks you again. File edits allowed "in this chat" last only for that chat and are not listed.',
  empty: "Nothing is always allowed. Anything that needs approval asks you each time.",
  legacyTitle: "Older grants (no longer used)",
  revokeAllBody: "The assistant will ask for your approval again the next time. Nothing is blocked and no work is lost.",
} as const;

/** What a rule allows, in words: the whole tool, or one command prefix. */
export function ruleLabel(r: Pick<ToolRule, "toolName" | "pattern">): string {
  return r.pattern ? `${r.toolName}: ${r.pattern}` : `${r.toolName} (any use)`;
}

/** Rules grouped by project, projects in name order (as the Mac lists them). */
export function groupRules(rules: readonly ToolRule[]): { project: string; rules: ToolRule[] }[] {
  const by = new Map<string, ToolRule[]>();
  for (const r of rules) by.set(r.projectRoot, [...(by.get(r.projectRoot) ?? []), r]);
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" }))
    .map(([project, rs]) => ({ project, rules: rs }));
}

export const ruleKey = (r: ToolRule): string => `${r.projectRoot}\u0000${r.toolName}\u0000${r.pattern}`;

export interface ToolPermissionsState {
  perms: ToolPermissions;
  loaded: boolean;
  /** True when the last load failed: "Nothing is always allowed" would be a false claim on a security panel. */
  loadFailed: boolean;
  busy: boolean;
  error: string | null;
}

export class ToolPermissionsModel extends Store<ToolPermissionsState> {
  readonly #c: CoreClient;
  constructor(client: CoreClient) {
    super({ perms: { rules: [], legacy: [] }, loaded: false, loadFailed: false, busy: false, error: null });
    this.#c = client;
  }

  async load(): Promise<void> {
    try {
      const perms = decodeToolPermissions(await call(this.#c, "GET", "/kb/agent/tool-approvals"));
      this.set({ perms, loaded: true, loadFailed: false, error: null });
    } catch (e) {
      this.set({ loaded: true, loadFailed: true, error: describeError(e) });
    }
  }

  revokeRule(rule: ToolRule): Promise<void> {
    return this.#revoke({ projectRoot: rule.projectRoot, toolName: rule.toolName, pattern: rule.pattern });
  }
  removeLegacy(grant: LegacyGrant): Promise<void> {
    return this.#revoke({ toolName: grant.toolName });
  }
  revokeAll(): Promise<void> {
    return this.#revoke({ all: true });
  }

  async #revoke(body: Record<string, unknown>): Promise<void> {
    if (this.getState().busy) return;
    this.set({ busy: true });
    try {
      // The DELETE answers with what remains, so the list renders from the server's own view.
      const perms = decodeToolPermissions(await call(this.#c, "DELETE", "/kb/agent/tool-approvals", body));
      this.set({ perms, loadFailed: false, error: null });
    } catch (e) {
      this.set({ error: describeError(e) });
    } finally {
      this.set({ busy: false });
    }
  }
}

// ---- Claude Agent SDK -----------------------------------------------------------------------------

export const SDK_TEXT = {
  hint: "The chat engine runs on Anthropic's Claude Agent SDK. Updating installs the newest release in the backend's folder; a release that fails to load is rolled back.",
  remoteOff: "Updates are disabled while the backend accepts remote connections.",
  confirmWord: "UPDATE",
  confirmBody: "The update installs the newest SDK release in the backend's folder. It is refused while a chat turn is in progress. After it installs, restart the app to run the new version.",
  restartNote: "Restart the app to run the installed version.",
} as const;

/** The update log as plain text: credential-scrubbed and bounded (it is npm output, shown only as text). */
export function sdkLogText(log: string | null): string | null {
  if (!log) return null;
  const clean = scrubSecrets(log).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return clean.length > 600 ? `${clean.slice(0, 600)}...` : clean;
}

export interface AgentSdkState {
  status: AgentSdkStatus | null;
  checking: boolean;
  updating: boolean;
  result: AgentSdkUpdate | null;
  error: string | null;
}

export class AgentSdkModel extends Store<AgentSdkState> {
  readonly #c: CoreClient;
  constructor(client: CoreClient) {
    super({ status: null, checking: false, updating: false, result: null, error: null });
    this.#c = client;
  }

  /** `force` re-asks the npm registry (the server caches); the default read is cheap. */
  async load(force = false): Promise<void> {
    if (this.getState().checking) return;
    this.set({ checking: true });
    try {
      const status = decodeAgentSdk(await call(this.#c, "GET", force ? "/kb/agent-sdk?force=1" : "/kb/agent-sdk"));
      this.set({ status, error: null });
    } catch (e) {
      this.set({ error: describeError(e) });
    } finally {
      this.set({ checking: false });
    }
  }

  async update(): Promise<void> {
    const s = this.getState();
    if (s.updating || !s.status?.canUpdate) return;
    this.set({ updating: true, result: null });
    try {
      const result = decodeAgentSdkUpdate(await call(this.#c, "POST", "/kb/agent-sdk/update", {}));
      this.set({ result, error: null });
      await this.load(false);
    } catch (e) {
      this.set({ error: describeError(e) });
    } finally {
      this.set({ updating: false });
    }
  }
}

// ---- General preferences (synced: /auth/me/prefs) ----------------------------------------------------

export const LANGUAGES: readonly { id: string; label: string }[] = [
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "zh-CN", label: "简体中文" },
  { id: "ko", label: "한국어" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
];

export const isLanguage = (v: unknown): v is string => typeof v === "string" && LANGUAGES.some((l) => l.id === v);

export const PREFS_TEXT = {
  languageHint: "Language drives every LLM output (notes, plans, agent questions) and applies on this app and the Chrome extension once signed in.",
  nativeTitle: "Let plugins load natively",
  nativeHint: "Claude-format plugins are loaded by the agent engine itself, which then runs their hooks (and background monitors, language servers and bin/ commands) as their author wrote them.",
} as const;

export interface PrefsState {
  prefs: UserPrefs | null;
  saving: boolean;
  /** Last save outcome for the status line. */
  saved: boolean;
  error: string | null;
}

export class UserPrefsModel extends Store<PrefsState> {
  readonly #c: CoreClient;
  constructor(client: CoreClient) {
    super({ prefs: null, saving: false, saved: false, error: null });
    this.#c = client;
  }

  async load(): Promise<void> {
    try {
      this.set({ prefs: decodeUserPrefs(await call(this.#c, "GET", "/auth/me/prefs")), error: null });
    } catch (e) {
      // Stay unloaded: saving placeholder defaults after a failed load would overwrite the real prefs.
      this.set({ prefs: null, error: describeError(e) });
    }
  }

  setLanguage(language: string): Promise<void> {
    if (!isLanguage(language)) return Promise.resolve();
    return this.#save({ language });
  }
  setNativePlugins(on: boolean): Promise<void> {
    return this.#save({ nativePlugins: on });
  }

  async #save(patch: Partial<UserPrefs>): Promise<void> {
    const cur = this.getState().prefs;
    if (!cur || this.getState().saving) return;
    const next: UserPrefs = { ...cur, ...patch };
    this.set({ saving: true, saved: false, prefs: next });
    try {
      // The whole prefs object is sent (as the Mac does) so a field we did not touch keeps its value.
      const body: Record<string, unknown> = {};
      if (next.language !== null) body.language = next.language;
      if (next.bilingual !== null) body.bilingual = next.bilingual;
      if (next.nativePlugins !== null) body.nativePlugins = next.nativePlugins;
      this.set({ prefs: decodeUserPrefs(await call(this.#c, "PUT", "/auth/me/prefs", body)), saved: true, error: null });
    } catch (e) {
      this.set({ prefs: cur, error: describeError(e) }); // roll the control back
    } finally {
      this.set({ saving: false });
    }
  }
}
