// Mode, model and cap rules, ported from the Mac (`ChatRouteLogic`, `ComposerCatalog`, `ModePolicy`,
// `EditAcceptanceMode`) so both clients behave the same. Pure; the HTTP wrappers are at the bottom.
import type { CoreTransport } from "./transport";

// --- modes ----------------------------------------------------------------------------------

export const AUTO_MODE = "auto";
export interface ModeOption { id: string; label: string; hint: string }

/** `MODES` of extension/llm_agent/modes/mode-classify.mjs plus the client-side `auto`. */
export const MODES: readonly ModeOption[] = [
  { id: "auto", label: "Auto", hint: "Claude classifies your request and picks a mode itself" },
  { id: "ask", label: "Ask", hint: "Answer a question about this project, read-only (no edit or command tools)" },
  { id: "plan", label: "Plan", hint: "Work up a design together, then write and save the plan; no file edits or commands except saving it" },
  { id: "assist_plan", label: "Assist Plan", hint: "Same pipeline, but grills your stated plan in rounds of numbered questions; no file edits or commands except saving it" },
  { id: "review", label: "Code Review", hint: "Give code-review feedback; no file edits or commands" },
  { id: "document", label: "Document", hint: "Write documentation in the reply; no file edits or commands" },
  { id: "execute", label: "Execute", hint: "Today's full agentic behaviour: file edits, commands, tools" },
];
/** Modes that never edit files or run commands (the popup chat offers only these). */
export const READ_ONLY_MODES: ReadonlySet<string> = new Set(["ask", "plan", "assist_plan", "review", "document"]);
export const KNOWN_MODES: ReadonlySet<string> = new Set(MODES.map((m) => m.id));

/** Only Auto follows the server's resolved mode; a hand-picked mode is never moved. */
export function pickerMode(current: string, resolved: string): string | null {
  return current === AUTO_MODE && resolved !== AUTO_MODE && KNOWN_MODES.has(resolved) ? resolved : null;
}
/** A mode is chosen FOR a conversation: a new, cleared or switched chat starts on Auto. */
export const pickerModeAfterSessionChange = (): string => AUTO_MODE;

export type PermissionMode = "ask" | "accept-edits" | "bypass";
export interface PermissionOption { id: PermissionMode; label: string; hint: string }
export const PERMISSION_MODES: readonly PermissionOption[] = [
  { id: "ask", label: "Ask", hint: "Ask before each file edit and shell command. \"Always allow\" on a card remembers that command for this project." },
  { id: "accept-edits", label: "Accept Edits", hint: "Apply file edits in the project without asking; still ask before shell commands." },
  { id: "bypass", label: "Bypass", hint: "Apply edits and run commands without asking. Blocked commands and writes outside the project are still refused." },
];
// Bypass approval (host-signed token, per-chat grant): see ./bypass.ts.

// --- models ---------------------------------------------------------------------------------

export interface ModelChoice {
  provider: string;
  model: string;
  label: string;
  /** Catalog models only: tool support from the catalog. */
  toolsSupported?: boolean;
  /** Claude models only: the SDK's effort levels for this model (`[]` = none). */
  effortLevels?: string[];
}
export interface ModelGroup { id: string; label: string; catalog: boolean; models: ModelChoice[]; note?: string; /** The provider a model id of this group runs on (the connection's; Claude's is "anthropic"). */ provider?: string }

export const toolsBadge = (toolsSupported: boolean): string => (toolsSupported ? "tools" : "no tools");

const TOOL_MODES: ReadonlySet<string> = new Set(["auto", "execute", "plan", "assist_plan", "review"]);
export type PlainChatReason = "toolsOff" | "modelLacksTools";

/** Why a turn on the selected model runs as plain chat (no tools), or null. Claude never shows it. */
export function plainChatReason(provider: string, model: string, mode: string, groups: readonly ModelGroup[], toolsEnabled: boolean): PlainChatReason | null {
  if (!provider.startsWith("custom:cat-") || !TOOL_MODES.has(mode)) return null;
  if (!toolsEnabled) return "toolsOff";
  const listed = groups.flatMap((g) => g.models).find((m) => m.provider === provider && m.model === model);
  return listed?.toolsSupported === true ? null : "modelLacksTools";
}
export const PLAIN_CHAT_TITLE = "Plain chat (no tools)";
export const plainChatDetail = (r: PlainChatReason): string => r === "toolsOff"
  ? "Tools are off for provider models, so this model answers without reading files or running commands."
  : "This model is not known to support tools. Pick one with the tools badge for edits and commands.";

