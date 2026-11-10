// The Explorer section: file tree (left), editor tabs and Monaco (right). Wiring only; behaviour lives in
// `controller.ts` and the pure models, which are tested without a DOM.
import { shellBus } from "../shell/bus";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Chip, Icon, ResizableDivider, StatusBanner } from "@llmide/ui-kit";
import type { SectionProps } from "../shell/sections";
import { ExplorerController } from "./controller";
import { ConfirmDialog, ProjectFoldersDialog, PromptDialog, UnsavedDialog, type ProjectFolderRow } from "./Dialogs";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { EditorPane } from "./EditorPane";
import type { EditorHost } from "./editor-types";
import { FileTree } from "./FileTree";
import { absolutePathUnder, createHostFs, baseName, nativeBaseName, parentOf, toFsError, type Encoding, type FsApi, type WatchBatch } from "./fs";
import { defaultKv, type KV } from "./session";
import { ChatDockSlot } from "../shell/chat-dock";
import { host as shellHost, invokeHost } from "../shell/host";
import { DOCK_MAX, DOCK_MIN, clampDockWidth, dockFits, readDockPrefs, writeDockPrefs, type DockPrefs } from "./dock-model";
import { ExplorerTabBar } from "./TabBar";
import { topLevel } from "./tree-model";
import { DEFAULT_PANEL, panelForKey, type PanelId } from "./panels";
import { terminalCwd } from "../settings/repo-config.ts";
import { PanelTabs } from "./PanelTabs";
import { SearchController } from "./search/controller";
import { createHostSearch, type SearchApi } from "./search/host";
import { SearchPanel } from "./search/SearchPanel";
import { bomShift, buildReplacer, replaceListedInFiles, replaceOneAt, type ReplaceTarget } from "./search/replace";
import { folderIncludeGlob, type SearchOptions } from "./search/model";
import { NoProjectCard } from "../shell/NoProjectCard";
import { TerminalManager, type TermHost } from "./terminal/manager";
import { setTerminalDockOpen, useTerminalDockOpen } from "./terminal/dock-state";
import { TERMINAL_BUILT as SHARED_TERMINAL_BUILT, loadTerminalRuntime as sharedLoadRuntime, sharedTerminalManager } from "./terminal/shared";
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
  | { type: "move"; paths: string[]; dest: string; copy: boolean }
  | { type: "unsaved"; id: string };

type MenuState = { x: number; y: number; target: { kind: "tree"; path: string | null } | { kind: "tab"; id: string } };

// Desktop-side modules, resolved lazily so Monaco and the Tauri channel are not in the entry chunk.
const defaultLoadEditor = (): Promise<EditorHost> => import("../../../desktop/src/editor/explorerHost").then((m) => m.createMonacoEditorHost());
const defaultChannel = (cb: (b: WatchBatch) => void): Promise<unknown> => import("../../../desktop/src/editor/explorerBridge").then((m) => m.createWatchChannel(cb));

// Terminal and search bridges live in desktop/ (xterm and Tauri channels are not resolvable from ui/screens).
const TERMINAL_BUILT: boolean = SHARED_TERMINAL_BUILT;
const defaultSearchChannel = (cb: (e: never) => void): Promise<unknown> => import("../../../desktop/src/search/searchBridge").then((m) => m.createSearchChannel(cb));
const loadDefaultRuntime = (): Promise<TerminalRuntime> => sharedLoadRuntime();

const copy = (text: string) => {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
};

/** Line breaks cannot be in a name (the Mac refuses them too: a wrapped line pasted into a name is invisible). */
const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;

