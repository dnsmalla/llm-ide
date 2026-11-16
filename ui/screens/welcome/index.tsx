import { useEffect, useMemo, useState } from "react";
import { ServerHome } from "./ServerHome.tsx";
import { closeServerConnection } from "../shell/close-server.ts";
import { goHomeAfterOpen, serverOpenDeps, serverWorkspaceIo } from "../remote-folder/wiring.ts";
import "@llmide/ui-kit/styles.css";
import "./welcome.css";
import type { SectionProps } from "../shell/sections";
import { shellBus } from "../shell/bus";
import { core } from "../shell/runtime";
import { projectStore } from "../shell/project-store";
import { readHome } from "../shell/landing";
import { useActiveProject } from "../shell/use-shell";
import { registerNewProject } from "./model";
import { WelcomeScreen, type WelcomeActions } from "./WelcomeScreen";
import type { WelcomeSsh } from "./SshWelcome.tsx";
import { invokeHost, switchToSshMode } from "../shell/host";
import { createSshServerIo } from "../settings/ssh-server-model";

/** The Home section: shown while no project is open (and reachable any time from the nav). */
export default function WelcomeSection({ mode, onOpenServerFolder }: SectionProps) {
  const p = useActiveProject();
  const [focusNew, setFocusNew] = useState(0);
  const [guideSignal, setGuideSignal] = useState(0);
  // The SSH connect card talks to the host through the same commands as Settings' SSH card.
  const ssh = useMemo<WelcomeSsh>(
    () => ({
      io: createSshServerIo(invokeHost),
      // The confirmed Switch: save the SSH mode, then restart. Connect alone saves no mode.
      switchToServer: async () => {
        await switchToSshMode();
        await invokeHost<unknown>("app_restart");
      },
    }),
    [],
  );
  // "New project" buttons elsewhere (the no-project cards) ask for the form via the shell bus.
  useEffect(() => {
    const take = (ev: { section: string; anchor?: string } | null) => {
      if (ev && ev.section === "welcome" && ev.anchor === "new") setFocusNew((n) => n + 1);
      if (ev && ev.section === "welcome" && ev.anchor === "guide") setGuideSignal((n) => n + 1);
    };
    take(shellBus.takePending("goto-section"));
    return shellBus.subscribe("goto-section", (ev) => {
      shellBus.takePending("goto-section");
      take(ev);
    });
  }, []);
  const actions = useMemo<WelcomeActions>(
    () => ({
      createProject: (name) => projectStore.createProject(name, (project) => registerNewProject(project, { core })),
      openFolder: () => projectStore.openFolder(),
      openRecent: (i) => projectStore.openRecent(i),
      forgetRecent: (e) => projectStore.forgetRecent(e),
      closeProject: () => projectStore.closeProject(),
      // Only navigates when a project is actually open (a cancelled dialog leaves the Welcome page in place).
      goHome: () => {
        if (projectStore.getSnapshot().project) shellBus.publish({ type: "goto-section", section: readHome() });
      },
    }),
    [],
  );
  // ssh mode: the Home page is the server's home (its own connection, recent folders and Open folder…). The local
  // actions here (New project, Open folder, the local recents) act on this computer and are refused over ssh.
  const workspace = useMemo(() => serverWorkspaceIo(), []);
  const serverDeps = useMemo(() => serverOpenDeps(), []);
  const serverHome = mode === "ssh" ? (
    <ServerHome
      io={ssh.io}
      workspace={workspace}
      deps={serverDeps}
      folder={p.project}
      onOpenPicker={() => onOpenServerFolder?.()}
      onOpened={goHomeAfterOpen}
      onContinue={goHomeAfterOpen}
      onCloseServer={() => closeServerConnection(projectStore.guardLeave, () => invokeHost<unknown>("app_restart"))}
    />
  ) : undefined;
  return <WelcomeScreen project={p.project} recent={p.recentAll} error={p.error} actions={actions} focusNew={focusNew} guideSignal={guideSignal} ssh={ssh} serverHome={serverHome} />;
}
