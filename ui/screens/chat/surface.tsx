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
import { TauriChatStore } from "./tauri-store";
import { safeHref } from "./markdown";
import { ApprovalsPanel, TrustBanner } from "./approvals";
import type { ChatState } from "./state";
import { createBypassGate, type BypassGate } from "./bypass";
import { createCatalogLoader } from "./slash/loader";
import { createHostAttach } from "./attach/host";
import { createHostProjectFs } from "./mentions/project-fs";
import { createMentionSearch } from "./mentions";
import type { ComposeServices } from "./slash/extras";
import type { CoreTransport } from "./transport";
import { createChatUiStore, type ChatUiStore } from "./ui-state";

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

let runtime: ChatRuntime | null = null;

/** The app's one chat runtime, created on first use. */
export function chatRuntime(): ChatRuntime {
  if (runtime) return runtime;
  const transport = coreTransportFrom(shellCore);
  // Capability choice: inside the desktop app the chat file store (Mac format, live-then-archive) is the one copy;
  // in a plain browser (vite dev, the extension) the core's own chat routes are.
  const store: ChatStore = shellHost.isAvailable() ? new TauriChatStore({ invoke: invokeHost, ready: () => chatBinding.whenBound() }) : new HttpChatStore(transport);
  // Bypass approval gate: only in the desktop app (the host signs the approval); a plain browser has none, so Bypass
  // is refused there. The token lives inside this gate's memory only.
  const bypass = shellHost.isAvailable()
    ? createBypassGate({ confirmSigned: (chatId, summary) => invokeHost<string | null>("bypass_confirm_signed", { chatId, summary }).then((t) => (typeof t === "string" ? t : null), () => null) })
    : null;
  const root: { current: string | null } = { current: null };
  const controller = new ChatController({ core: transport, store, workspaceRoot: () => root.current ?? "", ...(bypass ? { bypass } : {}) });
  const ui = createChatUiStore(null);
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
  runtime = {
    transport, store, bypass, controller, ui, root,
    noteProject(next) {
      if (noted !== undefined && noted !== next) {
        bypass?.endAll();
        ui.setActiveId(null); // the open chat belonged to the previous project: start clean like a fresh screen
      }
      noted = next;
    },
  };
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
export function useChatSurface(projectRoot: string | null, active: boolean): ChatSurface {
  const rt = chatRuntime();
  rt.root.current = projectRoot;
  const { controller, transport, bypass } = rt;
  useEffect(() => rt.noteProject(projectRoot), [rt, projectRoot]);
  useEffect(() => { if (active) void controller.refreshRemoteBusy(); }, [active, controller]);
  // Webview load/reload and every return to the surface: pick up turns still running on the core (replay re-attach).
  useEffect(() => {
    if (!active) return undefined;
    const ac = new AbortController();
    void controller.reattachRunning(ac.signal);
    return () => ac.abort();
  }, [active, controller]);
  // Unmount: stop reading streams. Turns sent detached keep running on the core and are picked up on the next load.
  // The controller counts mounts, so the Chat section and the dock can both be mounted.
  useEffect(() => controller.mount(), [controller]);

  // Slash menu, @ mentions, attachments, plan saving: host-backed only inside the desktop app, and the project fs
  // only while a project is open (the host confines every path to its root; the webview never sends an absolute one).
  const hasProject = projectRoot !== null;
  const compose = useMemo<ComposeServices>(() => {
    const desktop = shellHost.isAvailable();
    const project = desktop && hasProject ? createHostProjectFs(invokeHost) : null;
    const sections: Record<string, "settings" | "library"> = { settings: "settings", library: "library" };
    return {
      catalog: createCatalogLoader(transport),
      project,
      mentions: createMentionSearch({ fs: project, core: transport }),
      attachHost: desktop ? createHostAttach(invokeHost) : null,
      openSection: (section) => { const target = sections[section]; if (!target) return false; shellBus.publish({ type: "goto-section", section: target }); return true; },
      openLibraryTarget: () => shellBus.publish({ type: "goto-section", section: "library" }),
    };
  }, [transport, hasProject]);
  const host = useMemo<ChatHost>(
    () => ({
      ...BASE_HOST,
      compose,
      // Bypass needs the host's signed, default-Cancel approval (`bypass_confirm_signed`); without the host it fails closed.
      ...(bypass ? { bypass } : {}),
      projectRoot: () => rt.root.current,
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
