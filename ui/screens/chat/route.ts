// Mode, model and cap rules, ported from the Mac (`ChatRouteLogic`, `ComposerCatalog`, `ModePolicy`,
// `EditAcceptanceMode`) so both clients behave the same. Pure; the HTTP wrappers are at the bottom.
import type { CoreTransport } from "./transport";

// --- modes ----------------------------------------------------------------------------------

export const AUTO_MODE = "auto";
export interface ModeOption { id: string; label: string; hint: string }

/** `MODES` of extension/llm_agent/modes/mode-classify.mjs plus the client-side `auto`. */
export const MODES: readonly ModeOption[] = [
  { id: "auto", label: "Auto", hint: "Picks a mode for each message" },
  { id: "ask", label: "Ask", hint: "Answer questions, no changes" },
  { id: "plan", label: "Plan", hint: "Design a plan, change nothing" },
  { id: "assist_plan", label: "Assist plan", hint: "Build the plan together over several turns" },
  { id: "review", label: "Review", hint: "Review code, read only" },
  { id: "document", label: "Document", hint: "Write documentation" },
  { id: "execute", label: "Execute", hint: "Make changes and run commands" },
];
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
  { id: "ask", label: "Ask", hint: "Confirm each edit and command" },
  { id: "accept-edits", label: "Accept Edits", hint: "Apply edits, confirm commands" },
  { id: "bypass", label: "Bypass", hint: "No confirmations" },
];
/** Bypass needs one explicit confirmation per app run (plan section 5). */
export const needsBypassConfirm = (target: PermissionMode, confirmedThisRun: boolean): boolean => target === "bypass" && !confirmedThisRun;

// --- models ---------------------------------------------------------------------------------

export interface ModelChoice {
  provider: string;
  model: string;
  label: string;
  /** Catalog models only: tool support from the catalog. */
  toolsSupported?: boolean;
}
export interface ModelGroup { id: string; label: string; catalog: boolean; models: ModelChoice[]; note?: string }

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

interface SdkModelEntry { id: string; displayName?: string; name?: string }
interface CatalogProvider { id: string; name: string; connections: Array<{ id: string; provider: string; name: string; enabled: boolean; hasKey: boolean }> }

/** Claude models (the SDK's live list) plus one group per enabled, keyed catalog connection. */
export async function loadModelGroups(core: CoreTransport, signal?: AbortSignal): Promise<{ groups: ModelGroup[]; toolsEnabled: boolean }> {
  const groups: ModelGroup[] = [];
  try {
    const r = await core.json<{ models?: string[]; entries?: SdkModelEntry[] }>("POST", "/kb/providers/models", { provider: "anthropic" }, signal);
    const entries: SdkModelEntry[] = r.entries ?? (r.models ?? []).map((id) => ({ id }));
    groups.push({
      id: "anthropic", label: "Claude", catalog: false,
      models: entries.map((e) => ({ provider: "anthropic", model: e.id, label: e.displayName ?? e.name ?? e.id })),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    groups.push({ id: "anthropic", label: "Claude", catalog: false, models: [], note: "The model list is unavailable." });
  }
  let toolsEnabled = false;
  try {
    const cat = await core.json<{ providers?: CatalogProvider[]; settings?: { toolsEnabled?: boolean } }>("GET", "/kb/providers/catalog", undefined, signal);
    toolsEnabled = cat.settings?.toolsEnabled === true;
    for (const p of cat.providers ?? []) {
      for (const c of p.connections.filter((x) => x.enabled && x.hasKey)) {
        try {
          const m = await core.json<{ models?: Array<{ id: string; toolsSupported?: boolean }> }>("POST", "/kb/providers/catalog/models", { id: c.id }, signal);
          groups.push({
            id: c.id, label: c.name || p.name, catalog: true,
            models: (m.models ?? []).map((x) => ({ provider: c.provider, model: x.id, label: x.id, toolsSupported: x.toolsSupported === true })),
          });
        } catch (e) {
          if (signal?.aborted) throw e;
          groups.push({ id: c.id, label: c.name || p.name, catalog: true, models: [], note: "Could not list models." });
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e; // catalog unavailable: Claude only
  }
  return { groups, toolsEnabled };
}
