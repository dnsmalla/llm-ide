// The Explorer section: file tree (left), editor tabs and Monaco (right). Wiring only; behaviour lives in
// `controller.ts` and the pure models, which are tested without a DOM.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Chip, Icon, ResizableDivider, StatusBanner } from "@llmide/ui-kit";
import type { SectionProps } from "../shell/sections";
import { ExplorerController } from "./controller";
import { ConfirmDialog, PromptDialog, UnsavedDialog } from "./Dialogs";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { EditorPane } from "./EditorPane";
import type { EditorHost } from "./editor-types";
import { FileTree } from "./FileTree";
import { createHostFs, baseName, parentOf, type FsApi, type WatchBatch } from "./fs";
import { defaultKv, type KV } from "./session";
import { ChatDockSlot } from "../shell/chat-dock";
import { DOCK_MAX, DOCK_MIN, clampDockWidth, dockFits, readDockPrefs, writeDockPrefs, type DockPrefs } from "./dock-model";
import { ExplorerTabBar } from "./TabBar";
import { topLevel } from "./tree-model";
import { DEFAULT_PANEL, isDockToggleKey, panelForKey, type PanelId } from "./panels";
import { PanelTabs } from "./PanelTabs";
import { SearchController } from "./search/controller";
import { createHostSearch, type SearchApi } from "./search/host";
import { SearchPanel } from "./search/SearchPanel";
import { NoProjectCard } from "../shell/NoProjectCard";
import { TerminalManager, type TermHost } from "./terminal/manager";
import { TerminalDock, DOCK_DEFAULT, clampDock } from "./terminal/TerminalDock";
import type { TerminalRuntime } from "./terminal/runtime-types";

const ScmPanelLazy = lazy(() => import("./scm"));

export interface ExplorerDeps {
  fs?: FsApi;
  kv?: KV | null;
  loadEditor?: () => Promise<EditorHost>;
  /** Hands the controller to the section entry (cross-screen "open file" requests); called with null on unmount. */
  onController?: (c: ExplorerController | null) => void;
  /** Project search host (tests inject a fake). */
  search?: SearchApi;
  /** Terminal host and xterm runtime (tests inject fakes); the defaults load xterm lazily on first use. */
  terminal?: { host: TermHost; runtime: TerminalRuntime };
}

type Dialog =
  | { type: "prompt"; kind: "new-file" | "new-dir"; dir: string }
  | { type: "prompt"; kind: "rename"; path: string }
  | { type: "delete"; paths: string[] }
  | { type: "move"; paths: string[]; dest: string }
  | { type: "unsaved"; id: string };

type MenuState = { x: number; y: number; target: { kind: "tree"; path: string | null } | { kind: "tab"; id: string } };

// Desktop-side modules, resolved lazily so Monaco and the Tauri channel are not in the entry chunk.
const defaultLoadEditor = (): Promise<EditorHost> => import("../../../desktop/src/editor/explorerHost").then((m) => m.createMonacoEditorHost());
const defaultChannel = (cb: (b: WatchBatch) => void): Promise<unknown> => import("../../../desktop/src/editor/explorerBridge").then((m) => m.createWatchChannel(cb));

// Terminal and search bridges live in desktop/ (xterm and Tauri channels are not resolvable from ui/screens).
type DockModule = typeof import("../../../desktop/src/terminal/dockRuntime");
let dockModule: Promise<DockModule> | null = null;
const loadDock = (): Promise<DockModule> => (dockModule ??= import("../../../desktop/src/terminal/dockRuntime"));
const lazyTermHost: TermHost = {
  status: async () => (await loadDock()).hostTerminal.status(),
  retryConsent: async () => (await loadDock()).hostTerminal.retryConsent(),
  spawn: async (c, r, cb) => (await loadDock()).hostTerminal.spawn(c, r, cb),
};
const defaultSearchChannel = (cb: (e: never) => void): Promise<unknown> => import("../../../desktop/src/search/searchBridge").then((m) => m.createSearchChannel(cb));
const loadDefaultRuntime = async (): Promise<TerminalRuntime> => {
  const m = await loadDock();
  return { create: (el, o) => m.createTermView(el, o), openUrl: (u) => m.hostTerminal.openUrl(u) };
};

const copy = (text: string) => {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
};

