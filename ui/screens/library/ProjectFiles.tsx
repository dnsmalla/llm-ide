// Library > Project files: the Mac's Code and Data categories as lazy file trees with a read-only viewer. The note
// sections stay the notes index; these two come from the project folders through the host's fs commands.
// With `mutate` (desktop app) a row can be moved to the Trash, and a category's "+" adds a text file or an empty
// folder. Every change is confirmed or explicit; the rules live in project-ops.ts.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CodeIcon, FileTreeRow, FolderIcon, Icon, TableIcon } from "@llmide/ui-kit";
import { fileKind, fileKindIcon } from "../explorer/file-kind.ts";
import { shellBus } from "../shell/bus";
import { Dialog } from "./write/Dialog";
import { MarkdownView } from "./MarkdownView";
import { PROJECT_ROOTS, decodeProjectEntries, decodeProjectFile, projectSaveRequest, type ProjectEntry } from "./project-files.ts";
import { addFilesToFolder, addSummary, createFolder, pickReason, planRemove, runRemove, validateEntryName, type Mutations, type RemovePlan } from "./project-ops.ts";
import { Floating } from "../shell/Floating";

export interface ProjectFilesDeps {
  list: (path: string) => Promise<unknown>;
  read: (path: string) => Promise<unknown>;
  /** Add and remove (trash only). Absent: the tree is read-only and "+" opens Explorer. */
  mutate?: Mutations;
  /** Save an edited Markdown project file in place. */
  write?: (path: string, text: string, opts: { expected_hash: string | null; encoding: string; bom: boolean }) => Promise<string>;
}

interface MenuState {
  /** The row that was right-clicked; null for the category's "+" menu. */
  entry: ProjectEntry | null;
  /** The folder new files and folders go into. */
  target: string;
  x: number;
  y: number;
}

