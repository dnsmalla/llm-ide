// Settings -> Model routing: which model each tier and role uses (server tier table), plus
// the fallback/tools switches. The server replaces the WHOLE table on save, so the draft
// always starts from the loaded table and untouched entries are sent back unchanged.
import { call, type CoreClient } from "./core-api.ts";
import { decodeRoutingSave, decodeRoutingTiers, type RoutingSaveResult, type RoutingTiers, type TierChoice, type TierStatus } from "./decoders.ts";
import { describeError } from "./errors.ts";
import { Store } from "./store.ts";

export const TIERS: readonly { id: string; label: string; hint: string }[] = [
  { id: "strong", label: "Strong", hint: "Hard jobs. Optional." },
  { id: "standard", label: "Standard", hint: "The default for new chats and every role left on it." },
  { id: "cheap", label: "Cheap", hint: "Background and bulk work. Optional." },
];

/**
 * Roles that start on Standard in the draft while no tier is saved for them (Decision is never preselected).
 * NOTE: `plan` is deliberately absent. An unset plan role follows the Loop role on the core; writing Standard
 * explicitly on save would defeat that fallback (and an older core would drop it as unknown_feature on every save).
 */
const PRESELECT_ROLES: readonly string[] = ["subagents", "internal", "loop", "autoTasks"];

/**
 * Roles an older core does not know. A core below API 160 drops `features.plan` as unknown_feature on every save, so
 * a choice there could never be kept. Newer cores always report such a role in `featureStatus`, so its presence is the
 * signal (no extra /health call).
 */
const NEWER_ROLES: readonly string[] = ["plan"];

/** Whether the loaded routing data says the core knows `role`. */
export function coreKnowsRole(l: { featureStatus?: Record<string, unknown> }, role: string): boolean {
  return !NEWER_ROLES.includes(role) || (l.featureStatus !== undefined && role in l.featureStatus);
}

/** The roles to list for `l`; a role the core does not know is hidden, since choosing it could never be saved. */
export function visibleRoles(l: { featureStatus?: Record<string, unknown> } | null): readonly { id: string; label: string }[] {
  return l ? ROLES.filter((role) => coreKnowsRole(l, role.id)) : ROLES;
}

/** The text of a role's empty option. */
export function roleEmptyOptionLabel(role: string): string {
  if (role === "plan") return "Follows Loop and Factory";
  return PRESELECT_ROLES.includes(role) ? "Default (built-in)" : "Default";
}

/**
 * The saved routing as a draft; with Standard set, roles that have no saved tier start on Standard, except roles in
 * `declined`: the user chose "Default (built-in)" for them on purpose, and the server has no value that says so
 * (features accept only a tier name), so the choice is remembered client-side (see RoutingModel).
 */
export function draftFromLoaded(
  l: { tiers: Record<string, TierChoice>; features: Record<string, string> },
  declined: ReadonlySet<string> = new Set(),
): RoutingDraft {
  const features = { ...l.features };
  if ("standard" in l.tiers) for (const role of PRESELECT_ROLES) if (!features[role] && !declined.has(role)) features[role] = "standard";
  return { tiers: { ...l.tiers }, features };
}

const DECLINED_KEY = "llmide.routing.declinedPreselect";

function readDeclined(storage: Storage | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DECLINED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string" && PRESELECT_ROLES.includes(r)) : []);
  } catch {
    return new Set();
  }
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Roles the draft put on Standard that are not saved that way yet. */
export function preselectedRoles(loaded: RoutingTiers | null, draft: RoutingDraft | null): string[] {
  if (!loaded || !draft) return [];
  return PRESELECT_ROLES.filter((role) => draft.features[role] === "standard" && !loaded.features[role]);
}

export const PRESELECT_HINT = "Roles without a saved tier are set to Standard; press Save to keep it.";

/**
 * Whether `draft` holds an edit beyond what preselection alone would produce for `loaded`: `isDirty` also counts a
 * fresh preselection as dirty (so Save is offered and the hint shows), but a background refresh (`load(true)`) must
 * tell the two apart — preselection noise is not an edit worth protecting from a refresh, or a focus event would
 * freeze the draft and hide tiers changed elsewhere (another window, another device). A draft with no edits beyond
 * preselection (revert()'s result included) reads as "no edits" here even where `isDirty` reads true.
 */
function hasExplicitEdits(loaded: RoutingTiers | null, draft: RoutingDraft | null, declined: ReadonlySet<string>): boolean {
  if (!loaded || !draft) return false;
  const baseline = draftFromLoaded(loaded, declined);
  return JSON.stringify(sortKeys({ t: baseline.tiers, f: baseline.features })) !== JSON.stringify(sortKeys({ t: draft.tiers, f: draft.features }));
}