// --- cap (billable-token session limit) ------------------------------------------------------

export type CapLevel = "none" | "ok" | "warn" | "reached";
export const CAP_PRESETS: readonly number[] = [50_000, 200_000, 1_000_000, 5_000_000];
export const CAP_MAX = 1_000_000_000_000;

/** The Mac's tooltip on "Raise the limit" (ChatRouteControl). */
export const RAISE_LIMIT_HELP = "Raises the limit by half again (at least 50k above what is used)";

export function capLevel(used: number, limit: number | null): CapLevel {
  if (limit === null || limit <= 0) return "none";
  if (used >= limit) return "reached";
  return used >= limit * 0.8 ? "warn" : "ok";
}

/** `undefined` = not a number; `null` = no cap. Accepts 50000, 50,000, 200k, 1.5m. */
export function parseLimit(text: string): number | null | undefined {
  const t = text.trim().toLowerCase().replaceAll(",", "");
  if (t === "" || t === "none" || t === "off" || t === "no limit" || t === "0") return null;
  let mult = 1, digits = t;
  if (t.endsWith("k")) { mult = 1_000; digits = t.slice(0, -1); }
  else if (t.endsWith("m")) { mult = 1_000_000; digits = t.slice(0, -1); }
  if (!/^\d+(\.\d+)?$/.test(digits)) return undefined;
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (mult === 1 && !Number.isInteger(value)) return undefined;
  const tokens = Math.round(value * mult);
  return tokens >= 1 && tokens <= CAP_MAX ? tokens : undefined;
}

export function compactTokens(n: number): string {
  const v = Math.max(0, n);
  const trim = (x: number) => { const r = Math.round(x * 10) / 10; return Number.isInteger(r) ? String(r) : String(r); };
  if (v >= 1_000_000) return `${trim(v / 1_000_000)}m`;
  if (v >= 1_000) return `${trim(v / 1_000)}k`;
  return String(Math.trunc(v));
}

export function meterText(used: number, limit: number | null, cacheRead = 0): string {
  let s = compactTokens(used);
  if (limit !== null && limit > 0) s += ` / ${compactTokens(limit)}`;
  if (cacheRead > 0) s += ` (+${compactTokens(cacheRead)} cached reads)`;
  return s;
}

/**
 * The header route chip's text (the Mac's ChatRouteControl label): the pinned model, else "Route", then the meter once
 * a limit is set or tokens were used. Pure.
 */
export function capChipText(route: Pick<RouteView, "pinned" | "model" | "tokenLimit" | "used">): string {
  const name = route.pinned && route.model ? route.model : "Route";
  const used = route.used.billable;
  return route.tokenLimit !== null || used > 0 ? `${name} · ${meterText(used, route.tokenLimit, route.used.cacheRead)}` : name;
}

/** One-click raise at the cap: 50 percent more, at least 50k above usage, whole thousands, within the bound. */
export function raisedLimit(current: number, used: number): number {
  const grown = Math.ceil(Math.max(current, 1) * 1.5);
  const floor = Math.max(used, current) + 50_000;
  return Math.min(Math.ceil(Math.max(grown, floor) / 1000) * 1000, CAP_MAX);
}

export function coldSwitchWarning(estimatedTokens: number): string {
  const n = estimatedTokens > 0 ? `about ${compactTokens(estimatedTokens)} tokens` : "one full prompt";
  return `Switching loses the prompt cache: the next turn pays ${n} to catch up. The conversation itself is kept.`;
}
export const CAP_APPROXIMATION_NOTE = "The limit is approximate to one reply.";
/** The Mac's "Counted:" sentence under the meter (ChatRouteControl.meterBlock): what the cap meter counts. */
export const CAP_COUNTED_NOTE = "Counted: input + output + cache writes. Cached reads are shown, not counted.";
/** Shown when a limit is saved but the server runs without the cap switch (ChatRouteControl.meterBlock). */
export const CAP_NOT_ENFORCED = "The limit is saved but not enforced: the server runs without the cap switch.";

/** The Mac's hint bar (ChatComposer.agentV2ProviderHintBar) when the composer's provider can no longer run a chat. */
export const PROVIDER_BLOCKED_NOTE = "Chat runs on Claude, a custom provider with an Anthropic-compatible URL, or a catalog model through the session router. This provider cannot run a chat any more: pick another model, or connect it in Settings, Providers.";