export function ProjectFilesNav({ deps, selected, onSelect, active = true }: { deps: ProjectFilesDeps; selected: string | null; onSelect: (path: string | null) => void; active?: boolean }): ReactNode {
  const [roots, setRoots] = useState<Record<string, ProjectEntry[] | "error" | undefined>>({});
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  const [children, setChildren] = useState<Map<string, ProjectEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [closedRoots, setClosedRoots] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [removal, setRemoval] = useState<Extract<RemovePlan, { ok: true }> | null>(null);
  const [newFolderIn, setNewFolderIn] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.("[data-lib-menu]")) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", key); };
  }, [menu]);
  const [notice, setNotice] = useState<string | null>(null);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const mutate = deps.mutate;

  const loadRoot = useCallback(async (path: string) => {
    try {
      const entries = decodeProjectEntries(await deps.list(path));
      setRoots((r) => ({ ...r, [path]: entries }));
      const count = async (dir: string, cap = 5000): Promise<number> => {
        let n = 0;
        try {
          const list = decodeProjectEntries(await deps.list(dir));
          for (const e of list) {
            if (n >= cap) return cap;
            if (e.kind === "dir") n += await count(e.path, cap - n); else n += 1;
          }
        } catch { /* unreadable subtree */ }
        return n;
      };
      const total = await count(path);
      setCounts((c) => ({ ...c, [path]: total }));
    } catch {
      setRoots((r) => ({ ...r, [path]: "error" }));
    }
  }, [deps]);

  const reload = useCallback(() => {
    // Children are dropped, so an expanded folder would show an open caret over nothing; collapse them too.
    setChildren(new Map());
    setExpanded(new Set());
    setClosedRoots(new Set(["code", "data"]));
    void loadRoot("code");
    void loadRoot("data");
  }, [loadRoot]);

  /** After a change: re-list the roots and every expanded folder, keeping what is open. */
  const refreshTree = useCallback(() => {
    void loadRoot("code");
    void loadRoot("data");
    for (const path of [...childrenRef.current.keys()]) {
      deps.list(path).then(
        (body) => setChildren((m) => new Map(m).set(path, decodeProjectEntries(body))),
        () => setChildren((m) => { const n = new Map(m); n.delete(path); return n; }),
      );
    }
  }, [deps, loadRoot]);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);
  useEffect(() => shellBus.subscribe("project-changed", () => { if (active) reload(); }), [active, reload]);

  const toggle = async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((s) => { const n = new Set(s); n.delete(path); return n; });
      return;
    }
    setExpanded((s) => new Set(s).add(path));
    if (children.has(path)) return;
    try {
      const entries = decodeProjectEntries(await deps.list(path));
      setChildren((m) => new Map(m).set(path, entries));
    } catch {
      setChildren((m) => new Map(m).set(path, []));
    }
  };

  const pickDir = (path: string) => {
    setSelectedDir(path);
    void toggle(path);
  };

  const targetFor = (rootPath: string): string =>
    selectedDir !== null && (selectedDir === rootPath || selectedDir.startsWith(`${rootPath}/`)) ? selectedDir : rootPath;

  const askRemove = (entry: ProjectEntry) => {
    setMenu(null);
    const count = entry.kind === "dir" && children.has(entry.path) ? children.get(entry.path)!.length : null;
    const plan = planRemove(entry.path, entry.kind, count);
    if (plan.ok) setRemoval(plan);
    else setNotice(plan.message);
  };

  const confirmRemove = async (plan: Extract<RemovePlan, { ok: true }>) => {
    setRemoval(null);
    if (!mutate) return;
    const r = await runRemove(plan, (p) => mutate.trash(p));
    if (r.ok) {
      setNotice(`"${plan.name}" was moved to the Trash.`);
      if (selected !== null && (selected === plan.path || selected.startsWith(`${plan.path}/`))) onSelect(null);
      if (selectedDir !== null && (selectedDir === plan.path || selectedDir.startsWith(`${plan.path}/`))) setSelectedDir(null);
    } else {
      setNotice(r.message);
    }
    refreshTree();
  };

  const addFiles = async (target: string) => {
    setMenu(null);
    if (!mutate) return;
    try {
      const picks = await mutate.pick();
      if (picks.files.length === 0 && picks.rejected.length === 0) return; // the dialog was cancelled
      const res = await addFilesToFolder(mutate, target, picks.files);
      setNotice(addSummary(res.added, [...picks.rejected.map((r) => ({ name: r.name, reason: pickReason(r.reason) })), ...res.skipped], res.notes));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The files could not be added.");
    }
    refreshTree();
  };

  const categoryHead = (rootPath: string, label: string): ReactNode => {
    if (!mutate) {
      return <button type="button" className="lib-plus" aria-label={`Open Explorer to add ${label}`} title={`Open Explorer to add ${label}`} onClick={() => shellBus.publish({ type: "goto-section", section: "explorer" })}>＋</button>;
    }
    return (
      <button type="button" className="lib-plus" aria-haspopup="menu" aria-label={`Add to ${label}`} title={`Add to ${label}`} onClick={(e) => setMenu({ entry: null, target: targetFor(rootPath), x: e.clientX, y: e.clientY })}>＋</button>
    );
  };

  return (
    <section className="lib-project" aria-label="Project files">
      {PROJECT_ROOTS.map((root) => {
        const entries = roots[root.path];
        const open = !closedRoots.has(root.path);
        return (
          <div key={root.path} className="lib-project-root" data-accent={root.path}>
            <div className="lib-project-headrow">
              <button type="button" className="lib-project-head" aria-expanded={open} onClick={() => setClosedRoots((s) => {
                const n = new Set(s);
                if (n.has(root.path)) n.delete(root.path); else n.add(root.path);
                return n;
              })}>
                <span className="lib-project-caret">{open ? "▾" : "▸"}</span> <span className="lib-project-icon" aria-hidden="true">{root.path === "code" ? <CodeIcon /> : <TableIcon />}</span> {root.label}
              </button>
              {root.path === "code" && counts[root.path] !== undefined ? <span className="lib-count">{counts[root.path]!.toLocaleString()}</span> : null}
              {categoryHead(root.path, root.label)}
            </div>
            {open ? (
              entries === undefined ? <p className="lib-muted lib-project-note">Loading…</p>
                : entries === "error" ? <p className="lib-muted lib-project-note">{root.path}/ is missing.</p>
                : entries.length === 0 ? <p className="lib-muted lib-project-note">No files in {root.path}/.</p>
                : (
                  <ul className="lib-project-list">
                    {entries.map((e) => (
                      <ProjectRow key={e.path} entry={e} depth={0} childrenOf={(p) => children.get(p) ?? []} expanded={expanded} onToggle={pickDir} onSelect={onSelect} selected={selected} onMenu={mutate ? (entry, x, y) => setMenu({ entry, target: entry.path, x, y }) : undefined} />
                    ))}
                  </ul>
                )
            ) : null}
          </div>
        );
      })}
      {notice ? <p className="lib-muted lib-project-note" role="status">{notice}</p> : null}
      {menu ? (
        <Floating anchor={{ x: menu.x, y: menu.y }} onDismiss={() => setMenu(null)} className="lib-context" role="menu" data-lib-menu onMouseLeave={() => setMenu(null)} onKeyDown={(e) => { if (e.key === "Escape") setMenu(null); }}>
          <button type="button" role="menuitem" className="lib-context-close" aria-label="Close menu" onClick={() => setMenu(null)}>×</button>
          {menu.entry === null ? (
            <>
              <div className="lib-muted lib-context-note" role="none">Adds to {menu.target}</div>
              <button type="button" role="menuitem" onClick={() => void addFiles(menu.target)}>Add File…</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(null); setNewFolderIn(menu.target); }}>Add Folder…</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(null); shellBus.publish({ type: "goto-section", section: "explorer" }); }}>Open Explorer</button>
            </>
          ) : (
            <button type="button" role="menuitem" onClick={() => askRemove(menu.entry!)}>Remove…</button>
          )}
          <button type="button" role="menuitem" onClick={() => setMenu(null)}>Close</button>
        </Floating>
      ) : null}
      {removal ? <RemoveDialog plan={removal} onConfirm={() => void confirmRemove(removal)} onCancel={() => setRemoval(null)} /> : null}
      {newFolderIn !== null && mutate ? (
        <NewFolderDialog
          folder={newFolderIn}
          onCancel={() => setNewFolderIn(null)}
          onCreate={async (name) => {
            await createFolder(mutate.create, newFolderIn, name);
            setNewFolderIn(null);
            refreshTree();
          }}
        />
      ) : null}
    </section>
  );
}

