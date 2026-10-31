// Pure parts of the "Connections" and "Repositories" groups: decode the core's catalog and repo allow-list,
// keep untrusted text inert, and turn error codes into plain sentences. Selection is a visibility setting
// (the core says so); credentials and fetching stay in the Library's Connector panes.

const clean = (v: unknown, max: number): string => {
  if (typeof v !== "string") return "";
  // Strip C0/C1 controls and bidi overrides: names and descriptions are server-side data.
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ID = /^[a-z][a-z0-9-]{1,20}$/;

export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  authKind: string;
  pipelineReady: boolean;
  selected: boolean;
}

/** `{ catalog: [...] }`; invalid rows are dropped, text is cleaned, the list is capped at 100. */
export function decodeCatalog(v: unknown): ConnectorEntry[] {
  if (!isRecord(v) || !Array.isArray(v.catalog)) return [];
  const out: ConnectorEntry[] = [];
  for (const row of v.catalog) {
    if (!isRecord(row) || typeof row.id !== "string" || !ID.test(row.id)) continue;
    out.push({
      id: row.id,
      name: clean(row.name, 80) || row.id,
      description: clean(row.description, 300),
      authKind: clean(row.authKind, 40),
      pipelineReady: row.pipelineReady === true,
      selected: row.selected === true,
    });
    if (out.length >= 100) break;
  }
  return out;
}

/** Short badges shown next to a connector name. */
export function connectorBadges(c: ConnectorEntry): string[] {
  const out = [c.selected ? "Selected" : "Hidden"];
  if (!c.pipelineReady) out.push("No import pipeline yet");
  if (c.authKind === "miro-oauth") out.push("MCP connector");
  return out;
}

export interface RepoEntry {
  path: string;
  label: string | null;
}

/** `{ repos: [{ path, label? }] }`; absolute paths only, cleaned labels, capped at 500. */
export function decodeRepos(v: unknown): RepoEntry[] {
  if (!isRecord(v) || !Array.isArray(v.repos)) return [];
  const out: RepoEntry[] = [];
  for (const row of v.repos) {
    if (!isRecord(row) || typeof row.path !== "string") continue;
    const path = clean(row.path, 4096);
    if (!path.startsWith("/")) continue;
    out.push({ path, label: typeof row.label === "string" ? clean(row.label, 200) || null : null });
    if (out.length >= 500) break;
  }
  return out;
}

/** The last folder segment, for a row title. Never a made-up label. */
export function repoTitle(r: RepoEntry): string {
  if (r.label) return r.label;
  const parts = r.path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? r.path;
}

export const CONNECTIONS_TEXT = {
  hint:
    "Selecting a connector only shows or hides its card in the Library. Credentials, tokens and fetching are " +
    "managed in Library → Connections, not here.",
  empty: "The core returned no connectors.",
  add: "Add to Library",
  remove: "Remove from Library",
  partial:
    "On the Mac this group also holds each connector's credentials and fetch actions. On the desktop those live in " +
    "Library → Connections; this group mirrors the catalog and its selection.",
} as const;

export const REPOS_TEXT = {
  hint: "GitLab and GitHub tokens, the automation allow-list, and saved repositories.",
  empty: "No repositories are approved yet.",
  removeConfirm: "Remove this folder from the allow-list? Its files and history are untouched.",
  saveOnly:
    "The Mac's Save & verify checks the token against the provider and then stores it; this desktop build stores it for the core's workflows but does not verify it yet.",
  cloneGap:
    "The Mac clones a saved repository into the active project's code/ folder and can pull it again. Cloning from Settings is not available in the desktop yet.",
  partial:
    "The provider tabs, write-only tokens, automation switches and saved repository entries are real. Token verification, clone/sync, and the Mac's resolve step are not in the desktop yet. The core index allow-list below is a desktop-only safety control.",
} as const;

/** A plain sentence for a failed catalog or repo call; never the server's raw text. */
export function sourcesError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  switch (code) {
    case "VALIDATION_FAILED":
    case "INVALID_PATH":
      return "The core refused that path or value.";
    case "NOT_FOUND":
      return "The core does not know that entry.";
    case "TOO_MANY_REPOS":
    case "TOO_MANY_PROJECTS":
      return "The allow-list is full; remove an entry first.";
    case "SESSION_EXPIRED":
    case "NO_SESSION":
      return "Sign in again to manage sources.";
    case "UNREACHABLE":
    case "NETWORK":
      return "The core is not reachable right now.";
    default:
      return typeof e === "string" && e.trim() ? e.slice(0, 200) : e instanceof Error && e.message ? e.message : "The action failed.";
  }
}
