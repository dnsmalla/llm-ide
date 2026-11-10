// The core's registered project for an open root, through the Doc Gen helpers that already own project ids and
// registration (`projectIdFor`, `createDocsApi(...).register`). Agent tasks run in a registered project; the core
// keeps an already-registered root's id and issues a new one, so the id it answers is the one to send.
import type { CoreClient } from "../shell/core";
import { createDocsApi, projectIdFor } from "../docgen/docs-api";

export async function registeredProjectId(core: Pick<CoreClient, "request">, projectRoot: string): Promise<string> {
  const registered = await createDocsApi(core, await projectIdFor(projectRoot), projectRoot).register();
  return registered.id;
}

/** The clone folder the host reports (`loop_work_root`) as a path inside the project: "." for the root itself, or null
 *  when it is not inside the project (then the core reviews the project root). */
export function repoRelativeTo(projectRoot: string, workRoot: string): string | null {
  const root = projectRoot.replace(/[\\/]+$/, "");
  const work = workRoot.replace(/[\\/]+$/, "");
  if (root === "" || work === "") return null;
  if (work === root) return ".";
  return work.startsWith(`${root}/`) ? work.slice(root.length + 1) : null;
}
