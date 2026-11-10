// The core's registered id for this project root. Agent tasks run in a registered project, and the core issues the id
// (an already-registered root keeps its id), so this is idempotent.
import type { CoreClient } from "../shell/core";

export async function registeredProjectId(core: Pick<CoreClient, "request">, projectRoot: string): Promise<string> {
  const answer = await core.request<{ id?: unknown }>("/kb/projects/register", { method: "POST", body: { id: "auto-tasks", root: projectRoot } });
  if (typeof answer?.id !== "string" || answer.id === "") throw new Error("The core did not register the project.");
  return answer.id;
}
