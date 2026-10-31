// Public surface of the Explorer screen (S-C). The shell lazy-loads the default export (SectionProps).
//
// The default export is the screen plus the cross-screen glue: an "open-file" request on the shell bus (from Chat
// tool results, Library) opens the file in a regular tab once the screen has a controller. Requests that arrived
// before this section was first mounted wait on the bus (sticky) and are taken on mount.
import "@llmide/ui-kit/styles.css";
import "./explorer.css";
import { useEffect, useMemo, useRef } from "react";
import { shellBus } from "@llmide/screens/shell";
import type { SectionProps } from "@llmide/screens/shell";
import type { ExplorerController } from "./controller";
import { ExplorerScreen, type ExplorerDeps } from "./ExplorerScreen";

export { ExplorerScreen, type ExplorerDeps } from "./ExplorerScreen";
export { ExplorerController, type ExplorerSnapshot } from "./controller";
export { createHostFs, type FsApi } from "./fs";

export default function Explorer(props: SectionProps) {
  const ctl = useRef<ExplorerController | null>(null);
  const deps = useMemo<ExplorerDeps>(() => ({ onController: (c) => { ctl.current = c; } }), []);
  useEffect(() => {
    const open = (path: string) => void ctl.current?.openFile(path, false);
    const late = shellBus.takePending("open-file");
    if (late) open(late.path);
    return shellBus.subscribe("open-file", (ev) => {
      shellBus.takePending("open-file"); // handled live: acknowledge
      open(ev.path);
    });
  }, []);
  return <ExplorerScreen {...props} deps={deps} />;
}
