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

export const ROLES: readonly { id: string; label: string }[] = [
  { id: "subagents", label: "Sub-agents" },
  { id: "internal", label: "Internal tasks" },
  { id: "loop", label: "Loop" },
];

/** Notes next to switches that only apply when the backend next starts (a restart would end a running turn). */
export const NEXT_START_NOTE = "Applies the next time the backend starts.";
export const SWITCH_TEXT = {
  tools: "Lets a model with the tools badge read files, search and run commands in a chat turn, under the same approvals as Claude; off, these providers answer without tools.",
  egress: "Off by default: fetch-url and web-search ask first on these providers, because a hostile page can steer a model into sending what it has read.",
  fallback: "Off by default: when a provider is rate-limited, try the next one in your list before a turn starts, and say so in the chat.",
  router: `Off by default: adds a per-chat control to pin a provider and model and set a token limit. ${NEXT_START_NOTE}`,
  cap: `Counts input, output and cache-write tokens and stops a chat at its limit with a one-click raise. ${NEXT_START_NOTE}`,
  noConnections: "Connect a provider in Providers to use these switches.",
} as const;

const REASONS: Record<string, string> = {
  no_key: "no key is stored for it",
  not_connected: "it is not connected",
  disabled: "it is switched off",
  not_agent_capable: "it cannot run on the Claude engine",
  unknown_provider: "the provider is not known",
};

export function reasonText(reason: string | undefined): string {
  if (!reason) return "it cannot be used";
  return REASONS[reason] ?? "it cannot be used right now";
}

/** One sentence under a tier row: usable, or why it is skipped. */
export function tierStatusText(s: TierStatus | undefined): string {
  if (!s) return "Not checked yet.";
  if (!s.usable) return `Skipped: ${reasonText(s.reason)}. The default runs instead.`;
  if (s.agentCapable === false) return `Usable for chat. Not on the Claude engine: ${reasonText(s.agentReason)}.`;
  return s.via === "cli" ? "Usable through the signed-in Claude CLI." : "Usable.";
}

export function dropReasonText(reason: string): string {
  if (reason === "unknown_tier") return "that tier is not used by the server";
  if (reason === "unknown_feature") return "that role is not used by the server";
  return "the server did not accept it";
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
  }
  for (const [role, tier] of Object.entries(d.features)) {
    if (!(tier in d.tiers)) return `The ${role} role uses the ${tier} tier, which is not set.`;
  }
  return null;
}

export class RoutingModel extends Store<RoutingState> {
  readonly #client: CoreClient;
  #generation = 0;

  constructor(client: CoreClient) {
    super({ phase: "idle", loaded: null, draft: null, saving: false, error: null, notice: null });
    this.#client = client;
  }

  async load(): Promise<void> {
    const gen = ++this.#generation;
    this.set({ phase: this.getState().loaded ? "ready" : "loading", error: null });
    try {
      const loaded = decodeRoutingTiers(await call(this.#client, "GET", "/kb/routing-tiers"));
      if (gen !== this.#generation) return;
      this.set({ phase: "ready", loaded, draft: { tiers: { ...loaded.tiers }, features: { ...loaded.features } } });
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
    this.set({ draft: { tiers: d.tiers, features }, notice: null });
  }

  revert(): void {
    const l = this.getState().loaded;
    if (l) this.set({ draft: { tiers: { ...l.tiers }, features: { ...l.features } }, error: null, notice: null });
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
      const notice =
        r.dropped.length > 0
          ? `Saved. The server ignored ${r.dropped.length} entr${r.dropped.length === 1 ? "y" : "ies"}: ${r.dropped.map((d) => `${d.entry} (${dropReasonText(d.reason)})`).join("; ")}.`
          : "Saved.";
      this.set({ saving: false, notice });
      await this.load();
      return r;
    } catch (e) {
      this.set({ saving: false, error: describeError(e) });
      return null;
    }
  }
}
