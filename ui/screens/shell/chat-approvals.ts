// App-wide count of pending chat approvals (Mac AppShell's toolbar badge), across EVERY chat of every chat surface:
// the Chat section, the Explorer / Review / Doc Gen docks and the side popup. Each surface's controller publishes
// what it holds, whether or not a view is mounted, so a background chat or a collapsed dock that is waiting for an
// answer still raises the badge, the tray count and the OS notification. UI-only, in memory, never persisted.

export interface WaitingChat {
  /** The chat surface whose controller holds the chat ("chat", "explorer", "review", "docgen", "side"). */
  surface: string;
  chatId: string;
  count: number;
}

const bySurface = new Map<string, readonly WaitingChat[]>();
let total = 0;
const listeners = new Set<() => void>();
let reveal: (WaitingChat & { at: number }) | null = null;
const revealListeners = new Set<() => void>();
/** A reveal nobody could show (its dock does not fit, its section is off) must not fire minutes later. */
export const REVEAL_TTL_MS = 15_000;
const liveReveal = (surface: string, now: number): WaitingChat | null => {
  if (reveal && now - reveal.at > REVEAL_TTL_MS) reveal = null;
  return reveal && reveal.surface === surface ? { surface: reveal.surface, chatId: reveal.chatId, count: reveal.count } : null;
};

const sameList = (a: readonly WaitingChat[], b: readonly WaitingChat[]) =>
  a.length === b.length && a.every((x, i) => x.chatId === b[i]!.chatId && x.count === b[i]!.count);

export const chatApprovalStore = {
  /** Approvals and questions waiting for an answer, summed over every chat. */
  get: (): number => total,
  /** Replaces what one surface's controller reports (an empty list when nothing waits there). */
  publish(surface: string, chats: readonly { chatId: string; count: number }[]): void {
    const next = chats.filter((c) => c.count > 0).map((c) => ({ surface, chatId: c.chatId, count: Math.floor(c.count) }));
    if (sameList(bySurface.get(surface) ?? [], next)) return;
    if (next.length === 0) bySurface.delete(surface);
    else bySurface.set(surface, next);
    total = 0;
    for (const list of bySurface.values()) for (const c of list) total += c.count;
    for (const l of [...listeners]) l();
  },
  /** The chat the badge opens: the Chat section's first, then the docks in the order they started waiting. */
  first(): WaitingChat | null {
    const own = bySurface.get("chat");
    if (own?.[0]) return own[0];
    for (const list of bySurface.values()) if (list[0]) return list[0];
    return null;
  },
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); },

  // --- reveal: "show me that chat". Sticky, because the owning screen may not be mounted yet when it is asked.
  /** Asks the owning surface to open its dock (if it has one) and select the chat. */
  requestReveal(target: WaitingChat, now = Date.now()): void {
    reveal = { ...target, at: now };
    for (const l of [...revealListeners]) l();
  },
  /** The pending request for `surface`, left in place (a screen opens its dock on it; the chat list consumes it). */
  peekReveal(surface: string, now = Date.now()): WaitingChat | null { return liveReveal(surface, now); },
  /** The pending request for `surface`, consumed: the caller selects the chat. */
  takeReveal(surface: string, now = Date.now()): WaitingChat | null {
    const r = liveReveal(surface, now);
    if (r) reveal = null;
    return r;
  },
  subscribeReveal(fn: () => void): () => void { revealListeners.add(fn); return () => revealListeners.delete(fn); },
};

/** The section that shows a chat surface (the side popup has no section: the shell opens it itself). */
export function sectionForSurface(surface: string): string | null {
  if (surface === "side") return null;
  if (surface === "review") return "conflicts"; // Review lives inside the Factory section
  return surface === "explorer" || surface === "docgen" ? surface : "chat";
}
