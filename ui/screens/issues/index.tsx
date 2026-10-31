// Issues section entry: the shell lazy-loads this module (default export, SectionProps). The screen takes its two
// host seams as props so tests render it without Tauri.
import type { SectionProps } from "@llmide/screens/shell";
import { core } from "../shell/runtime";
import { invokeHost } from "../shell/host";
import { IssuesScreen, type IssuesDeps } from "./IssuesScreen";

export default function Issues(props: SectionProps) {
  const deps: IssuesDeps = {
    request: async (method, path, body) => {
      const r = await core.requestRaw(path, { method, body });
      return { status: r.status, body: r.body };
    },
    openExternal: async (url) => {
      await invokeHost<unknown>("open_external_url", { url });
    },
  };
  return <IssuesScreen {...props} deps={deps} />;
}