export function ExplorerScreen({ active, projectRoot, deps }: SectionProps & { deps?: ExplorerDeps }) {
  const editorRef = useRef<EditorHost | null>(null);
  const fs = useMemo(() => deps?.fs ?? createHostFs(defaultChannel), []);
  const controller = useMemo(
    () => new ExplorerController({ fs, editor: () => editorRef.current, kv: deps?.kv }),
    // The dependencies are fixed for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const loadEditor = deps?.loadEditor ?? defaultLoadEditor;
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [width, setWidth] = useState(280);
  const [showFiles, setShowFiles] = useState(() => { try { return localStorage.getItem("llmide.explorer.files") !== "0"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem("llmide.explorer.files", showFiles ? "1" : "0"); } catch { /* session */ } }, [showFiles]);
  useEffect(() => {
    const toggle = () => setChatDock((d) => ({ ...d, open: !d.open }));
    globalThis.addEventListener?.("llmide:toggle-code-assistant", toggle);
    return () => globalThis.removeEventListener?.("llmide:toggle-code-assistant", toggle);
  }, []);

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
  const dockOpen = useTerminalDockOpen();
  const [dockEver, setDockEver] = useState(dockOpen);
  // The status bar (outside this screen) can open the shared dock; keep the Explorer copy mounted then too.
  useEffect(() => { if (dockOpen) setDockEver(true); }, [dockOpen]);
  const [dockHeight, setDockHeight] = useState(DOCK_DEFAULT);
  const [runtime, setRuntime] = useState<TerminalRuntime | null>(deps?.terminal?.runtime ?? null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [folders, setFolders] = useState<{ root: string; rows: ProjectFolderRow[] } | null>(null);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [foldersBusy, setFoldersBusy] = useState(false);
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
  const terminal = useMemo(() => (deps?.terminal?.host ? new TerminalManager(deps.terminal.host) : sharedTerminalManager()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  const openDock = useCallback((open: boolean) => {
    if (!TERMINAL_BUILT) return; // the feature is not in this build; the shortcut and the toggle do nothing
    setTerminalDockOpen(open);
    if (open) setDockEver(true);
  }, []);

  useEffect(() => {
    if (!dockEver || runtime) return;
    let live = true;
    void loadDefaultRuntime().then((r) => { if (live) { setRuntime(r); setRuntimeError(null); } }, (e: unknown) => { if (live) setRuntimeError(e instanceof Error ? e.message : String(e)); });
    return () => {
      live = false;
    };
  }, [dockEver, runtime, runtimeAttempt]);

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
    void controller.init(projectRoot, "code").then(() => {
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
    if (path === null) return snap.treeBase;
    const e = findEntry(snap, path);
    return e?.kind === "dir" ? path : parentOf(path);
  };

  const treeMenu = (path: string | null): MenuItem[] => {
    const sel = path !== null && snap.selection.paths.has(path) ? topLevel(snap.selection.paths) : path !== null ? [path] : [];
    const single = sel.length === 1;
    const isFile = path !== null && findEntry(snap, path)?.kind === "file";
    return [
      ...(isFile && single ? [{ id: "open", label: "Open" }] : []),
      { id: "cut", label: sel.length > 1 ? `Cut ${sel.length} Items` : "Cut", disabled: sel.length === 0 },
      { id: "copy", label: sel.length > 1 ? `Copy ${sel.length} Items` : "Copy", disabled: sel.length === 0 },
      { id: "paste", label: "Paste", disabled: controller.getClipboard() === null, separator: true },
      { id: "new-file", label: "New File…", separator: isFile && single },
      { id: "new-dir", label: "New Folder…" },
      { id: "rename", label: "Rename…", disabled: !single, separator: true },
      { id: "delete", label: sel.length > 1 ? `Move ${sel.length} Items to Trash` : "Move to Trash", disabled: sel.length === 0, danger: true },
      { id: "copy-path", label: "Copy Relative Path", disabled: sel.length === 0 },
      { id: "copy-abs", label: "Copy Absolute Path", disabled: sel.length === 0 || !projectRoot, separator: true },
      { id: "reveal", label: "Reveal in Finder", disabled: sel.length === 0 || !projectRoot },
      ...(path !== null && single && findEntry(snap, path)?.kind === "dir" ? [{ id: "find-in", label: "Find in Folder", separator: true }] : []),
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
    if (id === "cut") controller.setClipboard("cut");
    else if (id === "copy") controller.setClipboard("copy");
    else if (id === "paste") void controller.paste(targetDir(path));
    else if (id === "open" && path) void controller.openFile(path, false);
    else if (id === "new-file") setDialog({ type: "prompt", kind: "new-file", dir: targetDir(path) });
    else if (id === "new-dir") setDialog({ type: "prompt", kind: "new-dir", dir: targetDir(path) });
    else if (id === "rename" && path) setDialog({ type: "prompt", kind: "rename", path });
    else if (id === "delete" && sel.length) setDialog({ type: "delete", paths: sel });
    else if (id === "copy-path" && sel.length) copy(sel.join("\n"));
    else if (id === "copy-abs" && sel.length && projectRoot) copy(sel.map((p) => absolutePathUnder(projectRoot, p)).join("\n"));
    // One reveal only: the host rate-limits reveal_in_os (300 ms gap), so a loop would open the first item and
    // silently drop the rest. Revealing several items in one Finder window needs a host command that takes a list.
    else if (id === "reveal" && sel.length) void invokeHost("reveal_in_os", { relPath: path && sel.includes(path) ? path : sel[0] }).catch(() => undefined);
    else if (id === "find-in" && path) {
      // The Mac's "Find in Folder": scope the project search to the folder and show the Search panel.
      search.setOptions({ include: folderIncludeGlob(path) });
      setPanel("search");
      setFocusSearch((n) => n + 1);
    }
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
  useEffect(() => shellBus.subscribe("project-changed", () => { void refreshAll(); }), [snap.tree]);

  /** Replace All: only the listed matches, each file checked against its listed positions (see replaceListedInFiles). */
  const replaceAllInSearch = useCallback(async (query: string, opts: SearchOptions, targets: ReplaceTarget[], replacement: string, preserveCase: boolean) => {
    const re = buildReplacer(query, opts);
    if (!re) return { files: 0, replacements: 0, failed: ["The query is not a valid regular expression."], changed: [] };
    const result = await replaceListedInFiles<Encoding>(fs, re, { regex: opts.regex, preserveCase }, targets, replacement);
    void refreshAll();
    return result;
  }, [fs]);

  /** Replaces the one match at `line`/`col`. The file is read fresh and the match re-checked at that exact spot; the write is compare-and-swap on the hash read, so a file changed since is never overwritten. */
  const replaceOneInSearch = useCallback(async (path: string, line: number, col: number, query: string, opts: SearchOptions, replacement: string, preserveCase: boolean) => {
    const re = buildReplacer(query, opts);
    if (!re) return { ok: false, message: "The query is not a valid regular expression." };
    try {
      const read = await fs.read(path, 4_000_000);
      if (read.status !== "ok" || read.text === null || read.hash === null) return { ok: false, message: "Could not read that file." };
      const textCol = bomShift(line, col, read.bom && read.encoding === "utf-8");
      const next = replaceOneAt(read.text, re, line, textCol, replacement, { regex: opts.regex, preserveCase });
      if (next === null) return { ok: false, message: "That match is no longer there. Search again." };
      await fs.write(path, next, { encoding: read.encoding, bom: read.bom, expected_hash: read.hash });
      void refreshAll();
      return { ok: true, message: "Replaced 1 match." };
    } catch (e) {
      const err = toFsError(e);
      return { ok: false, message: err.code === "conflict" ? "The file changed on disk since the search. Search again." : `Could not replace: ${err.message}` };
    }
  }, [fs]);
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
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const key = e.key.toLowerCase();
    if (mod && !typing && (key === "c" || key === "x" || key === "v")) {
      e.preventDefault();
      if (key === "v") void controller.paste(targetDir(topLevel(snap.selection.paths)[0] ?? null));
      else controller.setClipboard(key === "x" ? "cut" : "copy");
      return;
    }
    if (mod && key === "s" && id) {
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

  const name = nativeBaseName(projectRoot) || projectRoot;
  const chatFits = dockFits(viewportW, width);
  const chatVisible = chatDock.open && chatFits;
  useEffect(() => {
    globalThis.dispatchEvent?.(new CustomEvent("llmide:code-assistant-state", { detail: { open: chatVisible, fits: chatFits } }));
  }, [chatVisible, chatFits]);

  const chatWidth = clampDockWidth(chatDock.width, viewportW, width);

  const loadFolders = useCallback(async () => {
    setFoldersBusy(true);
    setFoldersError(null);
    try {
      const raw = await invokeHost<unknown>("project_paths");
      const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const root = typeof o.root === "string" ? o.root : projectRoot;
      const list = Array.isArray(o.folders) ? o.folders : [];
      const rows: ProjectFolderRow[] = [];
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        if (typeof r.name !== "string" || r.name.length === 0) continue;
        rows.push({ name: r.name.slice(0, 200), exists: r.exists === true });
        if (rows.length >= 64) break;
      }
      setFolders({ root, rows });
    } catch (e) {
      setFoldersError(e instanceof Error ? e.message : "The project folders could not be read.");
    } finally {
      setFoldersBusy(false);
    }
  }, [projectRoot]);

  const openFolders = () => {
    setFoldersOpen(true);
    void loadFolders();
  };
  const revealFolder = (relPath: string) => {
    void invokeHost("reveal_in_os", { relPath }).catch(() => undefined);
  };

  return (
    <div className="ex-root" data-active={active} onKeyDown={onKeyDown}>
      {!showFiles ? <button type="button" className="ex-files-show" aria-label="Show files" title="Show files" onClick={() => setShowFiles(true)}>☰</button> : null}
      {showFiles ? <aside className="ex-side" style={{ width }} aria-label="Side panel">
        <PanelTabs active={panel} onChange={(id) => { setPanel(id); if (id === "search") setFocusSearch((n) => n + 1); }} />
        <div className="ex-panel" role="tabpanel" id="ex-panel-explorer" aria-labelledby="ex-ptab-explorer" hidden={panel !== "explorer"}>
        <div className="ex-side-head">
          <span className="ex-project" title={projectRoot}>{name}</span>
          {snap.git?.branch && <Chip label={snap.git.branch + (snap.git.ahead ? ` ↑${snap.git.ahead}` : "") + (snap.git.behind ? ` ↓${snap.git.behind}` : "")} compact />}
          <span className="ex-spacer" />
          {shellHost.isAvailable() ? (
            <button type="button" className="ui-icon-button" aria-label="Project folders" title="Project folders" onClick={openFolders}>
              <Icon name="folder-cog" size={14} />
            </button>
          ) : null}
          <button type="button" className="ui-icon-button" aria-label="Collapse all" title="Collapse all" onClick={() => controller.collapseAll()}>
            <Icon name="chevrons-right" size={14} />
          </button>
          <button type="button" className="ui-icon-button" aria-label="New file" title="New file" onClick={() => setDialog({ type: "prompt", kind: "new-file", dir: targetDir(snap.focusPath) })}>+</button>
          <button type="button" className="ui-icon-button" aria-label="New folder" title="New folder" onClick={() => setDialog({ type: "prompt", kind: "new-dir", dir: targetDir(snap.focusPath) })}>▣</button>
          <button type="button" className="ui-icon-button" aria-label="Hide files" title="Hide files" onClick={() => setShowFiles(false)}>◧</button>
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
          onDropMove={(paths, dest, copy) => setDialog({ type: "move", paths, dest, copy })}
          onKeyCommand={(cmd, path) => {
            if (cmd === "rename") setDialog({ type: "prompt", kind: "rename", path });
            else setDialog({ type: "delete", paths: snap.selection.paths.has(path) ? topLevel(snap.selection.paths) : [path] });
          }}
        />
        </div>
        <div className="ex-panel" role="tabpanel" id="ex-panel-search" aria-labelledby="ex-ptab-search" hidden={panel !== "search"}>
          <SearchPanel controller={search} focusSignal={focusSearch} onReplaceAll={replaceAllInSearch} onReplaceOne={replaceOneInSearch} />
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
      </aside> : null}
      {showFiles ? <ResizableDivider
        width={width}
        min={160}
        max={640}
        label="Resize file tree"
        onWidthChange={(w) => {
          setWidth(w);
          controller.setTreeWidth(w);
        }}
      /> : null}
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
        {TERMINAL_BUILT && dockEver && runtime && (
          <TerminalDock
            manager={terminal}
            runtime={runtime}
            projectRoot={terminalCwd(projectRoot)}
            projectName={name}
            open={dockOpen}
            height={dockHeight}
            onHeightChange={(h) => setDockHeight(clampDock(h, typeof window === "undefined" ? 1000 : window.innerHeight))}
            onClose={() => openDock(false)}
          />
        )}
        {TERMINAL_BUILT && dockEver && !runtime && dockOpen ? <p className="tm-empty" role={runtimeError ? "alert" : "status"}>{runtimeError ? `The terminal could not load: ${runtimeError} ` : "Loading terminal…"}{runtimeError ? <button type="button" className="ex-tool" onClick={() => { setRuntimeError(null); setRuntimeAttempt((n) => n + 1); }}>Retry</button> : null}</p> : null}

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
            <ChatDockSlot surface="explorer" active={active} projectRoot={projectRoot} initialPath={snap.tabs.activeId && findEntry(snap, snap.tabs.activeId)?.kind === "file" ? snap.tabs.activeId : null} onCollapse={() => setChatDock((d) => ({ ...d, open: false }))} />
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

      {foldersOpen && (
        <ProjectFoldersDialog
          root={folders?.root ?? projectRoot}
          folders={folders?.rows ?? []}
          error={foldersError}
          busy={foldersBusy}
          onReveal={revealFolder}
          onRefresh={() => void loadFolders()}
          onCancel={() => setFoldersOpen(false)}
        />
      )}

      {dialog?.type === "prompt" && (
        <PromptDialog
          title={dialog.kind === "rename" ? "Rename" : dialog.kind === "new-file" ? "New file" : "New folder"}
          label={dialog.kind === "new-dir" ? "Folder name" : dialog.kind === "new-file" ? "File name" : "New name"}
          initial={dialog.kind === "rename" ? baseName(dialog.path) : ""}
          confirmLabel={dialog.kind === "rename" ? "Rename" : "Create"}
          validate={(v) => (v.trim() === "" ? "Enter a name." : LINE_BREAK.test(v) ? "Names can't contain line breaks." : /[\\/\0]/.test(v) ? "A name cannot contain slashes." : v.trim() === "." || v.trim() === ".." ? "That name is not allowed." : null)}
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
          title={dialog.copy ? "Copy" : "Move"}
          message={`${dialog.copy ? "Copy" : "Move"} ${dialog.paths.length === 1 ? "this item" : `these ${dialog.paths.length} items`} into ${dialog.dest === "" ? "the project root" : `"${dialog.dest}"`}?`}
          items={dialog.paths}
          confirmLabel={dialog.copy ? "Copy" : "Move"}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const d = dialog;
            setDialog(null);
            if (d.copy) void controller.copyInto(d.paths, d.dest);
            else void controller.moveInto(d.paths, d.dest);
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
