// Library > Project files: the Mac's Code and Data categories as lazy file trees with a read-only viewer. The note
// sections stay the notes index; these two come from the project folders through the host's read-only fs commands.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { shellBus } from "../shell/bus";
import { PROJECT_ROOTS, decodeProjectEntries, decodeProjectFile, type ProjectEntry } from "./project-files.ts";

export interface ProjectFilesDeps {
  list: (path: string) => Promise<unknown>;
  read: (path: string) => Promise<unknown>;
}

export function ProjectFilesNav({ deps, selected, onSelect, active = true }: { deps: ProjectFilesDeps; selected: string | null; onSelect: (path: string | null) => void; active?: boolean }): ReactNode {
  const [roots, setRoots] = useState<Record<string, ProjectEntry[] | "error" | undefined>>({});
  const [children, setChildren] = useState<Map<string, ProjectEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [closedRoots, setClosedRoots] = useState<Set<string>>(new Set());

  const loadRoot = useCallback(async (path: string) => {
    try {
      const entries = decodeProjectEntries(await deps.list(path));
      setRoots((r) => ({ ...r, [path]: entries }));
    } catch {
      setRoots((r) => ({ ...r, [path]: "error" }));
    }
  }, [deps]);

  const reload = useCallback(() => {
    setChildren(new Map());
    setClosedRoots(new Set());
    void loadRoot("code");
    void loadRoot("data");
  }, [loadRoot]);

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

  return (
    <section className="lib-project" aria-label="Project files">
      {PROJECT_ROOTS.map((root) => {
        const entries = roots[root.path];
        const open = !closedRoots.has(root.path);
        return (
          <div key={root.path} className="lib-project-root">
            <button type="button" className="lib-project-head" aria-expanded={open} onClick={() => setClosedRoots((s) => {
              const n = new Set(s);
              if (n.has(root.path)) n.delete(root.path); else n.add(root.path);
              return n;
            })}>
              <span className="lib-project-caret">{open ? "▾" : "▸"}</span> {root.label}
            </button>
            {open ? (
              entries === undefined ? <p className="lib-muted lib-project-note">Loading…</p>
                : entries === "error" ? <p className="lib-muted lib-project-note">{root.path}/ is missing.</p>
                : entries.length === 0 ? <p className="lib-muted lib-project-note">No files in {root.path}/.</p>
                : (
                  <ul className="lib-project-list">
                    {entries.map((e) => (
                      <ProjectRow key={e.path} entry={e} depth={0} childrenOf={(p) => children.get(p) ?? []} expanded={expanded} onToggle={toggle} onSelect={onSelect} selected={selected} />
                    ))}
                  </ul>
                )
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function ProjectRow({ entry, depth, childrenOf, expanded, onToggle, onSelect, selected }: {
  entry: ProjectEntry;
  depth: number;
  childrenOf: (path: string) => ProjectEntry[];
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selected: string | null;
}): ReactNode {
  const dir = entry.kind === "dir";
  const open = expanded.has(entry.path);
  return (
    <li className="lib-project-row" style={{ paddingLeft: depth * 12 }} role="treeitem" aria-expanded={dir ? open : undefined} aria-selected={!dir && selected === entry.path}>
      <button type="button" className={dir ? "lib-project-dir" : "lib-project-file"} data-on={!dir && selected === entry.path || undefined} onClick={() => (dir ? onToggle(entry.path) : onSelect(entry.path))}>
        <span className="lib-project-caret" aria-hidden="true">{dir ? (open ? "▾" : "▸") : "·"}</span>{entry.name}
      </button>
      {dir && open ? (
        <ul className="lib-project-list">
          {childrenOf(entry.path).map((c) => (
            <ProjectRow key={c.path} entry={c} depth={depth + 1} childrenOf={childrenOf} expanded={expanded} onToggle={onToggle} onSelect={onSelect} selected={selected} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ProjectFileView({ path, deps }: { path: string; deps: ProjectFilesDeps }): ReactNode {
  const [body, setBody] = useState<ReturnType<typeof decodeProjectFile> | "error" | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setBody(undefined);
    deps.read(path).then(
      (r) => live && setBody(decodeProjectFile(r)),
      () => live && setBody("error"),
    );
    return () => { live = false; };
  }, [deps, path]);
  const name = path.split("/").pop() ?? path;
  return (
    <div className="lib-project-view" aria-label={`${name} preview`}>
      <div className="lib-project-view-head">
        <strong>{name}</strong>
        <span className="lib-muted">{path}</span>
        <span className="lib-project-spacer" />
        <button type="button" className="lib-btn" onClick={() => shellBus.publish({ type: "open-file", path })}>Open in Explorer</button>
      </div>
      {body === undefined ? <p className="lib-muted" role="status">Reading…</p>
        : body === "error" ? <p className="lib-muted">The file could not be read.</p>
        : body === null ? <p className="lib-muted">This file is binary or too large to preview here. Open it in Explorer.</p>
        : <pre className="lib-project-text">{body.text}</pre>}
    </div>
  );
}
