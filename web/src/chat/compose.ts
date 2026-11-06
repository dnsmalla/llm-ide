// The web chat's turn options over Host API v1 `compose`: the mode and model the desktop offers, plus text
// attachments (capability chat). No React here. The host re-checks every pick; this only keeps the UI honest.
import type { HostLink } from "../host-api/connection.ts";
import type { HostApiRequest, HostApiResult } from "../host-api/types.generated.ts";
import { ATTACH_LIMITS, readTextAttachment, type FileLike, type WebAttachment } from "./attachments.ts";

type Options = HostApiResult<"chat.options">;
export type ComposeMode = Options["modes"][number];
export type ComposeModels = Options["models"];
export type SendExtras = Omit<HostApiRequest<"chat.send">, "text">;
export interface ComposeState {
  modes: readonly ComposeMode[]; models: ComposeModels; mode: ComposeMode; model: string | null;
  attachments: readonly WebAttachment[]; error: string | null;
}
export const initialComposeState: ComposeState = { modes: [], models: [], mode: "auto", model: null, attachments: [], error: null };
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export function createComposeController(link: HostLink) {
  let state = initialComposeState;
  const subs = new Set<() => void>();
  const set = (p: Partial<ComposeState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };
  const can = () => link.capabilities.has("compose");
  const load = async () => {
    if (!can()) return set({ modes: [], models: [], mode: "auto", model: null });
    try {
      const r = await link.send("chat.options", {}).done;
      set({ modes: r.modes, models: r.models, error: null, mode: r.modes.includes(state.mode) ? state.mode : "auto", model: state.model && r.models.some((m) => m.model === state.model) ? state.model : null });
    } catch (e) { set({ modes: [], models: [], mode: "auto", model: null, error: messageOf(e) }); }
  };
  const offs = [link.onResync(() => { void load(); }), link.onEvent((e) => { if (e.command === "host.capabilities") void load(); })];
  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    load,
    setMode(m: string) { const hit = state.modes.find((x) => x === m); if (hit) set({ mode: hit }); },
    setModel(id: string) { set({ model: id && state.models.some((m) => m.model === id) ? id : null }); },
    async addFiles(files: Iterable<FileLike>) {
      let list = [...state.attachments]; let error: string | null = null;
      for (const f of files) {
        const used = list.reduce((n, a) => n + a.text.length, 0);
        const r = await readTextAttachment(f, used);
        if (!r.ok) { error = r.reason; continue; }
        if (list.length >= ATTACH_LIMITS.maxFiles) { error = "At most 10 files per message."; break; }
        list = [...list, r.attachment];
      }
      set({ attachments: list, error });
    },
    remove(index: number) { set({ attachments: state.attachments.filter((_, i) => i !== index), error: null }); },
    extras(): SendExtras {
      return { ...(can() && state.mode !== "auto" ? { mode: state.mode } : {}), ...(can() && state.model ? { model: state.model } : {}), ...(state.attachments.length ? { attachments: state.attachments.map(({ name, text }) => ({ name, text })) } : {}) };
    },
    clearAttachments() { set({ attachments: [], error: null }); },
    dispose() { for (const off of offs) off(); subs.clear(); },
  };
}
export type ComposeController = ReturnType<typeof createComposeController>;
