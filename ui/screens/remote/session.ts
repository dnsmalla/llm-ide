// Saved remote hosts and the one active connection. Hosts live in localStorage; a session token is kept per host for
// this app run only, so reconnecting after a restart asks for the PIN again.
import { HostConnection } from "../../../web/src/host-api/connection.ts";

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
let active: Active | null = null;

export function loadHosts(): RemoteHost[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((h): h is RemoteHost => typeof h?.id === "string" && typeof h?.api === "string").map((h) => ({ ...h, projectPath: typeof h.projectPath === "string" ? h.projectPath : "" })).slice(0, 50) : [];
  } catch { return []; }
}


export const getRemote = (): Active | null => active;
export const setSelectedRemote = (id: string): void => { if (active) active.selected = id; };
export function closeRemote(): void { active?.conn.close(); active = null; }

