// Permission mode explanations and the persistent Bypass header (S-G). The mode chip itself is the S-B PermissionChip;
// Bypass is only reachable through the native `bypass_confirm` (ChatScreen.changePermission), this only shows the state.
import type { PermissionMode } from "../route";

export const MODE_EXPLANATION: Record<PermissionMode, string> = {
  ask: "Ask: you confirm each edit and command.",
  "accept-edits": "Accept Edits: file edits inside the project are applied without asking. Commands, network access and extension tools still ask.",
  bypass: "Bypass is on: tools run without asking, including commands that change or delete files. Switch back to Ask in the Permissions menu.",
};

export function ModeBanner({ mode }: { mode: PermissionMode }) {
  if (mode === "ask") return null;
  return (
    <div className="appr-mode" data-mode={mode} role="status" aria-label={mode === "bypass" ? "Bypass mode is on" : "Accept Edits mode is on"}>
      <strong>{mode === "bypass" ? "BYPASS ON" : "Accept Edits"}</strong> {MODE_EXPLANATION[mode]}
    </div>
  );
}