/** Cancel is focused and is the only answer a stray Enter reaches: the removal needs the explicit button. */
export function RemoveDialog({ plan, onConfirm, onCancel }: { plan: Extract<RemovePlan, { ok: true }>; onConfirm: () => void; onCancel: () => void }): ReactNode {
  return (
    <Dialog title={plan.title} role="alertdialog" onClose={onCancel}>
      <p>{plan.message}</p>
      <div className="lib-modal-actions">
        <button type="button" className="lib-btn" data-autofocus onClick={onCancel}>Cancel</button>
        <button type="button" className="lib-btn lib-btn-danger" onClick={onConfirm}>Move to Trash</button>
      </div>
    </Dialog>
  );
}

export function NewFolderDialog({ folder, onCreate, onCancel }: { folder: string; onCreate: (name: string) => Promise<void>; onCancel: () => void }): ReactNode {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = name === "" ? null : validateEntryName(name);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || validateEntryName(name) !== null) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The folder could not be created.");
      setBusy(false);
    }
  };
  return (
    <Dialog title="New folder" onClose={onCancel} busy={busy}>
      <form onSubmit={submit}>
        <p className="lib-muted">An empty folder is created in {folder}/. Nothing is copied in from outside the project.</p>
        <label>
          Name
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} aria-invalid={problem !== null || undefined} />
        </label>
        <p className="lib-muted" role="status">{error ?? problem ?? ""}</p>
        <div className="lib-modal-actions">
          <button type="button" className="lib-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="lib-btn" disabled={busy || validateEntryName(name) !== null}>Create folder</button>
        </div>
      </form>
    </Dialog>
  );
}

