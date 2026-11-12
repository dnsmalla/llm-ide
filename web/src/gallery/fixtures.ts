// Fixture state for the dev gallery: no network, no controllers. Only imported by gallery/Gallery.tsx (dev builds).
import { initialChatState, reduce, type ChatAction, type ChatState } from "../chat/store.ts";
import { initialComposeState } from "../chat/compose.ts";
import { initialReadState, type ReadState } from "../read/controller.ts";
import type { ProjectsState } from "../projects/controller.ts";
import type { HostApiCapability } from "../host-api/types.generated.ts";
import type { ExecuteContext, ShellContext, ShellActions } from "../shell/registry.ts";
import type { Session } from "../app-model.ts";
import type { SyncState } from "../sync/controller.ts";
import type { SourcesState } from "../sources/controller.ts";

export const CAPS: ReadonlySet<HostApiCapability> = new Set(["host", "chat", "approvals", "tool_approvals", "read", "compose", "push"]);
const ev = (command: string, payload: unknown, replyTo = "c-1"): ChatAction => ({ type: "event", event: { command, payload, rev: 1, replyTo } as never });
const run = (actions: ChatAction[]): ChatState => actions.reduce(reduce, initialChatState);

const CODE_REPLY = "Here is a small helper that sums the numbers in a list:\n\n```ts\nexport function sum(values: readonly number[]): number {\n  return values.reduce((total, value) => total + value, 0);\n}\n```\n\nIt returns `0` for an empty list, so callers need no special case. A very long line to check horizontal scrolling inside the block: const veryLongName = computeSomethingExpensive(firstArgument, secondArgument, thirdArgument, fourthArgument);";

export const CHAT_EMPTY: ChatState = { ...initialChatState, loaded: true };
export const CHAT_HISTORY: ChatState = run([
  { type: "sent", commandId: "c-0", text: "What does the retry helper do?" },
  ev("chat.delta", { text: "It retries a failed request with exponential backoff, up to five times, then surfaces the last error." }, "c-0"),
  ev("chat.done", { requestId: "c-0" }, "c-0"),
]);
export const CHAT_STREAMING: ChatState = run([
  { type: "sent", commandId: "c-0", text: "What does the retry helper do?" },
  ev("chat.delta", { text: "It retries a failed request with exponential backoff." }, "c-0"),
  ev("chat.done", { requestId: "c-0" }, "c-0"),
  { type: "sent", commandId: "c-1", text: "Write me a helper that sums a list of numbers" },
  ev("chat.delta", { text: CODE_REPLY }),
]);
export const CHAT_TOOL: ChatState = run([
  { type: "sent", commandId: "c-1", text: "Fix the failing test in the router" },
  ev("chat.delta", { text: "I found the cause. The route table is built before the plugins load. I need to edit one file." }),
  ev("toolApproval.request", { requestId: "r-1", commandId: "c-1", toolName: "Edit", filePath: "extension/server/router.mjs", summary: "- const table = buildRoutes();\n+ const table = buildRoutes(await loadPlugins());", truncated: false }),
]);
export const CHAT_WAITING: ChatState = run([
  { type: "sent", commandId: "c-1", text: "Summarize this week's meetings" },
  ev("chat.delta", { text: "Three meetings this week. The main decision was to" }),
  { type: "connectionLost" },
]);

export const PROJECTS: ProjectsState = {
  projects: [{ id: "p-1", name: "Atlas", role: "owner", maxMode: "execute", usdCapMonth: 0, permissions: [] }, { id: "p-2", name: "Docs site", role: "member", maxMode: "read_only", usdCapMonth: 0, permissions: [] }],
  selectedId: "p-1", loading: false, loaded: true, error: null, refusal: null,
};
export const READ: ReadState = {
  ...initialReadState,
  usage: [{ provider: "anthropic", status: "ok", models: [
    { model: "sonnet", label: "Sonnet", state: "ok", unit: "runs", window: "daily", used: 42, limit: 100, pct: 42, resetAt: 0 },
    { model: "opus", label: "Opus", state: "warning", unit: "runs", window: "daily", used: 18, limit: 20, pct: 90, resetAt: 0 },
    { model: "haiku", label: "Haiku", state: "ok", unit: "tokens", window: "monthly", used: 120000, limit: 0, resetAt: 0 }] }] as never,
  sessions: [
    { id: "s0", title: "Phone chat", updatedAt: 3, phoneChat: true }, { id: "s1", title: "Router refactor plan", updatedAt: 2 },
    { id: "s2", title: "Why is the nightly build red?", updatedAt: 1 }, { id: "s3", title: "Summarize the Q4 retro", updatedAt: 0 }] as never,
  nextOffset: 50,
};

