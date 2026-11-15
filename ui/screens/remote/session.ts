// One remote host connection for this app run. The Welcome card creates it; the Remote section consumes it.
import { HostConnection } from "../../../web/src/host-api/connection.ts";
import { normalizeRemoteUrl } from "./model.ts";

export interface RemoteProject { id: string; name: string; role: string; maxMode: string }
interface Active { conn: HostConnection; projects: RemoteProject[]; selected: string | null }

let token: string | null = null;
const tokens = { get: () => token, set: (t: string | null) => { token = t; }, identity: () => null };
let active: Active | null = null;

export const getRemote = (): Active | null => active;
export const setSelectedRemote = (id: string): void => { if (active) active.selected = id; };
export const closeRemote = (): void => { active?.conn.close(); active = null; };

/** Pair, list projects, keep the connection. Throws a readable error for the form. */
export async function connectRemote(address: string, pin: string): Promise<Active> {
  const conn = new HostConnection({ url: normalizeRemoteUrl(address), clientName: "LLM-IDE Desktop", clientVersion: "0.0.0", tokens });
  const result = await conn.connect(pin.trim() || undefined);
  if (result === "needsPin") throw new Error("This host withheld its token. Check the address, then pair again with its PIN.");
  if (!conn.capabilities.has("read")) throw new Error("This host does not serve the read capability, so its workspace is unavailable.");
  const list = await conn.send("projects.list", {}).done;
  const projects = list.projects as RemoteProject[];
  if (projects.length === 0) throw new Error("The host has no projects registered for this account.");
  active = { conn, projects, selected: projects[0].id };
  return active;
}