export function ExplorerScreen({ active, projectRoot, deps }: SectionProps & { deps?: ExplorerDeps }) {
  const editorRef = useRef<EditorHost | null>(null);
  const controller = useMemo(
    () => new ExplorerController({ fs: deps?.fs ?? createHostFs(defaultChannel), editor: () => editorRef.current, kv: deps?.kv }),
    // The dependencies are fixed for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const loadEditor = deps?.loadEditor ?? defaultLoadEditor;
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [width, setWidth] = useState(280);
  const [panel, setPanel] = useState<PanelId>(DEFAULT_PANEL);
  const [scmSeen, setScmSeen] = useState(false);
  useEffect(() => {
    if (panel === "scm") setScmSeen(true);
  }, [panel]);
  const [focusSearch, setFocusSearch] = useState(0);
  // The docked Code Assistant (right column): open by default like the Mac; width and open state remembered per viewer.
  const dockKv = deps?.kv === undefined ? defaultKv() : deps.kv;
  const [chatDock, setChatDock] = useState<DockPrefs>(() => readDockPrefs(dockKv));
  const [viewportW, setViewportW] = useState(() => (typeof window === "undefined" ? 1600 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const dockWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dockLatest = useRef(chatDock);
  dockLatest.current = chatDock;
  useEffect(() => {
    if (dockWriteTimer.current) clearTimeout(dockWriteTimer.current);
    dockWriteTimer.current = setTimeout(() => writeDockPrefs(dockKv, chatDock), 250);
    return () => {
      if (dockWriteTimer.current) clearTimeout(dockWriteTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatDock]);
  useEffect(() => () => writeDockPrefs(dockKv, dockLatest.current), [dockKv]);
  const [dockOpen, setDockOpen] = useState(false);
  const [dockEver, setDockEver] = useState(false);
  const [dockHeight, setDockHeight] = useState(DOCK_DEFAULT);
  const [runtime, setRuntime] = useState<TerminalRuntime | null>(deps?.terminal?.runtime ?? null);
  const search = useMemo(
    () =>
      new SearchController({
        api: deps?.search ?? createHostSearch(defaultSearchChannel),
        openPaths: () => controller.getSnapshot().tabs.tabs.map((t) => t.id),
        onOpen: (path, line, col) => void controller.openAt(path, line, col),
      }),
    // Fixed for the life of the screen, like the controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller],
  );
  const terminal = useMemo(() => new TerminalManager(deps?.terminal?.host ?? lazyTermHost),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  const openDock = useCallback((open: boolean) => {
    setDockOpen(open);
    if (open) setDockEver(true);
  }, []);

  useEffect(() => {
    if (!dockEver || runtime) return;
    let live = true;
    void loadDefaultRuntime().then((r) => live && setRuntime(r)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [dockEver, runtime]);

  // No shell may outlive its project (the shell's cwd is the project root); search results are per project too.
  useEffect(() => {
    void terminal.closeAll();
    search.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  useEffect(
    () => () => {
      search.dispose();
      void terminal.dispose();
    },
    [search, terminal],
  );

  useEffect(() => {
    deps?.onController?.(controller);
    return () => deps?.onController?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  useEffect(() => {
    void controller.init(projectRoot).then(() => {
      const w = controller.getTreeWidth();
      if (w) setWidth(w);
    });
  }, [controller, projectRoot]);

  useEffect(() => {
    const flush = () => controller.flushSession();
    const warn = (e: BeforeUnloadEvent) => {
      if (controller.getSnapshot().tabs.tabs.some((t) => t.dirty)) e.preventDefault();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", warn);
      controller.flushSession();
      controller.dispose();
    };
  }, [controller]);

  const closeTab = useCallback(
    (id: string) => {
      if (controller.requestClose(id) === "prompt") setDialog({ type: "unsaved", id });
    },
    [controller],
  );

  const targetDir = (path: string | null): string => {
    if (path === null) return "";
    const e = findEntry(snap, path);
    return e?.kind === "dir" ? path : parentOf(path);
  };

  const treeMenu = (path: string | null): MenuItem[] => {
    const sel = path !== null && snap.selection.paths.has(path) ? topLevel(snap.selection.paths) : path !== null ? [path] : [];
    const single = sel.length === 1;
    const isFile = path !== null && findEntry(snap, path)?.kind === "file";
    return [
      ...(isFile && single ? [{ id: "open", label: "Open" }] : []),
      { id: "new-file", label: "New File…", separator: isFile && single },
      { id: "new-dir", label: "New Folder…" },
      { id: "rename", label: "Rename…", disabled: !single, separator: true },
      { id: "delete", label: sel.length > 1 ? `Move ${sel.length} Items to Trash` : "Move to Trash", disabled: sel.length === 0, danger: true },
      { id: "copy-path", label: "Copy Relative Path", disabled: !single, separator: true },
      { id: "refresh", label: "Refresh" },
    ];
  };

  const tabMenu = (id: string): MenuItem[] => {
    const t = snap.tabs.tabs.find((x) => x.id === id);
    return [
      { id: "close", label: "Close" },
      { id: "close-others", label: "Close Others" },
      { id: "close-all", label: "Close All" },
      { id: "pin", label: t?.pinned ? "Unpin Tab" : "Pin Tab", separator: true },
      { id: "copy-path", label: "Copy Relative Path" },
    ];
  };

  const pickMenu = (id: string) => {
    const m = menu;
    setMenu(null);
    if (!m) return;
    if (m.target.kind === "tab") {
      const tid = m.target.id;
      if (id === "close") closeTab(tid);
      else if (id === "close-others") controller.closeOthers(tid);
      else if (id === "close-all") controller.closeAll();
      else if (id === "pin") controller.pinTab(tid, !snap.tabs.tabs.find((x) => x.id === tid)?.pinned);
      else if (id === "copy-path") copy(tid);
      return;
    }
    const path = m.target.path;
    const sel = path !== null && snap.selection.paths.has(path) ? topLevel(snap.selection.paths) : path !== null ? [path] : [];
    if (id === "open" && path) void controller.openFile(path, false);
    else if (id === "new-file") setDialog({ type: "prompt", kind: "new-file", dir: targetDir(path) });
    else if (id === "new-dir") setDialog({ type: "prompt", kind: "new-dir", dir: targetDir(path) });
    else if (id === "rename" && path) setDialog({ type: "prompt", kind: "rename", path });
    else if (id === "delete" && sel.length) setDialog({ type: "delete", paths: sel });
    else if (id === "copy-path" && path) copy(path);
    else if (id === "refresh") void refreshAll();
  };

  const openDiff = async (path: string) => {
    await controller.openFile(path, false);
    if (controller.getSnapshot().diffPath !== path) await controller.toggleDiff(path);
  };

  const refreshAll = async () => {
    for (const d of snap.tree.dirs.keys()) await controller.refreshDir(d);
    void controller.refreshGit();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!active) return;
    const mod = e.metaKey || e.ctrlKey;
    const id = snap.tabs.activeId;
    const want = panelForKey(e, typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || ""));
    if (want) {
      e.preventDefault();
      setPanel(want);
      if (want === "search") setFocusSearch((n) => n + 1);
      return;
    }
    if (isDockToggleKey(e)) {
      e.preventDefault();
      openDock(!dockOpen);
      return;
    }
    if (mod && e.key.toLowerCase() === "s" && id) {
      e.preventDefault();
      void controller.save(id);
    } else if (mod && e.key.toLowerCase() === "w" && id) {
      e.preventDefault();
      closeTab(id);
    }
  };

  if (!projectRoot) {
    return (
      <div className="ex-root" data-active={active}>
        <NoProjectCard what="browse files" hint="Open a project folder to browse and edit its files." />
      </div>
    );
  }

  const name = baseName(projectRoot.replace(/[\\/]+$/, "")) || projectRoot;
  const chatFits = dockFits(viewportW, width);
  const chatVisible = chatDock.open && chatFits;
  const chatWidth = clampDockWidth(chatDock.width, viewportW, width);

  return (
    <div className="ex-root" data-active={active} onKeyDown={onKeyDown}>
      <aside className="ex-side" style={{ width }} aria-label="Side panel">
        <PanelTabs active={panel} onChange={(id) => { setPanel(id); if (id === "search") setFocusSearch((n) => n + 1); }} />
        <div className="ex-panel" role="tabpanel" id="ex-panel-explorer" aria-labelledby="ex-ptab-explorer" hidden={panel !== "explorer"}>
        <div className="ex-side-head">
          <span className="ex-project" title={projectRoot}>{name}</span>
          {snap.git?.branch && <Chip label={snap.git.branch + (snap.git.ahead ? ` ↑${snap.git.ahead}` : "") + (snap.git.behind ? ` ↓${snap.git.behind}` : "")} compact />}
          <span className="ex-spacer" />
          <button type="button" className="ui-icon-button" aria-label="New file" title="New file" onClick={() => setDialog({ type: "prompt", kind: "new-file", dir: targetDir(snap.focusPath) })}>+</button>
          <button type="button" className="ui-icon-button" aria-label="New folder" title="New folder" onClick={() => setDialog({ type: "prompt", kind: "new-dir", dir: targetDir(snap.focusPath) })}>▣</button>
          <button type="button" className="ui-icon-button" aria-label="Refresh" title="Refresh" onClick={() => void refreshAll()}>↻</button>
          <button type="button" className="ui-icon-button" aria-label="Show hidden files" aria-pressed={snap.showHidden} title="Show hidden files" onClick={() => controller.setShowHidden(!snap.showHidden)}>.*</button>
          <button type="button" className="ui-icon-button" aria-label="Hide ignored files" aria-pressed={snap.hideIgnored} title="Hide files ignored by .gitignore" onClick={() => controller.setHideIgnored(!snap.hideIgnored)}>⊘</button>
        </div>
        {snap.notice && <StatusBanner severity={snap.notice.severity} message={snap.notice.message} onDismiss={() => controller.dismissNotice()} />}
        {snap.git?.error && <StatusBanner severity="warning" message={`Git status unavailable: ${snap.git.error}`} />}
        {snap.watchMode === "poll" && <StatusBanner severity="info" message="Watching for changes by polling (slower to notice edits made outside the app)." />}
        <FileTree
          controller={controller}
          snap={snap}
          active={active}
          onContextMenu={(path, x, y) => setMenu({ x, y, target: { kind: "tree", path } })}
          onDropMove={(paths, dest) => setDialog({ type: "move", paths, dest })}
          onKeyCommand={(cmd, path) => {
            if (cmd === "rename") setDialog({ type: "prompt", kind: "rename", path });
            else setDialog({ type: "delete", paths: snap.selection.paths.has(path) ? topLevel(snap.selection.paths) : [path] });
          }}
        />
        </div>
        <div className="ex-panel" role="tabpanel" id="ex-panel-search" aria-labelledby="ex-ptab-search" hidden={panel !== "search"}>
          <SearchPanel controller={search} focusSignal={focusSearch} />
        </div>
        {scmSeen && (
          <div className="ex-panel" role="tabpanel" id="ex-panel-scm" aria-labelledby="ex-ptab-scm" hidden={panel !== "scm"}>
            <Suspense fallback={<p className="ex-status" role="status">Loading source control…</p>}>
              <ScmPanelLazy
                projectRoot={projectRoot}
                onOpenFile={(p) => void controller.openFile(p, false)}
                onOpenDiff={(p) => void openDiff(p)}
                onFilesChanged={() => void refreshAll()}
              />
            </Suspense>
          </div>
        )}
      </aside>
      <ResizableDivider
        width={width}
        min={160}
        max={640}
        label="Resize file tree"
        onWidthChange={(w) => {
          setWidth(w);
          controller.setTreeWidth(w);
        }}
      />
      <div className="ex-main">
        <ExplorerTabBar
          tabs={snap.tabs}
          onSelect={(id) => void controller.activateTab(id)}
          onClose={closeTab}
          onPromote={(id) => controller.promoteTab(id)}
          onMove={(id, to) => controller.moveTab(id, to)}
          onContextMenu={(id, x, y) => setMenu({ x, y, target: { kind: "tab", id } })}
        />
        <EditorPane controller={controller} snap={snap} loadEditor={loadEditor} editorRef={editorRef} onCloseTab={closeTab} />
        {dockEver && runtime && (
          <TerminalDock
            manager={terminal}
            runtime={runtime}
            projectRoot={projectRoot}
            projectName={name}
            open={dockOpen}
            height={dockHeight}
            onHeightChange={(h) => setDockHeight(clampDock(h, typeof window === "undefined" ? 1000 : window.innerHeight))}
            onClose={() => openDock(false)}
          />
        )}
        {dockEver && !runtime && dockOpen && <p className="tm-empty" role="status">Loading terminal…</p>}
        <div className="tm-strip">
          <button type="button" className="ex-link tm-toggle" aria-expanded={dockOpen} aria-controls="tm-dock" title="Toggle terminal (Ctrl+`)" onClick={() => openDock(!dockOpen)}>
            Terminal
          </button>
          <span className="ex-spacer" />
          <button
            type="button"
            className="ex-link tm-toggle ex-chat-toggle"
            aria-expanded={chatVisible}
            aria-controls="ex-chat-dock"
            disabled={!chatFits}
            title={chatFits ? "Show or hide the Code Assistant" : "The window is too narrow for the Code Assistant"}
            onClick={() => setChatDock((d) => ({ ...d, open: !d.open }))}
          >
            <Icon name="panel-right" size={13} /> Code Assistant
          </button>
        </div>
      </div>
      {chatVisible && (
        <>
          <ResizableDivider
            width={chatWidth}
            min={DOCK_MIN}
            max={DOCK_MAX}
            invert
            label="Resize Code Assistant"
            onWidthChange={(w) => setChatDock((d) => ({ ...d, width: clampDockWidth(w, viewportW, width) }))}
          />
          <aside id="ex-chat-dock" className="ex-chat" style={{ width: chatWidth }} aria-label="Code Assistant">
            <ChatDockSlot active={active} projectRoot={projectRoot} onCollapse={() => setChatDock((d) => ({ ...d, open: false }))} />
          </aside>
        </>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.target.kind === "tab" ? "Tab actions" : "File actions"}
          items={menu.target.kind === "tab" ? tabMenu(menu.target.id) : treeMenu(menu.target.path)}
          onPick={pickMenu}
          onClose={() => setMenu(null)}
        />
      )}

      {dialog?.type === "prompt" && (
        <PromptDialog
          title={dialog.kind === "rename" ? "Rename" : dialog.kind === "new-file" ? "New file" : "New folder"}
          label={dialog.kind === "new-dir" ? "Folder name" : dialog.kind === "new-file" ? "File name" : "New name"}
          initial={dialog.kind === "rename" ? baseName(dialog.path) : ""}
          confirmLabel={dialog.kind === "rename" ? "Rename" : "Create"}
          validate={(v) => (v.trim() === "" ? "Enter a name." : /[\\/\0]/.test(v) ? "A name cannot contain slashes." : v.trim() === "." || v.trim() === ".." ? "That name is not allowed." : null)}
          onCancel={() => setDialog(null)}
          onSubmit={(v) => {
            const d = dialog;
            setDialog(null);
            if (d.kind === "rename") void controller.renameEntry(d.path, v);
            else void controller.createEntry(d.dir, v, d.kind === "new-dir" ? "dir" : "file");
          }}
        />
      )}
      {dialog?.type === "delete" && (
        <ConfirmDialog
          title="Move to Trash"
          message={dialog.paths.length === 1 ? "Move this item to the system trash?" : `Move these ${dialog.paths.length} items to the system trash?`}
          items={dialog.paths}
          confirmLabel="Move to Trash"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const paths = dialog.paths;
            setDialog(null);
            void controller.deleteEntries(paths);
          }}
        />
      )}
      {dialog?.type === "move" && (
        <ConfirmDialog
          title="Move"
          message={`Move ${dialog.paths.length === 1 ? "this item" : `these ${dialog.paths.length} items`} into ${dialog.dest === "" ? "the project root" : `"${dialog.dest}"`}?`}
          items={dialog.paths}
          confirmLabel="Move"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const d = dialog;
            setDialog(null);
            void controller.moveInto(d.paths, d.dest);
          }}
        />
      )}
      {dialog?.type === "unsaved" && (
        <UnsavedDialog
          name={baseName(dialog.id)}
          onCancel={() => setDialog(null)}
          onDiscard={() => {
            const id = dialog.id;
            setDialog(null);
            controller.discardAndClose(id);
          }}
          onSave={() => {
            const id = dialog.id;
            setDialog(null);
            void controller.saveAndClose(id);
          }}
        />
      )}
    </div>
  );
}

function findEntry(snap: ReturnType<ExplorerController["getSnapshot"]>, path: string) {
  const dir = parentOf(path);
  const d = snap.tree.dirs.get(dir);
  if (!d) return null;
  for (const page of d.pages.values()) for (const e of page) if (e.path === path) return e;
  return null;
}

export default ExplorerScreen;
