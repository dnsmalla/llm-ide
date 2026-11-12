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
const KNOWN_MODES: readonly string[] = ["auto", "ask", "plan", "assist_plan", "review", "document", "execute"];
const MAX_MODELS = 50;
/** The host re-checks every pick, but a hostile or buggy reply must not reach the UI as-is: keep only well-formed entries. */
export function decodeOptions(r: unknown): { modes: ComposeMode[]; models: ComposeModels } {
  const o = (r && typeof r === "object" ? r : {}) as { modes?: unknown; models?: unknown };
  const modes = Array.isArray(o.modes) ? o.modes.filter((m): m is ComposeMode => typeof m === "string" && KNOWN_MODES.includes(m)) : [];
  const models: ComposeModels = [];
  for (const m of Array.isArray(o.models) ? o.models : []) {
    const id = m?.model;
    const label = m?.label;
    if (typeof id !== "string" || !id || id.length > 200) continue;
    if (label !== undefined && typeof label !== "string") continue;
    models.push(label === undefined ? { model: id } : { model: id, label });
    if (models.length === MAX_MODELS) break;
  }
  return { modes, models };
}
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export function createComposeController(link: HostLink, { projectId, onProjectRefused, surface = "ask" }: {
  projectId?: () => string | null;
  onProjectRefused?: (e: unknown) => void;
  /** "execute": the mode is fixed (the chat controller sends it) and the picker only lists what to choose besides it. */
  surface?: "ask" | "execute";
} = {}) {
  let state = initialComposeState;
  const subs = new Set<() => void>();
  const set = (p: Partial<ComposeState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };
  const can = () => link.capabilities.has("compose");
  // A slow chat.options reply must not overwrite the answer to a newer request (or one that lands after dispose).
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    if (!can()) return set({ modes: [], models: [], mode: "auto", model: null });
    const project = projectId?.() ?? null;
    try {
      const r = decodeOptions(await link.send("chat.options", project ? { projectId: project } : {}).done);
      if (mine !== seq) return;
      // Ask never offers "execute" (that is the other chat); the execute chat is fixed to it, and lists it only when the host does.
      const modes = surface === "execute" ? r.modes : r.modes.filter((m) => m !== "execute");
      set({ modes, models: r.models, error: null, mode: surface === "execute" ? (modes.includes("execute") ? "execute" : "auto") : modes.includes(state.mode) ? state.mode : "auto", model: state.model && r.models.some((m) => m.model === state.model) ? state.model : null });
    } catch (e) {
      if (mine !== seq) return;
      set({ modes: [], models: [], mode: "auto", model: null, error: messageOf(e) });
      onProjectRefused?.(e);
    }
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
        if (list.length >= ATTACH_LIMITS.maxFiles) { error = "At most 10 files per message."; break; }
        const used = list.reduce((n, a) => n + a.text.length, 0);
        const r = await readTextAttachment(f, used);
        if (!r.ok) { error = r.reason; continue; }
        list = [...list, r.attachment];
      }
      set({ attachments: list, error });
    },
    remove(index: number) { set({ attachments: state.attachments.filter((_, i) => i !== index), error: null }); },
    extras(): SendExtras {
      return { ...(can() && surface === "ask" && state.mode !== "auto" ? { mode: state.mode } : {}), ...(can() && state.model ? { model: state.model } : {}), ...(state.attachments.length ? { attachments: state.attachments.map(({ name, text }) => ({ name, text })) } : {}) };
    },
    /** Drops only the attachments that were sent; ones added while the turn was starting stay. */
    removeSent(sent: readonly WebAttachment[]) { set({ attachments: state.attachments.filter((a) => !sent.includes(a)), error: null }); },
    clearAttachments() { set({ attachments: [], error: null }); },
    dispose() { seq += 1; for (const off of offs) off(); subs.clear(); },
  };
}
export type ComposeController = ReturnType<typeof createComposeController>;