const noop = () => undefined;
export const ACTIONS: ShellActions = {
  send: noop, stop: noop, clearHistory: noop, newChat: noop, answerQuestion: noop, declineQuestion: noop, answerTool: noop, selectProject: noop,
  setMode: noop, setModel: noop, removeAttachment: noop, addFiles: noop, readOpen: noop, readOlder: noop, readClose: noop, readMore: noop,
  enablePush: noop, disablePush: noop, forget: noop, changeAddress: async () => null, openOffline: noop, openSources: noop,
};
export function shellContext(chat: ChatState, o: Partial<ShellContext> = {}): ShellContext {
  return {
    // The placeholders and the gallery never touch the session; a real one needs a socket.
    session: {} as unknown as Session,
    conn: { kind: "ready" }, capabilities: CAPS, hub: false, hostName: "Dinesh's MacBook Pro", hostUrl: "wss://192.168.1.20:3016/host-api/v1",
    chat, read: READ, compose: { ...initialComposeState, modes: ["auto", "ask", "plan"], models: [{ model: "claude-sonnet-5-5", label: "Sonnet 5.5" }] },
    projects: PROJECTS, push: { kind: "off", error: null }, offlineLinked: true, actions: ACTIONS, navigate: noop, ...o,
  };
}

/** The Execute chat's slice of the shell context: its own thread, the "execute" mode offered, nothing wired. */
export const executeSlice = (chat: ChatState): ExecuteContext => ({
  chat, compose: { ...initialComposeState, modes: ["auto", "ask", "plan", "execute"], mode: "execute", models: [{ model: "claude-sonnet-5-5", label: "Sonnet 5.5" }] },
  actions: { send: noop, stop: noop, newChat: noop, deleteChat: noop, answerQuestion: noop, declineQuestion: noop, answerTool: noop, setModel: noop, removeAttachment: noop, addFiles: noop },
});
export const CAPS_NO_APPROVALS: ReadonlySet<HostApiCapability> = new Set(["host", "chat", "approvals", "read", "compose", "push"]);

const NOW = 1762400000000;
export const SYNC_READY: SyncState = {
  phase: "ready", pairStep: null, sas: null, busy: false, error: null, notice: null, online: true, email: "sync@example.com", login: true, store: "mega",
  snapshot: { generatedAt: NOW, validUntil: NOW + 2700000, manifestSeq: 9, kinds: {
    chats: { v: 1, kind: "chats", generatedAt: NOW, truncated: false, items: [{ id: "c1", title: "Router plan", updatedAt: 1, messages: [{ seq: 1, role: "user", content: "hi" }] }] },
    meetings: { v: 1, kind: "meetings", generatedAt: NOW, truncated: false, items: [{ id: "m1", title: "Standup", date: "2026-11-05", durationSec: 900, participants: ["Ana", "Dee"], notes: [{ kind: "decision", text: "Ship it Friday" }] }] },
    plans: { v: 1, kind: "plans", generatedAt: NOW, truncated: false, items: [{ id: "p1", title: "Launch", goal: "Go live", updatedAt: 1, tasks: [{ title: "Write docs", status: "open", owner: "Dee", due: "2026-11-09", milestone: "", risk: "" }] }] },
    usage: { v: 1, kind: "usage", generatedAt: NOW, truncated: false, items: [{ providers: [] }] } } } as never,
  stale: true, checkedAt: NOW, pending: [], answered: [],
};
export const SYNC_LOCKED: SyncState = { ...SYNC_READY, phase: "locked", snapshot: null, stale: false };

const root = { id: "r", name: "atlas", kind: "project" as const, path: "team/atlas", size: null, detail: null, project: null };
export const SOURCES_HOME: SourcesState = {
  loaded: true, configured: { gitlab: true, box: false }, signedIn: { gitlab: true, box: false }, provider: null, online: true, busy: false, status: "", error: null,
  trail: [], entries: [], next: null, query: null, opened: null,
};
export const SOURCES_BROWSE: SourcesState = {
  ...SOURCES_HOME, provider: "gitlab", trail: [root],
  entries: [{ ...root, id: "d1", name: "src", kind: "dir", path: "src" }, { ...root, id: "f1", name: "README.md", kind: "file", path: "README.md", size: 2048 }, { ...root, id: "f2", name: "router.mjs", kind: "file", path: "src/router.mjs", size: 8800 }],
};
