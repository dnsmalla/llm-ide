// Pure wording and rules for the Library's legacy panes (no React, no host). Same words as the Mac's
// McpUpdatePresentation (sourceLabel, sourceBadge), PluginUpdatePresentation.sourceDescription and
// PluginTrustPresentation (componentStatus, describe, the outdated-trust line). Untrusted text comes in already
// cleaned and capped by the decoders in legacy.ts; these helpers only choose words around it.
import type { InstallSource, PluginRow } from "./legacy.ts";

/** Where an MCP server came from, as the detail subtitle says it (Mac: McpUpdatePresentation.sourceLabel). */
export function mcpSourceLabel(source: string): string {
  switch (source) {
    case "catalog":
      return "Catalog";
    case "claude":
      return "Imported from Claude Code";
    case "codex":
      return "Imported from Codex";
    case "plugin":
      return "From plugin";
    default:
      return "Manually registered";
  }
}

/** The short label on a list row (Mac: McpUpdatePresentation.sourceBadge). A plugin-declared server never reads as "manual". */
export function mcpSourceBadge(source: string): string {
  switch (source) {
    case "catalog":
    case "claude":
    case "codex":
    case "plugin":
      return source;
    default:
      return "manual";
  }
}

/** The provenance line under a plugin's version (Mac: PluginUpdatePresentation.sourceDescription). Null when there is nothing to say. */
export function installSourceText(src: InstallSource | undefined): string | null {
  if (!src) return null;
  switch (src.kind) {
    case "git": {
      if (!src.url) return null;
      const ref = src.ref ? ` @ ${src.ref}` : "";
      const commit = src.commit ? ` (${src.commit.slice(0, 7)})` : "";
      return `From git: ${src.url}${ref}${commit}`;
    }
    case "marketplace": {
      if (!src.url) return null;
      const entry = src.entry ? `${src.entry} from ` : "";
      const version = src.version ? ` · v${src.version}` : "";
      return `Marketplace: ${entry}${src.url}${version}`;
    }
    case "zip":
      return src.fileName ? `Installed from file ${src.fileName}` : null;
    default:
      return null;
  }
}

export type ComponentStatus = "agentEngine" | "nativeOff" | "ignored";

/** Vendor component names (as the core lists them under unsupportedComponents) to the executable kind they carry. */
const COMPONENT_KIND = new Map<string, string>([
  ["monitors", "monitors"],
  [".lsp.json", "lsp"],
  ["bin", "bin"],
]);

/** The two facts that decide whether the agent engine can ever load a package (Mac: PluginInfo.agentEngineCanLoad). */
export function agentEngineCanLoad(p: Pick<PluginRow, "sdkReadable" | "nativePluginsOn">): boolean {
  return (p.sdkReadable ?? true) && (p.nativePluginsOn ?? true);
}

/**
 * What happens to a component the package brought along. "ignored" only when nothing here runs it: with native
 * plugin loading on, the agent engine runs it once the plugin is trusted (Mac: PluginTrustPresentation.componentStatus).
 */
export function componentStatus(component: string, p: Pick<PluginRow, "executableKinds" | "sdkReadable" | "nativePluginsOn">): ComponentStatus {
  const kind = COMPONENT_KIND.get(component);
  if (!kind || !p.executableKinds.includes(kind)) return "ignored";
  if (agentEngineCanLoad(p)) return "agentEngine";
  // A Codex layout never reaches the SDK; with the preference off a Claude package would.
  return (p.sdkReadable ?? true) ? "nativeOff" : "ignored";
}

/** The row text for one unsupported component, following the trust grant and the enabled state. */
export function componentRowText(component: string, p: Pick<PluginRow, "executableKinds" | "sdkReadable" | "nativePluginsOn" | "hooksTrusted" | "enabled">): string {
  switch (componentStatus(component, p)) {
    case "agentEngine":
      if (!p.hooksTrusted) return `${component} — run by the agent engine once you trust this plugin`;
      return p.enabled ? `${component} — run by the agent engine (trusted)` : `${component} — will run once you enable this plugin (trusted)`;
    case "nativeOff":
      return `${component} — not run while native plugin loading is off (Settings → Preferences)`;
    default:
      return `${component} — unsupported, ignored`;
  }
}

/** Words for executable kinds (Mac: PluginTrustPresentation.describe). Unknown kinds are dropped, never shown raw. */
export function describeKinds(kinds: readonly string[]): string {
  const words = kinds.flatMap((kind) => {
    switch (kind) {
      case "hooks":
        return ["hooks"];
      case "monitors":
        return ["background monitors"];
      case "lsp":
        return ["language servers"];
      case "bin":
        return ["bin/ commands"];
      case "sdk":
        return ["loading by the agent engine itself (more hook types than before)"];
      default:
        return [];
    }
  });
  return words.length === 0 ? "more executable parts" : [...new Set(words)].join(", ");
}

/** The hook block's heading: "Hooks", or "Hooks & scripts" when the package also brings scripts. */
export function hooksHeading(p: Pick<PluginRow, "executableKinds">): string {
  return p.executableKinds.some((k) => k !== "hooks") ? "Hooks & scripts" : "Hooks";
}

/** The trust state the core reports, in words. Read-only: granting or revoking stays on the list row and its sheet. */
export function hookTrustState(p: Pick<PluginRow, "hooksTrusted" | "trustOutdated">): string {
  return p.hooksTrusted ? "Trusted" : p.trustOutdated ? "Trust outdated" : "Not trusted";
}

/** Why an earlier trust no longer covers the plugin: names only what is new (Mac: the outdated-trust line). */
export function outdatedTrustText(p: Pick<PluginRow, "trustOutdatedKinds" | "executableKinds">): string {
  const newKinds = p.trustOutdatedKinds.length > 0 ? p.trustOutdatedKinds : p.executableKinds;
  const sandbox = newKinds.includes("monitors") ? " Background monitors run outside the sandbox." : "";
  return `You trusted an earlier version of this plugin. It now also declares ${describeKinds(newKinds)}, which that trust did not cover, so it is off again.${sandbox}`;
}

/**
 * The project-relative path a Reveal may name, or null when the location is not inside the open project.
 * The host's reveal_in_os resolves against the project root, so only an absolute path under that root qualifies.
 */
export function projectRelativeOf(location: string, root: string | null | undefined): string | null {
  if (!root || !location) return null;
  const norm = (s: string): string => s.replaceAll("\\", "/").replace(/\/+$/, "");
  const abs = (s: string): boolean => s.startsWith("/") || /^[A-Za-z]:\//.test(s.replaceAll("\\", "/"));
  if (!abs(location) || !abs(root)) return null;
  const r = norm(root);
  const l = norm(location);
  if (l === r) return "";
  if (!l.startsWith(`${r}/`)) return null;
  const rel = l.slice(r.length + 1);
  if (rel.split("/").some((seg) => seg === "..")) return null;
  return rel;
}

/** How the detail pane reveals a location: asked at render (can it?) and on click (reveal it). */
export interface LocationReveal {
  canReveal(location: string): boolean;
  reveal(location: string): void;
}
