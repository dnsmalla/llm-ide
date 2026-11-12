// Whether the Execute chat can be used on this host. The core refuses chat.send mode "execute" without the `compose` and
// `tool_approvals` grants, and chat.options lists "execute" only when the project and the desktop allow it. No React here.
import type { HostApiCapability } from "../host-api/types.generated.ts";
import type { ComposeState } from "./compose.ts";

export type ExecuteAvailability = { ok: true } | { ok: false; reason: "no_grant" | "not_offered" };

export function executeAvailability(caps: ReadonlySet<HostApiCapability>, compose: ComposeState): ExecuteAvailability {
  // An empty set means the host has not said yet (first connect): do not flash the "unavailable" page.
  if (caps.size > 0 && (!caps.has("compose") || !caps.has("tool_approvals"))) return { ok: false, reason: "no_grant" };
  // modes is empty until chat.options answers; once it has, "execute" is there only when usable.
  if (compose.modes.length > 0 && !compose.modes.includes("execute")) return { ok: false, reason: "not_offered" };
  return { ok: true };
}

export const EXECUTE_UNAVAILABLE: Record<"no_grant" | "not_offered", { title: string; text: string }> = {
  no_grant: {
    title: "Execute is not turned on for this browser",
    text: "Running code changes needs your OK on each step, and this browser was not given that. On the desktop, turn on “Let paired devices answer tool approvals”, then pair this browser again.",
  },
  not_offered: {
    title: "The desktop is not offering Execute",
    text: "The selected project or the desktop does not allow code changes from a paired device right now. Pick another project, or check the project's mode on the desktop. Ask still works.",
  },
};