/**
 * True when a chosen provider is one this client can no longer chat with: not Claude, and not offered by any loaded
 * group (a group that failed to list its models counts as offered, so an outage is not reported as a blocked provider).
 */
export function providerCannotChat(provider: string | null | undefined, groups: readonly ModelGroup[]): boolean {
  if (!provider || provider === "anthropic") return false;
  return !groups.some((g) => g.note !== undefined || g.models.some((m) => m.provider === provider));
}

/** The Mac's delete-chat confirmation (ChatSessionHeader.swift): the title and the sentence under it. */
export const DELETE_CHAT_TITLE = "Delete this chat?";
export const DELETE_CHAT_DETAIL = "The conversation and its memory are removed. This cannot be undone.";

/**
 * What a model-picker choice does. A model is chosen for the composer (its own model, what the next send uses), and
 * with the route on it also pins the chat. "Default" is the Mac's "Not pinned (the composer's model)": it only unpins a
 * pinned route and leaves the composer's model alone. Pure.
 */
export interface ModelPickPlan {
  /** The composer's new model, or null when the composer keeps its own. */
  composer: { provider: string; model: string } | null;
  /** "pin" saves the choice on the route, "unpin" clears a pinned route, null sends nothing. */
  route: "pin" | "unpin" | null;
}
export function modelPickPlan(route: Pick<RouteView, "enabled" | "pinned"> | null, provider: string, model: string): ModelPickPlan {
  const on = route?.enabled === true;
  if (provider) return { composer: { provider, model }, route: on ? "pin" : null };
  // Router off: there is no route to unpin, so "Default" is the core's default model for the composer (never a dead option).
  if (!on) return { composer: { provider: "", model: "" }, route: null };
  return { composer: null, route: route?.pinned === true ? "unpin" : null };
}

/**
 * What the model select shows. With the router on and the chat not pinned it shows the "Not pinned" option (the Mac's
 * route picker), so an unpin is visible; otherwise the composer's own choice. Pure.
 */
export function modelPickerValue(route: ModelPickerRoute | null | undefined, provider: string | null, model: string | null): string {
  if (route?.enabled === true) {
    // A switch saved during a turn is what the chat will run next, so it is what the picker shows.
    const held = route.pending ?? (route.pinned === true ? route : null);
    return held && held.provider && held.model ? `${held.provider}|${held.model}` : "";
  }
  return provider && model ? `${provider}|${model}` : "";
}
export type ModelPickerRoute = Pick<RouteView, "enabled" | "pinned"> & Partial<Pick<RouteView, "provider" | "model" | "pending">>;

/**
 * One model option's text. The chosen one names its provider ("Groq · llama-3"), so the closed picker shows the
 * provider and the model as the Mac's composer chip does; the open list keeps the bare name under its group. Pure.
 */
export function modelOptionText(g: Pick<ModelGroup, "label" | "catalog">, m: Pick<ModelChoice, "label" | "toolsSupported">, chosen: boolean): string {
  const badge = g.catalog && m.toolsSupported !== undefined ? `  (${toolsBadge(m.toolsSupported)})` : "";
  return `${chosen ? `${g.label} · ` : ""}${m.label}${badge}`;
}
/** The Mac's one row at the bottom of the menu while only Claude is set up (ComposerCatalog.moreProvidersHint). */
export const MORE_PROVIDERS_HINT = "More providers: Settings → Providers";

/** The select's empty option: "Default" with the router off, the Mac's "Not pinned (the composer's model)" with it on. */
export function modelDefaultLabel(route: Pick<RouteView, "enabled"> | null | undefined, composerModelLabel: string | null, detected?: string | null): string {
  if (route?.enabled !== true) return detected ? `Auto · ${detected}` : "Default";
  if (composerModelLabel) return `Not pinned (the composer's model: ${composerModelLabel})`;
  return detected ? `Not pinned (auto: ${detected})` : "Not pinned (the composer's model)";
}

/**
 * A refused pin puts the previous choice back, but only while the picker still shows the pick that failed: a later
 * pick made while the save was in flight is not overwritten. Pure.
 */
export function restoreFailedPick<P extends { mode: string; provider: string | null; model: string | null }>(prefs: Readonly<Record<string, P>>, chatId: string, failed: { provider: string; model: string }, prev: { provider: string | null; model: string | null }): Readonly<Record<string, P>> {
  const cur = prefs[chatId];
  if (!cur || (cur.provider ?? "") !== failed.provider || (cur.model ?? "") !== failed.model) return prefs;
  return patchChatPrefs(prefs, chatId, prev as Partial<P>);
}