export const ROLES: readonly { id: string; label: string }[] = [
  { id: "subagents", label: "Sub-agents" },
  { id: "internal", label: "Internal tasks" },
  { id: "loop", label: "Loop and Factory" },
  { id: "plan", label: "Plan" },
  { id: "autoTasks", label: "Auto Tasks" },
  { id: "decisions", label: "Decision" },
];

/** Optional media models. None is the default; the server stores a choice only when the user makes one. */
export const EXTRA_TIERS: readonly { id: string; label: string; hint: string }[] = [
  { id: "image", label: "Image", hint: "Image generation. None by default." },
  { id: "video", label: "Video", hint: "Video generation. None by default." },
  { id: "decision", label: "Decision", hint: "Calibrated yes/no and pick-one calls. None by default." },
];

/** Notes next to switches that only apply when the backend next starts (a restart would end a running turn). */
export const NEXT_START_NOTE = "Applies the next time the backend starts.";
/** The upgrade-path words, as the Mac's ProviderMigrationText says them (Core/Platform/ProviderMigrationText.swift). */
export const MIGRATION_TEXT = {
  created: (names: string[]) => `Your existing ${names.join(", ")} ${names.length === 1 ? "key was" : "keys were"} added as catalog connections. The old keys are kept.`,
  review: (name: string, reason: string) => `${name} needs review: it was not carried over (${reason}). Connect it in Providers once the address is fixed.`,
  /** The Providers list's own wording (ProviderMigrationText.reviewLine): the connect form is right there. */
  reviewHere: (name: string, reason: string) => `${name} needs review: it was not carried over (${reason}). Connect it below once the address is fixed.`,
  routerNeeded: "Chat on these models runs through the session router. Turning it on applies the next time the backend starts.",
  routerPending: "The session router is on; it applies the next time the backend starts.",
  tools: "Tool turns can read files and run commands, subject to your approvals. Without this, these models still answer in ask and document modes.",
  routerButton: "Turn on the session router",
};

export const SWITCH_TEXT = {
  tools: "Lets a model with the tools badge read files, search and run commands in a chat turn, under the same approvals as Claude; off, these providers answer without tools.",
  egress: "Off by default: fetch-url and web-search ask first on these providers, because a hostile page can steer a model into sending what it has read.",
  fallback: "Off by default: when a provider is rate-limited, try the next one in your list before a turn starts, and say so in the chat.",
  router: `Off by default: adds a per-chat control to pin a provider and model and set a token limit. ${NEXT_START_NOTE}`,
  cap: `Counts input, output and cache-write tokens and stops a chat at its limit with a one-click raise. ${NEXT_START_NOTE}`,
  compress: `Off by default: shortens long prompts before a provider turn to save tokens; needs the per-chat model and token limit. ${NEXT_START_NOTE}`,
  learn: `Off by default: remembers the limits a provider reports and avoids it before it is rate-limited again. ${NEXT_START_NOTE}`,
  continueSummary: `Off by default: a chat you come back to after it ended continues from a short summary made on the provider's fast model plus its last messages, instead of the whole history. The chat says when this happened and lets you send the full history. ${NEXT_START_NOTE}`,
  noConnections: "Connect a provider in Providers to use these switches.",
} as const;

const REASONS: Record<string, string> = {
  no_key: "no key is stored for it",
  not_connected: "it is not connected",
  disabled: "it is switched off",
  not_agent_capable: "it cannot run on the Claude engine",
  unset: "no model is set for it",
  unknown_provider: "the provider is not known",
  cli_untrusted_input: "a signed-in CLI is not used for text from outside, such as tickets and documents",
};

export function reasonText(reason: string | undefined): string {
  if (!reason) return "it cannot be used";
  return REASONS[reason] ?? "it cannot be used right now";
}

/** One sentence under a tier row: usable, or why it is skipped. */
export function tierStatusText(s: TierStatus | undefined): string {
  if (!s) return "Not checked yet.";
  // An agent role (Loop, Auto Tasks) reports the tier it actually runs on, judged against the Claude engine.
  if (s.tier) {
    const name = TIERS.find((t) => t.id === s.tier)?.label ?? s.tier;
    return s.usable ? `Runs on ${name}.` : `${name} cannot run it (${reasonText(s.reason)}); the Claude engine's default model runs instead.`;
  }
  if (!s.usable) return `Skipped: ${reasonText(s.reason)}. The default runs instead.`;
  if (s.agentCapable === false) return `Usable for chat. Not on the Claude engine: ${reasonText(s.agentReason)}.`;
  return s.via === "cli" ? "Usable through the signed-in Claude CLI." : "Usable.";
}

