// The desktop's wiring of the server folder: the host's workspace commands, the core registration and the shell's
// project store. Shell and the server home take their dependencies from here, so the open flow is written once.
import { invokeHost } from "../shell/host.ts";
import { core } from "../shell/runtime.ts";
import { projectStore } from "../shell/project-store.ts";
import { shellBus } from "../shell/bus.ts";
import { readHome } from "../shell/landing.ts";
import { registerProject } from "../welcome/model.ts";
import { createWorkspaceIo, leaveRemoteFolder, type OpenFlowDeps, type WorkspaceIo } from "./model.ts";

let workspaceIo: WorkspaceIo | null = null;

/** The host's workspace commands, one io for the app. */
export function serverWorkspaceIo(): WorkspaceIo {
  if (workspaceIo === null) workspaceIo = createWorkspaceIo((command, args) => invokeHost<unknown>(command, args));
  return workspaceIo;
}

/** Register with the forwarded core, then refresh the project store (so Chat, Library and Issues see the folder). */
export function serverOpenDeps(): OpenFlowDeps {
  return {
    register: (root) => registerProject(root, { core }),
    refresh: () => projectStore.refresh(),
    announce: (text) => projectStore.announce(text),
    guard: (cancelled, action) => projectStore.guardLeave(cancelled, action),
  };
}

/** After a folder opened: the same landing as Welcome's Continue (the home section of the project). */
export function goHomeAfterOpen(): void {
  shellBus.publish({ type: "goto-section", section: readHome() });
}

/** The open folder vanished: close it on the host, say why, and show the server home. */
export function returnHomeFromMissingFolder(message: string): Promise<void> {
  return leaveRemoteFolder(
    { io: serverWorkspaceIo(), announce: (text) => projectStore.announce(text), refresh: () => projectStore.refresh() },
    message,
  );
}
