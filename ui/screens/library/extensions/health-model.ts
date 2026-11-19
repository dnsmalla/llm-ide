// State and wording of the health line shown in every extension detail. Pure, so the words, the fix ->
// action mapping and the auto-check rule are tested without React. Words follow the plan's vocabulary:
// no codes, file names or variable names reach the user (a problem's `code` is for logic only).
import type { HealthKind } from "./api.ts";
import type { HealthFix, InstalledItem, HealthProblem, HealthResult } from "./decoders.ts";

export type { HealthKind };

/** The key of one item's last result in a model's `health` map. */
export const healthKey = (kind: HealthKind, id: string): string => `${kind}:${id}`;

export interface StatusLine {
  text: string;
  tone: "ok" | "warn" | "neutral";
}
export function statusLine(r: HealthResult | undefined, checking = false): StatusLine {
  if (checking) return { text: "Checking…", tone: "neutral" };
  if (!r) return { text: "Not checked yet", tone: "neutral" };
  if (r.status === "ok") return { text: "Working", tone: "ok" };
  if (r.status === "problem") return { text: "Problem", tone: "warn" };
  return { text: "Can't be checked here", tone: "neutral" };
}

/** "Checked 3 minutes ago"; empty when nothing is known. */
export function checkedText(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "Checked just now";
  if (s < 60) return `Checked ${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `Checked ${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `Checked ${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `Checked ${d} days ago`;
}

export type FixAction = "repair" | "consent" | "switch-off";
export type FixPlan = { type: "button"; action: FixAction; label: string } | { type: "text"; text: string } | { type: "none" };

/** What a problem offers: one button, a sentence (nothing is ever run for the user), or nothing. */
export function fixPlan(p: Pick<HealthProblem, "fix" | "program">, kind?: HealthKind): FixPlan {
  switch (p.fix as HealthFix) {
    // No route re-fetches a plugin in place (install-from-source refuses an existing name), so no button, never an unrelated update.
    case "repair": if (kind === "plugin") return { type: "text", text: "Remove this plugin and install it again from its source." };
      return { type: "button", action: "repair", label: "Repair" };
    case "consent": return { type: "button", action: "consent", label: "Allow…" };
    case "switch-off": return { type: "button", action: "switch-off", label: "Switch off" };
    // shortcut: no credential editor exists in this screen yet, so this is a sentence, not a button; add one when the core has a route.
    case "set-credential": return { type: "text", text: "Add the missing credential for this MCP server, then press Check." };
    case "install-program": return { type: "text", text: p.program ? `Install ${p.program}, then press Check.` : "Install the program it needs, then press Check." };
    default: return { type: "none" };
  }
}

/** Only items that start no program may be checked on open; an MCP server (or a catalog item with one) waits for the button. */
export function autoChecksOnOpen(kind: HealthKind, hasMcpServer: boolean): boolean {
  return kind === "plugin" || kind === "skill-kit" || (kind === "catalog" && !hasMcpServer);
}

/** A problem as one sentence for a screen reader: the message, then what to do. */
export function problemSentence(p: HealthProblem, kind?: HealthKind): string {
  const f = fixPlan(p, kind);
  return f.type === "text" ? `${p.message} ${f.text}` : p.message;
}

/** Shown when a problem's fix has no runnable action in this view. */
export const FIX_HINT = "Fix it, then press Check.";

export const toolsHeading = (n: number): string => `Tools (${n})`;

/** The row badge: only a KNOWN problem shows. */
export const rowBadge = (r: HealthResult | undefined): "Problem" | null => (r?.status === "problem" ? "Problem" : null);

/** The Problems filter: items whose known result is `problem`. */
export function onlyProblems<T extends { id: string }>(items: readonly T[], health: Readonly<Record<string, HealthResult>>, kindOf: (i: T) => HealthKind): readonly T[] {
  return items.filter((i) => health[healthKey(kindOf(i), i.id)]?.status === "problem");
}

/** Aborts when either signal does (AbortSignal.any is not in every webview this app runs in). */
export function linkedSignal(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const ctl = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) ctl.abort();
    else s.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  return ctl.signal;
}

/** Add `key` to / remove it from a list of keys being checked. */
export const withKey = (keys: readonly string[], key: string): string[] => (keys.includes(key) ? [...keys] : [...keys, key]);
export const withoutKey = (keys: readonly string[], key: string): string[] => keys.filter((k) => k !== key);

/** A catalog item that carries an MCP server (checking it starts a program). */
export const itemHasMcp = (i: Pick<InstalledItem, "kind" | "executableKinds" | "members">): boolean => i.kind === "mcp" || i.executableKinds.includes("mcp") || i.members.some((m) => m.type === "mcp");
