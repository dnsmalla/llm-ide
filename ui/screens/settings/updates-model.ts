// ui/screens/settings/updates-model.ts
// The host updater's status (desktop/src-tauri/src/updater.rs UpdateStatus), decoded defensively, and its one-line text.
export interface UpdateStatusView {
  configured: boolean;
  reason: string | null;
  installKind: "self" | "package";
  available: { version: string; notes: string } | null;
  lastCheckedMs: number | null;
  error: string | null;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

export function decodeUpdateStatus(raw: unknown): UpdateStatusView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.configured !== "boolean") return null;
  const a = r.available as Record<string, unknown> | null | undefined;
  const version = a ? str(a.version, 40) : null;
  return {
    configured: r.configured,
    reason: str(r.reason, 40),
    installKind: r.installKind === "package" ? "package" : "self",
    available: version ? { version, notes: str(a!.notes, 2000) ?? "" } : null,
    lastCheckedMs: typeof r.lastCheckedMs === "number" && Number.isFinite(r.lastCheckedMs) ? r.lastCheckedMs : null,
    error: str(r.error, 200),
  };
}

export function updateSummary(s: UpdateStatusView | null): string {
  if (!s) return "Reading the update status...";
  if (!s.configured) return "This build has no update channel (a local or test build). Release builds update themselves.";
  if (s.installKind === "package") return "Installed from a package: update LLM-IDE with your package manager.";
  if (s.error) return `Could not check for updates: ${s.error}`;
  if (s.available) return `LLM-IDE ${s.available.version} is available.`;
  if (s.lastCheckedMs === null) return "Not checked yet.";
  return `Up to date (checked ${new Date(s.lastCheckedMs).toLocaleString()}).`;
}

/** Host errors are plain `{code, message}` objects (not Error instances); show their message, never "[object Object]". */
export function updateErrorText(e: unknown): string {
  const m = typeof e === "string" ? e : (e as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m.slice(0, 200) : "The update action failed.";
}
