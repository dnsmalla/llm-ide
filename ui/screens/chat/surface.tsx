// The chat wiring both chat surfaces share: the Chat section (`index.tsx`) and the Explorer's docked Code Assistant
// (`dock.tsx`). ONE transport, store, Bypass gate, controller and UI-state store per app (`chatRuntime()`), so a turn
// started in the dock is the same turn the Chat section shows, and nothing forks. Each surface only adds its own
// per-screen host services (slash menu, mentions, attachments) and renders `ChatScreen` with the shared state.
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { chatBinding, core as shellCore, host as shellHost, invokeHost, relativeToProject, shellBus } from "@llmide/screens/shell";
import { coreTransportFrom } from "./adapter";
import type { ChatHost } from "./ChatScreen";
import { ChatController } from "./controller";
import { HttpChatStore, type ChatStore } from "./store";
import { CoreMirrorChatStore } from "./merged-store.ts";
import { TauriChatStore } from "./tauri-store";
import { coreStatusStore } from "../shell/runtime";
import { projectStore } from "../shell/project-store.ts";
import { chatApprovalStore } from "../shell/chat-approvals";
import { safeHref } from "./markdown";
import { ApprovalsPanel, TrustBanner } from "./approvals";
import type { ChatState } from "./state";
import { createBypassGate, type BypassGate } from "./bypass";
import { createCatalogLoader } from "./slash/loader";
import { createHostAttach } from "./attach/host";
import { createHostProjectFs } from "./mentions/project-fs";
import { createMentionSearch } from "./mentions";
import type { ComposeServices } from "./slash/extras";
import { describeError, type CoreTransport } from "./transport";
import { createChatUiStore, type ChatUiStore } from "./ui-state";
import { sessionVisible } from "./surface-sessions";
import { reportUiIncident } from "../shell/self-heal";
import { summarizeGraph } from "./project-graph-summary.ts";

/** Opens an allowlisted URL. The host command is not in the Rust host yet (blocked-by, see the checklist): until it
 *  lands the desktop app ignores the click rather than navigating the webview; a plain browser opens a new tab. */
async function openLink(href: string): Promise<void> {
  const safe = safeHref(href);
  if (!safe) return;
  try {
    await invokeHost("open_external_url", { url: safe });
  } catch {
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) window.open(safe, "_blank", "noopener,noreferrer");
  }
}

const BASE_HOST = {
  openLink: (href: string) => void openLink(href),
  copy: (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); },
};

export interface ChatRuntime {
  transport: CoreTransport;
  store: ChatStore;
  bypass: BypassGate | null;
  controller: ChatController;
  ui: ChatUiStore;
  /** The open project's root as the controller reads it when sending. */
  root: { current: string | null };
  /** A project change ends every Bypass grant (the core's grant is per user and chat; the UI stops relying on it) and closes the open chat. */
  noteProject(root: string | null): void;
}

const runtimes = new Map<string, ChatRuntime>();

