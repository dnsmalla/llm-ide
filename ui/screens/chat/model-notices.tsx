// The model picker's two action notices (the Mac's ComposerCatalog): "Allow tools on provider models" and "Turn on the
// session router". Chat never writes these settings: the button only asks the shell to open Settings, Model routing,
// where the switches live. Pure rules first, then the bus call and the markup.
import { shellBus, type ShellBus } from "../shell/bus";
import type { ModelGroup, PlainChatReason } from "./route";

/** The Settings group that holds the tools and session-router switches (ModelRoutingSwitches on the Mac). */
export const MODEL_ROUTING_ANCHOR = "model-routing";
export const TOOLS_NOTICE = { text: "Tools on provider models are off: these models answer in ask and document modes only.", label: "Allow tools on provider models" } as const;
export const ROUTER_NOTICE = { text: "Chat on these models needs the session router, which is off.", label: "Turn on the session router (applies at next backend start)" } as const;

export type ModelNoticeKind = "tools" | "router";

/** Which notices the picker offers: tools when a chat is plain because tools are off; the router when it is off and catalog models exist. */
export function modelNotices(opts: { plainChat: PlainChatReason | null | undefined; routerOn: boolean | undefined; groups: readonly ModelGroup[] }): ModelNoticeKind[] {
  const out: ModelNoticeKind[] = [];
  if (opts.plainChat === "toolsOff") out.push("tools");
  if (opts.routerOn === false && opts.groups.some((g) => g.catalog)) out.push("router");
  return out;
}

/** The whole effect of the notice's button: one bus message that opens Settings at Model routing. */
export function openModelRouting(bus: Pick<ShellBus, "publish"> = shellBus): void {
  bus.publish({ type: "goto-section", section: "settings", anchor: MODEL_ROUTING_ANCHOR });
}

export function ModelNotices({ kinds }: { kinds: readonly ModelNoticeKind[] }) {
  return (
    <>
      {kinds.map((k) => {
        const n = k === "tools" ? TOOLS_NOTICE : ROUTER_NOTICE;
        return (
          <span key={k} className="chat-note" role="note">
            {n.text} <button type="button" className="chat-link-btn" onClick={() => openModelRouting()}>{n.label}</button>
          </span>
        );
      })}
    </>
  );
}
