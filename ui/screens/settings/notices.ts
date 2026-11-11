// The honest card for a Mac group (or part of one) the desktop cannot do yet: what the Mac offers there, where it
// stands here, what to do meanwhile, and what blocks it. There is never a control behind these: a notice that
// looked like a setting but did nothing would be worse than none. `blockedBy` feeds docs/superpowers/plans/
// 2026-10-31-settings-mirror-map.md (a test keeps the two in step).
import type { Health } from "./decoders.ts";
import type { DiagnosticsInfo } from "./host.ts";
import { coreTrustLabel } from "./misc-model.ts";

export type NoticeStatus = "Planned";

export interface GroupNotice {
  /** One sentence: what the Mac offers in this group. */
  mac: string;
  status: NoticeStatus;
  /** What the user can do meanwhile. */
  meanwhile: string;
  /** What has to exist before the desktop can offer it. */
  blockedBy: string;
}

export const NOTICES: Readonly<Record<string, GroupNotice>> = {};

/** Groups that are only partly implemented keep a short note for the part that is not. */
export const PARTIAL_NOTES: Readonly<Record<string, string>> = {
  connections:
    "Connector credentials and fetch actions live in Library → Connections; this group mirrors the catalog and its selection.",
  "code-graph":
    "The host refreshes the code graph on project open or switch and on every configured interval. File-watch debouncing is not enabled.",
  repositories:
    "GitLab and GitHub tabs, write-only tokens, automation switches and saved repositories are here, with clone destinations defaulting to the code/ folder shown in Settings → Paths. Clone repository is real (token optional for public repos, used from memory for private ones), and Check token verifies the saved one for github.com or the configured public GitLab instance. Pull/re-sync and resolve are not available yet.",
  paths:
    "The project folder layout is owned by the project on both apps; this group lists the folders (present or missing), reveals them in Finder and re-creates missing ones. Changing the layout itself is not offered on either side.",
  workspace:
    "This group shows the open project, the notes folder, the Home page choice and the full feature profile (presets, switches and per-section toolbar visibility).",
  build:
    "Apply & Rebuild needs a source checkout and the Rust/Node toolchains; a distributed build has no source tree, so the button is absent there. It rebuilds the app and restarts it when ready.",
  server:
    "The app starts and supervises the core: status, log, Start, Stop and Kill & Restart. A source checkout can set its Node binary, project folder and loopback port; editing the server URL of an external core is not offered.",
  updates:
    "Updates come from signed LLM-IDE releases only: the host checks once a day when the switch is on and never installs without asking. A local or test build has no update channel. A .deb install is updated by the package manager, not here.",
  general:
    "The menu-bar icon switch is real (the host shows or hides the tray icon, and hiding it turns close-to-tray off).",
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
    if (info.coreState === "stopped") rows.push({ label: "Identity", value: "Stopped", tone: "warning" });
    else rows.push({ label: "Identity", value: coreTrustLabel(info.coreTrust), tone: info.coreTrust === "spawned" ? "ok" : "warning" });
    rows.push({ label: "Log file", value: info.coreLogPath ?? "Not available" });
  }
  return rows;
}