/** One chat runtime per surface: the Chat section, Explorer, Review and Doc Gen keep separate open chats. */
export function chatRuntime(surface = "chat"): ChatRuntime {
  const existing = runtimes.get(surface);
  if (existing) return existing;
  const transport = coreTransportFrom(shellCore);
  // Capability choice: inside the desktop app the chat file store (Mac format, live-then-archive) is the one copy;
  // in a plain browser (vite dev, the extension) the core's own chat routes are.
  const remote = coreStatusStore.getSnapshot().status?.mode === "remote";
  const store: ChatStore = shellHost.isAvailable() && !remote
    ? new CoreMirrorChatStore(new TauriChatStore({ invoke: invokeHost, ready: () => chatBinding.whenBound() }), transport)
    : new HttpChatStore(transport);
  // Bypass approval gate: only in the desktop app (the host signs the approval); a plain browser has none, so Bypass
  // is refused there. The token lives inside this gate's memory only.
  const bypass = shellHost.isAvailable()
    ? createBypassGate({ confirmSigned: (chatId, summary) => invokeHost<string | null>("bypass_confirm_signed", { chatId, summary }).then((t) => (typeof t === "string" ? t : null), () => null) })
    : null;
  const root: { current: string | null } = { current: null };
  const controller = new ChatController({
    core: transport, store, workspaceRoot: () => root.current ?? "", ...(bypass ? { bypass } : {}),
    // Each surface follows only its own chats after a re-attach (the other surface's controller would save the reply too).
    canFollow: (id) => sessionVisible(surface, id),
    // A message that could not be saved is a bug report for the self-heal channel (debug builds) as well as a notice.
    onPersistError: (_id, err) => reportUiIncident("chat", `could not save a chat message: ${describeError(err).message}`),
  });
  const ui = createChatUiStore(null, bypass ? "bypass" : "ask");
  let noted: string | null | undefined;
  // Sign-out ends every Bypass grant.
  if (bypass) {
    let was = shellCore.getSnapshot().signedIn;
    shellCore.subscribe(() => {
      const now = shellCore.getSnapshot().signedIn;
      if (was && !now) bypass.endAll();
      was = now;
    });
  }
  const runtime: ChatRuntime = {
    transport, store, bypass, controller, ui, root,
    noteProject(next) {
      if (noted !== undefined && noted !== next) {
        bypass?.endAll();
        ui.setActiveId(null); // the open chat belonged to the previous project: start clean like a fresh screen
      }
      noted = next;
    },
  };
  // The app-wide approval badge counts every chat this controller holds, not only the one a mounted screen shows: a
  // background chat or a collapsed dock waiting for an answer must still reach the badge, the tray and the notification.
  controller.subscribe(() => chatApprovalStore.publish(surface, controller.pendingApprovalCounts()));
  // A hidden surface keeps reading its turn and sends its queue when the turn ends, but it does not render, so the
  // render-time `root` above would go stale across a project change: a queued message would be sent into the previous
  // project and its Bypass grants would survive. The runtime follows the project store itself.
  projectStore.subscribe(() => {
    const snap = projectStore.getSnapshot();
    if (!snap.loaded) return;
    const next = snap.project?.root ?? null;
    root.current = next;
    runtime.noteProject(next);
  });
  runtimes.set(surface, runtime);
  return runtime;
}

export interface ChatSurface {
  rt: ChatRuntime;
  host: ChatHost;
  approvals: (s: ChatState) => ReactNode;
  banner: (s: ChatState) => ReactNode;
}

/**
 * Wires one chat surface to the shared runtime. `active` = this surface is on screen: only then does it re-check
 * what is running on the core and re-attach to running turns (a hidden surface stays quiet).
 */
