// Issues section entry: the shell lazy-loads this module (default export, SectionProps). The screen takes its two
// host seams as props so tests render it without Tauri.
import { useMemo } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { core } from "../shell/runtime";
import { invokeHost } from "../shell/host";
import { shellBus } from "../shell/bus";
import { useFeatures } from "../shell/use-shell";
import { IssuesScreen, type IssuesDeps } from "./IssuesScreen";
import type { Issue } from "./issues-model.ts";

declare const __FEATURE_AUTO_TASKS__: boolean | undefined;

// Compile-time guard (as in shell/screens.tsx): a build without Loop has no Factory, and its dynamic imports are dropped.
// Loaded on first use, so the Issues chunk does not carry the Factory or Loop code.
const sendIssuesToFactory = typeof __FEATURE_AUTO_TASKS__ === "undefined" || __FEATURE_AUTO_TASKS__
  ? async (projectRoot: string, issues: Issue[], runIntake: boolean): Promise<string> => {
    const [{ createHostFs }, { startRun }, host, intake, board] = await Promise.all([
      import("../explorer/fs"),
      import("../loop/native/run-manager.ts"),
      import("../loop/native/run-manager-host.ts"),
      import("../factory/intake.ts"),
      import("../factory/anchor.ts"),
    ]);
    // The board may never have been opened: startRun throws until the run manager is wired to the real host.
    host.installRunManagerHost();
    const items = issues.map((i) => intake.workItemFromIssue(i));
    const r = await intake.sendToFactory(createHostFs(), items, { runIntake, projectRoot, start: startRun });
    if (items[0]) shellBus.publish({ type: "goto-section", section: "conflicts", anchor: board.factoryAnchor(items[0].key) });
    return intake.sendSummary(r.added, r.existing.length);
  }
  : null;

export default function Issues(props: SectionProps) {
  const features = useFeatures();
  const root = props.projectRoot;
  const factoryOn = features.usable.has("auto_tasks");
  const deps = useMemo<IssuesDeps>(() => {
    const send = sendIssuesToFactory;
    return {
      request: async (method, path, body) => {
        const r = await core.requestRaw(path, { method, body });
        return { status: r.status, body: r.body };
      },
      openExternal: async (url) => {
        await invokeHost<unknown>("open_external_url", { url });
      },
      // The Factory writes to the open project's system/factory/: offered only with a project and Loop usable.
      sendToFactory: send && root !== null && factoryOn ? (issues, runIntake) => send(root, issues, runIntake) : undefined,
    };
  }, [root, factoryOn]);
  return <IssuesScreen {...props} deps={deps} />;
}
