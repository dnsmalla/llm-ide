// Gantt section entry: the shell lazy-loads this module (default export, SectionProps). The two host seams are
// passed in so the screen renders in tests without Tauri.
import type { SectionProps } from "@llmide/screens/shell";
import { core } from "../shell/runtime";
import { invokeHost } from "../shell/host";
import { GanttScreen, type GanttDeps } from "./GanttScreen.tsx";

export default function Gantt(props: SectionProps) {
  const deps: GanttDeps = {
    request: async (method, path, body) => {
      const r = await core.requestRaw(path, { method, body });
      return { status: r.status, body: r.body };
    },
    openExternal: async (url) => {
      await invokeHost<unknown>("open_external_url", { url });
    },
  };
  return <GanttScreen {...props} deps={deps} />;
}