function ProjectRow({ entry, depth, childrenOf, expanded, onToggle, onSelect, selected, onMenu }: {
  entry: ProjectEntry;
  depth: number;
  childrenOf: (path: string) => ProjectEntry[];
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selected: string | null;
  onMenu?: (entry: ProjectEntry, x: number, y: number) => void;
}): ReactNode {
  const dir = entry.kind === "dir";
  const open = expanded.has(entry.path);
  const kind = fileKind(entry.name, dir);
  return (
    <li
      className="lib-project-row"
      role="none"
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(entry, e.clientX, e.clientY); } : undefined}
    >
      <FileTreeRow
        name={entry.name}
        isFolder={dir}
        isExpanded={open}
        depth={depth}
        icon={dir ? <FolderIcon /> : <Icon name={fileKindIcon(kind)} size={11} />}
        kind={kind}
        selected={!dir && selected === entry.path}
        onClick={() => (dir ? onToggle(entry.path) : onSelect(entry.path))}
        onToggle={dir ? () => onToggle(entry.path) : undefined}
      />
      {dir && open ? (
        <ul className="lib-project-list" role="group">
          {childrenOf(entry.path).map((c) => (
            <ProjectRow key={c.path} entry={c} depth={depth + 1} childrenOf={childrenOf} expanded={expanded} onToggle={onToggle} onSelect={onSelect} selected={selected} onMenu={onMenu} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ProjectFileView({ path, deps, onClose, onDirtyChange }: { path: string; deps: ProjectFilesDeps; onClose: () => void; onDirtyChange?: (dirty: boolean) => void }): ReactNode {
  const [body, setBody] = useState<ReturnType<typeof decodeProjectFile> | "error" | undefined>(undefined);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [readNonce, setReadNonce] = useState(0);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    let live = true;
    setBody(undefined); setDirty(false); setSaveError(null);
    deps.read(path).then(
      (r) => { if (!live) return; const d = decodeProjectFile(r); setBody(d); setText(d?.text ?? ""); setConfirmDiscard(false); },
      () => live && setBody("error"),
    );
    return () => { live = false; };
  }, [deps, path, readNonce]);
  const name = path.split("/").pop() ?? path;
  const markdown = /\.(md|markdown)$/i.test(path);
  const canEdit = markdown && body !== undefined && body !== "error" && body !== null && !body.read_only && typeof deps.write === "function";
  const save = async () => {
    if (!deps.write || saving) return;
    setSaving(true); setSaveError(null);
    try {
      if (!body || body === "error") return;
      const req = projectSaveRequest(body, text);
      const out = req.text;
      const hash = await deps.write(path, out, { expected_hash: req.expected_hash, encoding: req.encoding, bom: req.bom });
      setBody((b) => b && b !== "error" ? { ...b, text: out, hash } : b);
      setDirty(false); setMode("preview");
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "";
      setSaveError(code === "conflict" ? "The file changed on disk. Reload to see the current version." : "The file could not be saved.");
    }
    finally { setSaving(false); }
  };
  return (
    <div className="lib-project-view" aria-label={`${name} preview`}>
      <div className="lib-project-view-head">
        <strong>{name}</strong>
        <span className="lib-muted">{path}</span>
        <span className="lib-project-spacer" />
        {markdown ? (
          <div className="lib-view-toggle" role="group" aria-label="View mode">
            <button type="button" className="lib-btn" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
            <button type="button" className="lib-btn" aria-pressed={mode === "edit"} disabled={!canEdit} onClick={() => setMode("edit")}>Edit</button>
          </div>
        ) : null}
        {dirty ? <button type="button" className="lib-btn lib-btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button> : null}
        <button type="button" className="lib-btn" aria-label="Close file" title="Close" onClick={() => dirty ? setConfirmDiscard(true) : onClose()}>Close</button>
      </div>
      {body === undefined ? <p className="lib-muted" role="status">Reading…</p>
        : body === "error" ? <p className="lib-muted">The file could not be read.</p>
        : body === null ? <p className="lib-muted">This file is binary or too large to preview here.</p>
        : mode === "edit" && markdown ? (
          <textarea className="lib-project-edit" aria-label={`Edit ${name}`} value={text} spellCheck={false}
            onChange={(e) => { setText(e.target.value); setDirty(true); }} />
        ) : markdown ? (
          <div className="lib-project-markdown"><MarkdownView text={text} baseRel={path} /></div>
        ) : (
          <pre className="lib-project-text">{body.text}</pre>
        )}
      {saveError ? <p className="lib-error" role="alert">{saveError} {body && body !== "error" && body !== null ? <button type="button" className="lib-link-btn" onClick={() => { setSaveError(null); setDirty(false); setReadNonce((n) => n + 1); }}>Reload</button> : null}</p> : null}
      {confirmDiscard ? <div className="lib-discard" role="alertdialog" aria-label="Discard unsaved changes?"><span>Discard unsaved changes?</span><button type="button" className="lib-btn" onClick={() => setConfirmDiscard(false)}>Keep editing</button><button type="button" className="lib-btn lib-btn-danger" onClick={onClose}>Discard</button></div> : null}
    </div>
  );
}
