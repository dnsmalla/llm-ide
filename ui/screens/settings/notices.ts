// The honest card for a Mac group (or part of one) the desktop cannot do yet: what the Mac offers there, where it
// stands here, what to do meanwhile, and what blocks it. There is never a control behind these: a notice that
// looked like a setting but did nothing would be worse than none. `blockedBy` feeds docs/superpowers/plans/
// 2026-10-31-settings-mirror-map.md (a test keeps the two in step).
import type { Health } from "./decoders.ts";
import type { DiagnosticsInfo } from "./host.ts";
import { coreTrustLabel } from "./misc-model.ts";

export type NoticeStatus = "Managed in the Mac app" | "Planned";

export interface GroupNotice {
  /** One sentence: what the Mac offers in this group. */
  mac: string;
  status: NoticeStatus;
  /** What the user can do meanwhile. */
  meanwhile: string;
  /** What has to exist before the desktop can offer it. */
  blockedBy: string;
}

export const NOTICES: Readonly<Record<string, GroupNotice>> = {
  build: {
    mac: "Rebuilds the Mac app from source with only the features you enabled compiled in (Apply & Rebuild), and shows what this binary was built with.",
    status: "Managed in the Mac app",
    meanwhile: "The desktop app is built and packaged separately; nothing here changes its contents. Use the Mac app on a source checkout if you need a reduced build.",
    blockedBy: "Swift-only: Apply & Rebuild drives the Swift package build and swaps the installed .app. No desktop equivalent is planned.",
  },
  mobile: {
    mac: "Hosts the iPhone companion: enable it, start on launch, port, pairing QR and PIN, paired devices, phone permissions and the connection log.",
    status: "Managed in the Mac app",
    meanwhile: "Pair and manage iPhones from the Mac app; the desktop app does not host the phone link yet.",
    blockedBy: "Mobile Control hosting is Swift (WebSocket server, Bonjour, PIN cache). Needs a desktop host service and host commands before any control can be real.",
  },
  "token-saving": {
    mac: "Installs and checks rtk, which shrinks shell output before Claude Code reads it (60 to 90 percent fewer tokens in your own Claude Code sessions).",
    status: "Planned",
    meanwhile: "Prompt compression, the per-chat router and the token cap are under Model routing. To use rtk, run brew install rtk and rtk init -g in a terminal.",
    blockedBy: "Needs a host command that reports rtk's install state and runs the Homebrew install (a process the webview must not spawn).",
  },
  "loop-defaults": {
    mac: "App-wide Loop defaults: how repairs that edit protected paths are handled, default stage timeouts, whether runs write a summary note, and the starting templates.",
    status: "Planned",
    meanwhile: "Set these per Loop when you create it; the Mac app's defaults do not carry over to the desktop.",
    blockedBy: "Needs the Loop screen on the desktop and a host preference store for the defaults (the Mac keeps them in UserDefaults).",
  },
  "doc-gen": {
    mac: "A switch to list, save and delete Doc Gen template and command files through the server instead of from the folder on disk (beta).",
    status: "Planned",
    meanwhile: "Doc Gen keeps working as it does today; the server-files switch is simply not offered yet.",
    blockedBy: "Needs a host preference (the Mac keeps docGenUseServerStore in UserDefaults) and the Doc Gen screen to honour it.",
  },
  "optional-components": {
    mac: "On-demand downloads that keep the app small (the Mermaid diagram renderer), each checked against a pinned checksum, with Remove.",
    status: "Planned",
    meanwhile: "Nothing is downloaded by the desktop app today.",
    blockedBy: "Needs a host command that downloads a pinned component and verifies its checksum, plus the component store on disk.",
  },
  "self-heal": {
    mac: "Records app errors, proposes fixes in an isolated worktree, and lets you review and apply a proposal. Only appears on a source checkout.",
    status: "Managed in the Mac app",
    meanwhile: "Use the Mac app on a source checkout.",
    blockedBy: "Swift-only (incident store and worktree repair). No desktop equivalent is planned.",
  },
  connections: {
    mac: "Connects the sources that feed the Library: Meetings (capture platforms), Email, Slack, Box and the catalog connectors, with fetch-now actions and status.",
    status: "Planned",
    meanwhile: "Library sources and ingestion are in the Library screen; per-source credentials and the connector catalog are still set up in the Mac app.",
    blockedBy: "Needs the connector catalog and per-source credential routes wired into a desktop card (the core routes exist; the desktop UI does not).",
  },
  paths: {
    mac: "Shows and edits the project's folders (notes, plans, docs) and opens them in Explorer.",
    status: "Planned",
    meanwhile: "The Workspace group above shows the open project and the notes folder.",
    blockedBy: "Needs host commands to read and change the project's folder layout with a native folder dialog.",
  },
  repositories: {
    mac: "Connects GitHub and GitLab (tokens, hosts) and registers the local repositories the project works with.",
    status: "Planned",
    meanwhile: "Source control in Explorer works on the open project's own git repository; hosted-repo tokens are set up in the Mac app.",
    blockedBy: "Needs the repo allow-list and provider token routes surfaced in a desktop card with write-only token fields.",
  },
  memory: {
    mac: "Lists whether a knowledge graph exists for the project and its agent memory files.",
    status: "Planned",
    meanwhile: "Generate or view the graph from the Code Graph screen.",
    blockedBy: "Needs a host command that lists the project's system/memory files (a webview must not read the disk).",
  },
  "code-graph": {
    mac: "The Code Graph auto-update interval and the banner shown when an upload was truncated.",
    status: "Planned",
    meanwhile: "Generate or refresh the graph from the Code Graph screen.",
    blockedBy: "Needs the graph auto-updater (Swift today) to exist on the desktop, and a host preference for its interval.",
  },
};

