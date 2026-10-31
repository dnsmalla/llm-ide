// Pure presentation rules for the Extensions screen: kind order and labels, what a consent names, trust and
// badge text, summaries. No UI and no network, so all of it is unit tested.
import type { CatalogEntry, CatalogSource, InstalledItem, Member, Permission, RefreshResult, RepairResult, UpdateSummary } from "./decoders.ts";
import { shortCommit } from "./sanitize.ts";

export const KIND_ORDER = ["skill", "plugin", "mcp", "llm-source"] as const;

export function kindTitle(kind: string): string {
  switch (kind) {
    case "skill":
      return "Skills";
    case "plugin":
      return "Plugins";
    case "mcp":
      return "MCP servers";
    case "llm-source":
      return "Skill bundles";
    default:
      return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "skill":
      return "Skill";
    case "plugin":
      return "Plugin";
    case "mcp":
      return "MCP server";
    case "llm-source":
      return "Skill bundle";
    default:
      return kind;
  }
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || 0;

/** Items grouped by kind in KIND_ORDER (unknown kinds last, sorted), each group by name; empty groups dropped. */
export function groupItems(items: readonly InstalledItem[]): { kind: string; items: InstalledItem[] }[] {
  const by = new Map<string, InstalledItem[]>();
  for (const it of items) {
    const list = by.get(it.kind);
    if (list) list.push(it);
    else by.set(it.kind, [it]);
  }
  const known = KIND_ORDER.filter((k) => by.has(k));
  const extra = [...by.keys()].filter((k) => !(KIND_ORDER as readonly string[]).includes(k)).sort();
  return [...known, ...extra].map((kind) => ({ kind, items: (by.get(kind) ?? []).slice().sort(byName) }));
}

export function trustLabel(trust: string): string {
  switch (trust) {
    case "official":
      return "Official";
    case "local":
      return "Local";
    default:
      return "Unverified";
  }
}

/** `owner/repo` from a GitHub URL, or the (already cleaned) text when it is not one. */
export function repoName(url: string): string {
  const m = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : url;
}

export const hasUpdate = (it: InstalledItem): boolean => !!it.update && it.update.latest !== it.pinnedCommit;
export const runsCode = (it: InstalledItem): boolean => it.executableKinds.length > 0;
export const hasWarnings = (it: InstalledItem): boolean => it.scan.count > 0;

// ---- consent --------------------------------------------------------------------------------------
export const CONSENT_ORDER = ["hook", "mcp", "lsp", "bin"] as const;

export function orderKinds(kinds: readonly string[]): string[] {
  const set = new Set(kinds);
  return [...CONSENT_ORDER.filter((k) => set.has(k)), ...[...set].filter((k) => !(CONSENT_ORDER as readonly string[]).includes(k)).sort()];
}

export function consentTitle(kind: string): string {
  switch (kind) {
    case "hook":
      return "Hooks";
    case "mcp":
      return "MCP servers";
    case "lsp":
      return "Language servers";
    case "bin":
      return "Executables";
    default:
      return kind;
  }
}

export function consentRuns(kind: string): string {
  switch (kind) {
    case "hook":
      return "Shell commands that run on your machine when the assistant triggers an event.";
    case "mcp":
      return "MCP servers the assistant can start or connect to and call tools on.";
    case "lsp":
      return "Language server programs started on your machine.";
    case "bin":
      return "Executable programs from the item's bin folder that the assistant can run.";
    default:
      return "Code of this kind runs on your machine.";
  }
}

export interface ConsentLine {
  kind: string;
  title: string;
  /** What would run, from the item's own members and permission summary. Untrusted names, shown as text. */
  detail: string;
  /** Declared member names of this kind (capped). */
  names: string[];
}

export function consentLines(kinds: readonly string[], members: readonly Pick<Member, "type" | "name">[], permissions: readonly Permission[]): ConsentLine[] {
  return orderKinds(kinds).map((kind) => {
    const names = members.filter((m) => m.type === kind).map((m) => m.name);
    const shown = names.slice(0, 20);
    const permission = permissions.find((p) => p.type === kind)?.text;
    let detail = consentRuns(kind);
    if (shown.length > 0) detail += ` Declared: ${shown.join(", ")}${names.length > shown.length ? `, and ${names.length - shown.length} more` : ""}.`;
    if (permission) detail += ` ${permission}`;
    return { kind, title: consentTitle(kind), detail, names: shown };
  });
}

// ---- badges, summaries ----------------------------------------------------------------------------
export function flagText(flag: string): string {
  switch (flag) {
    case "new_executable_kind":
      return "Adds a new kind of code that can run";
    case "new_executable_member":
      return "Adds new members that can run code";
    case "new_findings":
      return "The scan found new warnings";
    case "consent_required":
      return "Needs your consent before it stays on";
    default:
      return flag;
  }
}

export function outcomeText(s: UpdateSummary, verb: string): string {
  const move = `${shortCommit(s.from)} to ${shortCommit(s.to)}`;
  if (s.wasEnabled && !s.enabled) {
    const kinds = s.kinds.length > 0 ? ` (${s.kinds.join(", ")})` : "";
    return `${verb} ${move}. It was switched off until you consent to the code it can run${kinds}.`;
  }
  return `${verb} ${move}.`;
}

export function repairText(r: Pick<RepairResult, "status" | "was">): string {
  switch (r.status) {
    case "ok":
      return "Files verified: nothing to repair.";
    case "verified":
      return "Files verified against the source and a fingerprint was recorded.";
    case "restored":
      return `Files restored at the pinned commit${r.was ? ` (they were ${r.was})` : ""}.`;
    default:
      return `Repair finished (${r.status}).`;
  }
}

export function reasonText(reason: string | undefined): string {
  switch (reason) {
    case "package_launcher":
      return "Browse only: it would need a package launcher (npx or uvx) that is never run.";
    case "registry_install_not_supported":
      return "Browse only: MCP registry entries cannot be installed from here. Set it up yourself from the repository.";
    case "unsupported_source":
      return "Browse only: its source is not a GitHub repository path this screen can install.";
    case "source_not_allowed":
      return "Not allowed: add the repository in Settings under Extension sources to install it.";
    default:
      return reason ? `Browse only (${reason}).` : "Browse only.";
  }
}

export function entryAction(e: CatalogEntry): { installable: boolean; reason: string | null } {
  if (e.installed) return { installable: false, reason: "Already installed." };
  if (!e.installable || !e.sourceUrl) return { installable: false, reason: reasonText(e.reason) };
  return { installable: true, reason: null };
}

export function sourceStatusText(s: CatalogSource): string {
  switch (s.status) {
    case "fresh":
      return `${s.count} entries, up to date`;
    case "stale":
      return `${s.count} entries, older than 6 hours`;
    case "empty":
      return "not fetched yet";
    case "error":
      return `last refresh failed (${s.count} cached)`;
    default:
      return s.status;
  }
}

/** No source has ever been fetched: "no results" means "no data yet". */
export const catalogNeverFetched = (sources: readonly CatalogSource[]): boolean => sources.length > 0 && sources.every((s) => s.status === "empty");

export function refreshSummary(r: RefreshResult): string {
  const failed = r.results.filter((x) => x.status === "error");
  const throttled = r.results.filter((x) => x.status === "throttled").length;
  const parts = [`Refreshed ${r.results.filter((x) => x.status === "refreshed").length} of ${r.results.length} sources`];
  if (throttled > 0) parts.push(`${throttled} skipped (asked less than a minute ago)`);
  if (failed.length > 0) parts.push("failed: " + failed.map((x) => `${x.id} (${x.error ?? "error"})`).join(", "));
  return parts.join("; ") + ".";
}

/** Client-side check of the install address (the server checks again): https://github.com/<owner>/<repo>[.git]. */
export function validateInstallUrl(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return "Enter a GitHub address.";
  if (s.length > 200) return "That address is too long.";
  if (!/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?\/?$/.test(s)) return "Use a https://github.com/<owner>/<repo> address.";
  return null;
}

/** Folder inside the repository: relative, no `..`, no backslash or control character. Empty is fine. */
export function validateInstallPath(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  if (s.length > 240) return "That folder path is too long.";
  // eslint-disable-next-line no-control-regex
  if (s.startsWith("/") || s.includes("\\") || /[\u0000-\u001f\u007f]/.test(s) || s.split("/").some((p) => p === ".." || p === ".")) return "Use a folder path inside the repository, like skills/pdf.";
  return null;
}
