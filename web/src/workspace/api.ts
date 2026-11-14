// The two write-side Host API calls the workspace uses. Read/list stay in the existing read controller.
import type { HostLink } from "../host-api/connection.ts";

export const statFile = (link: HostLink, projectId: string, path: string) =>
  link.send("files.stat", { projectId, path }).done;

export const writeFile = (
  link: HostLink, projectId: string, path: string, text: string,
  expectedHash: string | null, mustNotExist: boolean, create: boolean,
) => link.send("files.write", {
  projectId, path, text,
  ...(expectedHash ? { expectedHash } : {}),
  mustNotExist, create,
}).done;