export function useChatSurface(projectRoot: string | null, active: boolean, initialPath: string | null = null, surface = "chat"): ChatSurface {
  const rt = chatRuntime(surface);
  rt.root.current = projectRoot;
  const { controller, transport, bypass } = rt;
  useEffect(() => rt.noteProject(projectRoot), [rt, projectRoot]);
  useEffect(() => { if (active) void controller.refreshRemoteBusy(); }, [active, controller]);
  // The controller counts mounts, so the Chat section and the dock can both be mounted. An unmount (a collapsed dock,
  // a closed popup) leaves its streams running: the reply is saved when the turn ends, with or without a view. This
  // runs before the re-attach below: a mount clears the controller's disposed flag, and re-attach does nothing while
  // it is set.
  useEffect(() => controller.mount(), [controller]);
  // Webview load/reload and every return to the surface: pick up turns still running on the core (replay re-attach).
  useEffect(() => {
    if (!active) return undefined;
    const ac = new AbortController();
    void controller.reattachRunning(ac.signal);
    return () => ac.abort();
  }, [active, controller]);

  // Slash menu, @ mentions, attachments, plan saving: host-backed only inside the desktop app, and the project fs
  // only while a project is open (the host confines every path to its root; the webview never sends an absolute one).
  const hasProject = projectRoot !== null;
  // The host-backed services keep their identity while the project stays the same. They must NOT be rebuilt when
  // `initialPath` changes (a dock's suggested file follows the editor tab): each chat's attachment manager is tied to
  // these objects, and new ones would dispose it, dropping the user's attached files on every tab click.
  const services = useMemo(() => {
    const desktop = shellHost.isAvailable();
    const project = desktop && hasProject ? createHostProjectFs(invokeHost) : null;
    return { catalog: createCatalogLoader(transport), project, mentions: createMentionSearch({ fs: project, core: transport }), attachHost: desktop ? createHostAttach(invokeHost) : null };
  }, [transport, hasProject]);
  const compose = useMemo<ComposeServices>(() => {
    const sections: Record<string, "settings" | "library"> = { settings: "settings", library: "library" };
    return {
      catalog: services.catalog,
      project: services.project,
      mentions: services.mentions,
      attachHost: services.attachHost,
      openSection: (section) => { const target = sections[section]; if (!target) return false; shellBus.publish({ type: "goto-section", section: target }); return true; },
      openLibraryTarget: () => shellBus.publish({ type: "goto-section", section: "library" }),
      initialPath: hasProject ? initialPath : null,
    };
  }, [services, hasProject, initialPath]);
  const host = useMemo<ChatHost>(
    () => ({
      ...BASE_HOST,
      compose,
      // Bypass needs the host's signed, default-Cancel approval (`bypass_confirm_signed`); without the host it fails closed.
      ...(bypass ? { bypass } : {}),
      projectRoot: () => rt.root.current,
      graphSummary: async () => {
        if (!shellHost.isAvailable()) return null;
        try {
          const mem = await invokeHost<unknown>("project_memory");
          const o = mem && typeof mem === "object" ? (mem as Record<string, unknown>) : {};
          const g = o.graph && typeof o.graph === "object" ? (o.graph as Record<string, unknown>) : null;
          const path = g && typeof g.path === "string" ? g.path : null;
          const size = g && typeof g.sizeBytes === "number" ? g.sizeBytes : 0;
          if (!path) return null;
          if (size > 8_000_000) return `Project graph: ${Math.round(size / 1_000_000)} MB on disk (large; open Graph for the interactive view).`;
          const text = await invokeHost<unknown>("read_graph_file", { path });
          if (typeof text !== "string") return null;
          return summarizeGraph(JSON.parse(text));
        } catch { return null; }
      },
      files: {
        resolve: (raw) => relativeToProject(raw, rt.root.current),
        open: (rel) => shellBus.publish({ type: "open-file", path: rel }),
      },
    }),
    [compose, bypass, rt],
  );
  // S-G: approval/question cards and the trust banner read the running chat's state; decisions go through the controller.
  const approvals = useCallback((s: ChatState) => (
    <ApprovalsPanel state={s} projectRoot={rt.root.current} decide={(req) => controller.decide(s.sessionId, req)} />
  ), [controller, rt]);
  // Trusting a folder starts its MCP servers: a native, default-Cancel dialog with fixed text naming the folder (host
  // command `trust_confirm`). Without the host there is no native dialog and the in-page confirmation stands alone.
  const nativeTrustConfirm = useMemo(
    () => (shellHost.isAvailable()
      ? (_title: string, _body: string, path: string) => invokeHost<boolean>("trust_confirm", { path }).then((ok) => ok === true, () => false)
      : undefined),
    [],
  );
  const banner = useCallback((s: ChatState) => (
    <TrustBanner trust={s.workspaceTrust} core={transport} onTrusted={(path) => controller.trustGranted(s.sessionId, path)} nativeConfirm={nativeTrustConfirm} />
  ), [controller, transport, nativeTrustConfirm]);
  return { rt, host, approvals, banner };
}