/** Sets some fields of one chat's remembered picker choices; a chat with none remembered is left as it is. Pure. */
export function patchChatPrefs<P extends { mode: string; provider: string | null; model: string | null }>(prefs: Readonly<Record<string, P>>, chatId: string, patch: Partial<P>): Readonly<Record<string, P>> {
  const cur = prefs[chatId];
  return cur ? { ...prefs, [chatId]: { ...cur, ...patch } } : prefs;
}

/** A turn just ended on a chat whose route is on: re-read the route so a pending switch and the meter show what the core applied. */
export function routeRereadDue(wasBusy: boolean, busy: boolean, chatId: string | null, routeEnabled: boolean | undefined): boolean {
  return wasBusy && !busy && !!chatId && routeEnabled === true;
}

// --- HTTP wrappers --------------------------------------------------------------------------

export interface RouteView {
  enabled: boolean;
  capEnforced: boolean;
  chatSessionId: string;
  provider: string;
  model: string;
  pinned: boolean;
  tokenLimit: number | null;
  used: { in: number; out: number; cacheWrite: number; cacheRead: number; billable: number };
  remaining: number | null;
  switchSeq: number;
  /** A switch saved while a turn runs; it applies at that turn's end (`appliesAt: "next_turn"`). */
  pending?: { provider: string; model: string; pinnedBy?: string; requestedAt?: string } | null;
}

export async function getRoute(core: CoreTransport, chatSessionId: string, signal?: AbortSignal): Promise<RouteView> {
  return core.json<RouteView>("GET", `/agent/v2/session/route?chatSessionId=${encodeURIComponent(chatSessionId)}`, undefined, signal);
}

export interface RoutePatch { provider?: string; model?: string; tokenLimit?: number | null; ifSeq?: number }
export interface RoutePutResult extends RouteView { appliesAt?: string; changed?: boolean; coldSwitch?: boolean; estimatedPrefillTokens?: number }

export async function putRoute(core: CoreTransport, chatSessionId: string, patch: RoutePatch, signal?: AbortSignal): Promise<RoutePutResult> {
  return core.json<RoutePutResult>("PUT", "/agent/v2/session/route", { chatSessionId, ...patch }, signal);
}

/** POST /agent/v2/cancel: kills the turn on the server (the client abort alone leaves the lock held for a while). */
export async function cancelTurn(core: CoreTransport, chatSessionId: string): Promise<boolean> {
  const r = await core.json<{ cancelled?: boolean }>("POST", "/agent/v2/cancel", { chatSessionId });
  return r?.cancelled === true;
}

interface SdkModelEntry { id: string; displayName?: string; name?: string; effortLevels?: string[] }
interface CatalogProvider { id: string; name: string; keyRequired?: boolean; connections: Array<{ id: string; provider: string; name: string; enabled: boolean; hasKey: boolean }> }
/** GET /kb/providers/custom rows: Claude-compatible endpoints (`connection` = connected in Settings, `synced` = the retired Mac's list). */
interface ClaudeCompatible { id: string; provider: string; name: string; enabled: boolean; hasKey: boolean; source: "connection" | "synced" }

/** One connection's models as a group (POST /kb/providers/catalog/models); a failed listing is a note, an abort rethrows. */
async function connectionGroup(core: CoreTransport, c: { id: string; provider: string; name: string }, catalog: boolean, signal?: AbortSignal): Promise<ModelGroup> {
  const base = { id: c.id, label: c.name, catalog, provider: c.provider };
  try {
    const m = await core.json<{ models?: Array<{ id: string; toolsSupported?: boolean }> }>("POST", "/kb/providers/catalog/models", { id: c.id }, signal);
    return { ...base, models: (m.models ?? []).map((x) => ({ provider: c.provider, model: x.id, label: x.id, ...(catalog ? { toolsSupported: x.toolsSupported === true } : {}) })) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ...base, models: [], note: "Could not list models." };
  }
}

/**
 * Every provider the chat can run, in the Mac's menu order (CodeAssistantModelState.composerProviderSections): Claude (the
 * SDK's live list, always first), the Claude-compatible endpoints connected in Settings, then one group per enabled
 * catalog connection that has a key or needs none (a local server).
 */