export function dropReasonText(reason: string): string {
  if (reason === "unknown_tier") return "that tier is not used by the server";
  if (reason === "unknown_feature") return "that role is not used by the server";
  if (reason === "invalid_provider") return "that provider id is not supported";
  if (reason === "invalid_model") return "that model id is not valid";
  if (reason === "invalid_shape") return "the entry was not complete";
  return "the server did not accept it";
}

// Same pattern as MODEL_RE in extension/server/tier-routing.mjs: the server drops any other id.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(\[1m\])?$/;
export const MODEL_ID_HELP = "Model id can only contain letters, digits, . _ : / - (no spaces), start with a letter or digit, and be at most 128 characters; [1m] is allowed at the end.";

/** null when the id is one the server accepts, else the plain reason. The server trims first, so does this. */
export function modelIdProblem(model: string): string | null {
  return MODEL_ID_RE.test(model.trim()) ? null : MODEL_ID_HELP;
}

const tierLabel = (id: string): string => [...TIERS, ...EXTRA_TIERS].find((t) => t.id === id)?.label ?? id;
const roleLabel = (id: string): string => ROLES.find((r) => r.id === id)?.label ?? id;

export interface RoleFallback {
  role: string;
  label: string;
  tier: string;
  tierLabel: string;
}

/** Roles whose tier is not set in the draft: the server keeps the role, but the default runs. */
export function roleFallbacks(d: RoutingDraft): RoleFallback[] {
  return Object.entries(d.features)
    .filter(([, tier]) => !(tier in d.tiers))
    .map(([role, tier]) => ({ role, label: roleLabel(role), tier, tierLabel: tierLabel(tier) }));
}

/** A warning above the Roles table, or null when every role's tier is set. */
export function roleFallbackWarning(d: RoutingDraft): string | null {
  const f = roleFallbacks(d);
  if (f.length === 0) return null;
  return `These roles run the default because their tier is not set: ${f.map((x) => `${x.label} (${x.tierLabel})`).join(", ")}.`;
}

/** One sentence for a role row when its tier is not set, else null. */
export function roleStatusText(role: string, d: RoutingDraft): string | null {
  const tier = d.features[role];
  if (!tier && role === "decisions") return "Decisions use the default model until you choose a Decision model.";
  // Loop and Auto Tasks leave the answer to the server: an unsaved one runs on Standard there.
  if (!tier && (role === "subagents" || role === "internal")) return "No tier saved; the built-in default runs.";
  if (!tier || tier in d.tiers) return null;
  return `Uses ${tierLabel(tier)}, which is not set; the default runs.`;
}

export interface RoutingDraft {
  tiers: Record<string, TierChoice>;
  features: Record<string, string>;
}

export interface RoutingState {
  phase: "idle" | "loading" | "ready" | "failed";
  loaded: RoutingTiers | null;
  draft: RoutingDraft | null;
  saving: boolean;
  error: string | null;
  notice: string | null;
  /** warning when the server dropped an entry or a role now runs the default. */
  noticeKind: "info" | "warning";
  /** A Default/Standard choice not saved yet: it is a change even when the table itself is unchanged, so Save stays on. */
  pendingDecision: boolean;
}

export function isDirty(loaded: RoutingTiers | null, draft: RoutingDraft | null): boolean {
  if (!loaded || !draft) return false;
  return JSON.stringify(sortKeys({ t: loaded.tiers, f: loaded.features })) !== JSON.stringify(sortKeys({ t: draft.tiers, f: draft.features }));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
}

/** Validates a draft before sending: every tier needs both a provider and a model, every role a known tier. */
export function validateDraft(d: RoutingDraft): string | null {
  for (const [id, t] of Object.entries(d.tiers)) {
    if (!t.provider.trim() || !t.model.trim()) return `Pick a provider and a model for ${id}, or remove the tier.`;
    const bad = modelIdProblem(t.model);
    if (bad) return `${tierLabel(id)}: ${bad}`;
  }
  for (const [role, tier] of Object.entries(d.features)) {
    if (!(tier in d.tiers)) return `${roleLabel(role)} uses ${tierLabel(tier)}, which is not set. Set ${tierLabel(tier)}, or change ${roleLabel(role)} to ${roleEmptyOptionLabel(role)}.`;
  }
  return null;
}

export class RoutingModel extends Store<RoutingState> {
  readonly #client: CoreClient;
  #generation = 0;
  readonly #storage: Storage | null;
  /** Preselect roles the user explicitly set to Default and saved; persisted in the webview's localStorage (best effort). */
  #persisted: Set<string>;
  /** `#persisted` plus unsaved Default/Standard picks; written to storage only after a successful save. */
  #declined: Set<string>;

  constructor(client: CoreClient, storage: Storage | null = defaultStorage()) {
    super({ phase: "idle", loaded: null, draft: null, saving: false, error: null, notice: null, noticeKind: "info", pendingDecision: false });
    this.#client = client;
    this.#storage = storage;
    this.#persisted = readDeclined(storage);
    this.#declined = new Set(this.#persisted);
  }

