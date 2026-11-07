// Which chat belongs to which surface. The core's session rows have no per-screen scope yet, so the webview
// remembers the surface that created a chat: the Chat section keeps the shared history, while Explorer, Review
// and Doc Gen only list and reopen the chats they created.
const KEY = "llmide.chat.surface.v1";
const memory = new Map<string, string>();

function read(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function write(map: Record<string, string>): void {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(map)); } catch { /* memory only */ }
}
export function claimSession(surface: string, id: string): void {
  memory.set(id, surface);
  const map = read(); map[id] = surface; write(map);
}
export function sessionOwner(id: string): string | null {
  return memory.get(id) ?? read()[id] ?? null;
}
/** The Chat section owns unclaimed (legacy) chats; a dock sees only its own. */
export function sessionVisible(surface: string, id: string): boolean {
  const owner = sessionOwner(id);
  return surface === "chat" ? owner === null || owner === "chat" : owner === surface;
}