/** Groups that are only partly implemented keep a short note for the part that is not. */
export const PARTIAL_NOTES: Readonly<Record<string, string>> = {
  workspace:
    "On the Mac this group also holds the workspace profile, menu-bar visibility and Home page choice. The desktop shows the open project, the notes folder and the core's feature set; the profile presets and toolbar toggles are Planned (they need a feature-profile host preference).",
  server:
    "On the Mac this group also edits the server URL and the Node and project paths, starts and stops the backend and shows its log. Here the core is started and stopped by the app itself; those controls are Planned (they need host commands to restart the core and to read its log).",
  updates:
    "The Mac's automatic update checks (Sparkle) and its Check now button are Planned on the desktop (they need the host updater).",
  general:
    "On the Mac this group also holds the menu-bar chat icon and a bilingual switch; those are Planned here (the menu-bar icon needs a host tray command).",
};

// ---- Server & Backend rows (pure; the section renders them) -------------------------------------------

export interface ServerRow {
  label: string;
  value: string;
  tone?: "ok" | "warning";
}

export function serverRows(info: DiagnosticsInfo | null, health: Health | null): ServerRow[] {
  const rows: ServerRow[] = [];
  rows.push(health ? { label: "Backend", value: health.status === "ok" ? "Running" : `Reports ${health.status}`, tone: health.status === "ok" ? "ok" : "warning" } : { label: "Backend", value: "No answer", tone: "warning" });
  if (health) {
    rows.push({ label: "API version", value: String(health.apiVersion) });
    const failing = Object.entries(health.checks).filter(([, ok]) => !ok).map(([k]) => k);
    rows.push({ label: "Health checks", value: failing.length === 0 ? "All passing" : `Failing: ${failing.join(", ")}`, tone: failing.length === 0 ? "ok" : "warning" });
  }
  if (info) {
    rows.push({ label: "Identity", value: coreTrustLabel(info.coreTrust), tone: info.coreTrust === "spawned" ? "ok" : "warning" });
    rows.push({ label: "Log file", value: info.coreLogPath ?? "Not available" });
  }
  return rows;
}