  #setDeclined(role: string, declined: boolean): void {
    if (!PRESELECT_ROLES.includes(role)) return;
    if (declined) this.#declined.add(role);
    else this.#declined.delete(role);
  }

  #pending(): boolean {
    return this.#declined.size !== this.#persisted.size || [...this.#declined].some((r) => !this.#persisted.has(r));
  }

  /** Called once a save succeeded: only then is a Default choice a decision worth remembering. */
  #commitDeclined(): void {
    this.#persisted = new Set(this.#declined);
    try {
      this.#storage?.setItem(DECLINED_KEY, JSON.stringify([...this.#persisted]));
    } catch {
      // NOTE: storage is optional; the in-memory set still holds for this session.
    }
  }

  /**
   * Loads the saved tiers. `keepEdits` is for background refreshes (window focus): unsaved edits made before or
   * during the request stay in the draft, and only `loaded` moves. A plain load replaces the draft.
   */
  async load(keepEdits = false): Promise<void> {
    const gen = ++this.#generation;
    if (!keepEdits) this.#declined = new Set(this.#persisted);
    this.set({ phase: this.getState().loaded ? "ready" : "loading", error: null });
    try {
      const loaded = decodeRoutingTiers(await call(this.#client, "GET", "/kb/routing-tiers"));
      if (gen !== this.#generation) return;
      const now = this.getState();
      if (keepEdits && hasExplicitEdits(now.loaded, now.draft, this.#declined)) {
        this.set({ phase: "ready", loaded });
        return;
      }
      this.set({ phase: "ready", loaded, draft: draftFromLoaded(loaded, this.#declined), pendingDecision: this.#pending() });
    } catch (e) {
      if (gen !== this.#generation) return;
      this.set({ phase: this.getState().loaded ? "ready" : "failed", error: describeError(e) });
    }
  }

  setTier(id: string, choice: TierChoice | null): void {
    const d = this.getState().draft;
    if (!d) return;
    const tiers = { ...d.tiers };
    if (choice) tiers[id] = choice;
    else delete tiers[id];
    // A role on a removed tier goes back to its default (no entry).
    const features = Object.fromEntries(Object.entries(d.features).filter(([, t]) => t in tiers));
    this.set({ draft: { tiers, features }, notice: null });
  }

  setRole(role: string, tier: string | null): void {
    const d = this.getState().draft;
    if (!d) return;
    const features = { ...d.features };
    if (tier) features[role] = tier;
    else delete features[role];
    // An explicit Default must outlive Save and reload: without this mark the reload would preselect Standard again.
    this.#setDeclined(role, !tier);
    this.set({ draft: { tiers: d.tiers, features }, notice: null, pendingDecision: this.#pending() });
  }

  /** Back to the saved table, with the same preselection a fresh load shows, so a later focus refresh sees no edits. */
  revert(): void {
    const l = this.getState().loaded;
    this.#declined = new Set(this.#persisted);
    if (l) this.set({ draft: draftFromLoaded(l, this.#declined), error: null, notice: null, pendingDecision: false });
    else this.set({ pendingDecision: false });
  }

  async save(): Promise<RoutingSaveResult | null> {
    const s = this.getState();
    if (!s.draft || s.saving) return null;
    const bad = validateDraft(s.draft);
    if (bad) {
      this.set({ error: bad });
      return null;
    }
    this.set({ saving: true, error: null, notice: null });
    this.#generation++;
    try {
      const r = decodeRoutingSave(await call(this.#client, "POST", "/kb/routing-tiers", { tiers: s.draft.tiers, features: s.draft.features }));
      const head =
        r.dropped.length > 0
          ? `Saved. The server ignored ${r.dropped.length} entr${r.dropped.length === 1 ? "y" : "ies"}: ${r.dropped.map((d) => `${d.entry} (${dropReasonText(d.reason)})`).join("; ")}.`
          : "Saved.";
      const droppedTiers = new Set(r.dropped.filter((d) => d.entry.startsWith("tiers.")).map((d) => d.entry.slice("tiers.".length)));
      const roles = Object.entries(s.draft.features).filter(([, tier]) => droppedTiers.has(tier));
      const roleText = roles.map(([role, tier]) => `${roleLabel(role)} now uses the default because ${tierLabel(tier)} is not set.`);
      const notice = [head, ...roleText].join(" ");
      this.#commitDeclined();
      this.set({ saving: false, notice, noticeKind: r.dropped.length > 0 ? "warning" : "info", pendingDecision: false });
      await this.load();
      return r;
    } catch (e) {
      this.set({ saving: false, error: describeError(e) });
      return null;
    }
  }
}