export async function loadModelGroups(core: CoreTransport, signal?: AbortSignal): Promise<{ groups: ModelGroup[]; toolsEnabled: boolean }> {
  const groups: ModelGroup[] = [];
  try {
    const r = await core.json<{ models?: string[]; entries?: SdkModelEntry[]; detail?: string }>("POST", "/kb/providers/models", { provider: "anthropic" }, signal);
    const entries: SdkModelEntry[] = r.entries ?? (r.models ?? []).map((id) => ({ id }));
    groups.push({
      id: "anthropic", label: "Claude", catalog: false, provider: "anthropic",
      models: entries.map((e) => ({ provider: "anthropic", model: e.id, label: e.displayName ?? e.name ?? e.id, effortLevels: Array.isArray(e.effortLevels) ? e.effortLevels.filter((l): l is string => typeof l === "string" && l.length > 0) : [] })),
      // The core answers 200 with no models and a reason when the SDK and the key listing both fail: say why.
      ...(entries.length === 0 ? { note: r.detail ? `The model list is unavailable: ${r.detail}` : "The model list is unavailable." } : {}),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    groups.push({ id: "anthropic", label: "Claude", catalog: false, provider: "anthropic", models: [], note: "The model list is unavailable." });
  }
  try {
    const cc = await core.json<{ providers?: ClaudeCompatible[] }>("GET", "/kb/providers/custom", undefined, signal);
    // shortcut: `synced` rows (the retired Mac's list) carry no model list on this route; listed once the core serves one.
    for (const c of (cc.providers ?? []).filter((x) => x.source === "connection" && x.enabled && x.hasKey)) groups.push(await connectionGroup(core, c, false, signal));
  } catch (e) {
    if (signal?.aborted) throw e; // older core without the route: no Claude-compatible groups
  }
  let toolsEnabled = false;
  try {
    const cat = await core.json<{ providers?: CatalogProvider[]; settings?: { toolsEnabled?: boolean } }>("GET", "/kb/providers/catalog", undefined, signal);
    toolsEnabled = cat.settings?.toolsEnabled === true;
    for (const p of cat.providers ?? []) {
      for (const c of p.connections.filter((x) => x.enabled && (x.hasKey || p.keyRequired === false))) {
        groups.push(await connectionGroup(core, { ...c, name: c.name || p.name }, true, signal));
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e; // catalog unavailable: Claude only
  }
  return { groups, toolsEnabled };
}

/**
 * Whether the progress header shows: only during a plan run started from this chat's plan card (the Mac's
 * PlanExecutionCard rides a PlanExecutionTracker), never for an ordinary turn's task list. Pure.
 */
export function showsPlanProgress(planRunChatId: string | null, activeId: string | null, tasks: readonly unknown[]): boolean {
  return planRunChatId !== null && planRunChatId === activeId && tasks.length > 0;
}

/**
 * The plan run's progress from its task list (the Mac's PlanExecutionCard): "Step n of N", how many steps are done
 * (completed or skipped), and the percentage. Pure.
 */
export function planProgress(tasks: readonly { status: string }[]): { total: number; done: number; current: number; percent: number } {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed" || t.status === "skipped").length;
  const running = tasks.some((t) => t.status === "in_progress") ? 1 : 0;
  const current = Math.min(done + running, total);
  return { total, done, current, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/** Chat modes that should prefer a cheap model; everything else prefers the strongest listed model. */
const CHEAP_MODES: ReadonlySet<string> = new Set(["ask", "document", "review"]);
const CHEAP = /(haiku|mini|flash|small|nano|lite|8b|7b)/i;
const STRONG = /(opus|sonnet|pro|max|large|gpt-5|o3|o4|4\.1)/i;

/**
 * The model a chat starts on when the user has not picked one. Ask/Document/Review prefer a cheap model;
 * Plan/Execute/Auto prefer the strongest listed one (tools-capable when the mode needs tools). A user pick is
 * stored in the chat prefs and this helper is never consulted for it. Pure.
 */
export function defaultModelForMode(groups: readonly ModelGroup[], mode: string): ModelChoice | null {
  const models = groups.flatMap((g) => g.models);
  if (models.length === 0) return null;
  const cheap = CHEAP_MODES.has(mode);
  const match = models.find((m) => (cheap ? CHEAP : STRONG).test(`${m.model} ${m.label}`));
  if (match) return match;
  // No name hint: the first model of the first group is the provider's own default.
  return models[0] ?? null;
}
