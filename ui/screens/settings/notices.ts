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
  mobile: {
    mac: "Hosts the iPhone companion: enable it, start on launch, port, pairing QR and PIN, paired devices, phone permissions and the connection log.",
    status: "Managed in the Mac app",
    meanwhile: "Pair and manage iPhones from the Mac app; the desktop app does not host the phone link yet.",
    blockedBy: "Mobile Control hosting is Swift (WebSocket server, Bonjour, PIN cache). Needs a desktop host service and host commands before any control can be real.",
  },
  "loop-defaults": {
    mac: "App-wide Loop defaults: how repairs that edit protected paths are handled, default stage timeouts, whether runs write a summary note, and the starting templates.",
    status: "Planned",
    meanwhile: "Set these per Loop when you create it; the Mac app's defaults do not carry over to the desktop.",
    blockedBy: "Needs the Loop screen on the desktop and a host preference store for the defaults (the Mac keeps them in UserDefaults).",
  },
  "self-heal": {
    mac: "Records app errors, proposes fixes in an isolated worktree, and lets you review and apply a proposal. Only appears on a source checkout.",
    status: "Managed in the Mac app",
    meanwhile: "Use the Mac app on a source checkout.",
    blockedBy: "Swift-only (incident store and worktree repair). No desktop equivalent is planned.",
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
  connections:
    "On the Mac this group also holds each connector's credentials and fetch actions. On the desktop those live in Library → Connections; this group mirrors the catalog and its selection.",
  repositories:
    "The Mac's GitLab/GitHub tabs, write-only tokens, automation switches and saved repositories are here, with clone destinations defaulting to the code/ folder shown in Settings → Paths. Token verification (Save & verify), cloning/sync and the Mac's resolve step are not available in the desktop yet.",
  paths:
    "On the Mac this group can also change the project's folder layout with a native folder dialog. The desktop lists the folders (present or missing) and opens them in Finder; editing is not offered.",
  workspace:
    "On the Mac this group also holds per-section toolbar toggles. The desktop shows the open project, the notes folder, the Home page choice and the full feature profile (presets and switches); toolbar visibility is not offered.",
  build:
    "Apply & Rebuild needs a source checkout and the Rust/Node toolchains; a distributed build has no source tree, so the button is absent there. It rebuilds the app and restarts it when ready.",
  "doc-gen":
    "On the Mac a beta switch chooses between the server and the folder on disk. The desktop has only the server path (the core's docs routes over the project's templates/ and commands/ folders), so the switch has one state and is not shown.",
  server:
    "On the Mac this group also edits the server URL and the Node and project paths and starts and stops the backend. Here the app starts and owns the core, the log viewer above is real, and a manual restart is not offered yet.",
  updates:
    "The Mac's automatic update checks (Sparkle) and its Check now button are Planned on the desktop (they need the host updater).",
  general:
    "On the Mac this group also holds a bilingual switch, which is Planned here. The menu-bar icon switch is real (the host shows or hides the tray icon, and hiding it turns close-to-tray off).",
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
