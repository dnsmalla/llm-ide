// Saved remote hosts and the one active connection. Hosts live in localStorage; a session token is kept per host for
// this app run only, so reconnecting after a restart asks for the PIN again.
import { HostConnection } from "../../../web/src/host-api/connection.ts";
import { assertAllowedHostApiUrl } from "./model.ts";

export interface RemoteProject { id: string; name: string; role: string; maxMode: string }
export interface RemoteHost {
  id: string;
  name: string;
  sshHost: string;
  port: number;
  user: string;
  keyPath: string;
  api: string;
  /** Remote project folder opened by the SSH bootstrap, e.g. /srv/llmide/projects/demo. */
  projectPath: string;
}
interface Active { host: RemoteHost; conn: HostConnection; projects: RemoteProject[]; selected: string | null }

const KEY = "llmide.remoteHosts";
let tokensByUrl = new Map<string, string>();
let tokenUrl: string | null = null;
const tokens = {
  get: () => (tokenUrl ? tokensByUrl.get(tokenUrl) ?? null : null),
  set: (t: string | null) => { if (!tokenUrl) return; if (t) tokensByUrl.set(tokenUrl, t); else tokensByUrl.delete(tokenUrl); },
  identity: () => null,
};
let active: Active | null = null;

export function loadHosts(): RemoteHost[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((h): h is RemoteHost => typeof h?.id === "string" && typeof h?.api === "string").map((h) => ({ ...h, projectPath: typeof h.projectPath === "string" ? h.projectPath : "" })).slice(0, 50) : [];
  } catch { return []; }
}

function saveHosts(hosts: RemoteHost[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(hosts.slice(0, 50))); } catch { /* private mode */ }
}

export function addHost(input: Omit<RemoteHost, "id">): RemoteHost[] {
  const hosts = loadHosts();
  const existing = hosts.find((h) => h.sshHost === input.sshHost && h.user === input.user && h.api === input.api);
  const host: RemoteHost = { ...input, id: existing?.id ?? `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
  const next = existing ? hosts.map((h) => h.id === existing.id ? host : h) : [host, ...hosts];
  saveHosts(next);
  return next;
}

export function removeHost(id: string): RemoteHost[] {
  const next = loadHosts().filter((h) => h.id !== id);
  saveHosts(next);
  if (active?.host.id === id) closeRemote();
  return next;
}

export const getRemote = (): Active | null => active;
export const activeHostId = (): string | null => active?.host.id ?? null;
export const setSelectedRemote = (id: string): void => { if (active) active.selected = id; };
export function closeRemote(): void { active?.conn.close(); active = null; }

/** Pair the saved host, list its projects, keep it active. Throws a readable error for the form. */
export async function connectSavedHost(host: RemoteHost, pin: string): Promise<Active> {
  // Already open: reuse it instead of creating a second socket.
  if (active && active.host.id === host.id) return active;
  closeRemote();
  const url = assertAllowedHostApiUrl(host.api);
  tokenUrl = url;
  const conn = new HostConnection({ url, clientName: "LLM-IDE Desktop", clientVersion: "0.0.0", tokens });
  const result = await conn.connect(pin.trim() || undefined);
  if (result === "needsPin") throw new Error("This host withheld its token. Check the address, then pair again with its PIN.");
  if (!conn.capabilities.has("read")) throw new Error("This host does not serve the read capability, so its workspace is unavailable.");
  const list = await conn.send("projects.list", {}).done;
  const projects = list.projects as RemoteProject[];
  if (projects.length === 0) throw new Error("The host has no projects registered for this account.");
  active = { host, conn, projects, selected: projects[0].id };
  return active;
}
