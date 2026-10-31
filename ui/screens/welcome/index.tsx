import { useEffect, useMemo, useState } from "react";
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

/** The Home section: shown while no project is open (and reachable any time from the nav). */
export default function WelcomeSection(_props: SectionProps) {
  const p = useActiveProject();
  const [focusNew, setFocusNew] = useState(0);
  // "New project" buttons elsewhere (the no-project cards) ask for the form via the shell bus.
  useEffect(() => {
    const take = (ev: { section: string; anchor?: string } | null) => {
      if (ev && ev.section === "welcome" && ev.anchor === "new") setFocusNew((n) => n + 1);
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
  return <WelcomeScreen project={p.project} recent={p.recentAll} error={p.error} actions={actions} focusNew={focusNew} />;
}
