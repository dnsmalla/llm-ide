// Installed tab: the virtualised, grouped list and the selected item's detail pane.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { InstalledItem } from "./decoders.ts";
import { ITEM_ROW_HEIGHT, flattenGroups, offsetsOf, rowIndexOf, stepItem, visibleRows } from "./list-model.ts";
import type { ExtensionsModel, ExtensionsState } from "./model.ts";
import { consentTitle, hasUpdate, hasWarnings, kindLabel, repoName, runsCode, trustLabel } from "./presentation.ts";
import { shortCommit } from "./sanitize.ts";
import { Badge, FindingList } from "./ui.tsx";
import { useScroller } from "../use-library.ts";

export function ItemBadges({ item }: { item: InstalledItem }): ReactNode {
  return (
    <span className="ext-badges">
      <Badge tone={item.enabled ? "ok" : "neutral"}>{item.enabled ? "On" : "Off"}</Badge>
      <Badge tone={item.trust === "official" ? "accent" : "neutral"} title="Where the publisher is on the trust list; it is not a safety verdict">
        {trustLabel(item.trust)}
      </Badge>
      {runsCode(item) && (
        <Badge tone="warn" title={`Can run code: ${item.executableKinds.join(", ")}`}>
          Runs code
        </Badge>
      )}
      {hasWarnings(item) && <Badge tone="warn">{item.scan.count} scan {item.scan.count === 1 ? "warning" : "warnings"}</Badge>}
      {hasUpdate(item) && <Badge tone="accent">Update available</Badge>}
    </span>
  );
}

function Row({ item, selected, top }: { item: InstalledItem; selected: boolean; top: number }): ReactNode {
  return (
    <div
      id={`ext-row-${item.id}`}
      role="option"
      aria-selected={selected}
      className="ext-row"
      data-selected={selected}
      style={{ top, height: ITEM_ROW_HEIGHT }}
      onMouseDown={(e) => e.preventDefault()}
      data-item-id={item.id}
    >
      <span className="ext-row-name">{item.name}</span>
      <span className="ext-row-meta">
        {kindLabel(item.kind)} · {repoName(item.sourceUrl)} · {shortCommit(item.pinnedCommit)}
      </span>
      <ItemBadges item={item} />
    </div>
  );
}

export function InstalledList({ model, state, initialHeight }: { model: ExtensionsModel; state: ExtensionsState; initialHeight?: number }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollTop, height } = useScroller(ref, initialHeight ?? 560);
  const rows = useMemo(() => flattenGroups(state.items), [state.items]);
  const offsets = useMemo(() => offsetsOf(rows), [rows]);
  const w = visibleRows(offsets, scrollTop, height);
  const selected = state.selectedId;

  // Keep a keyboard selection in view.
  useEffect(() => {
    const el = ref.current;
    const i = rowIndexOf(rows, selected);
    if (!el || i < 0) return;
    const top = offsets[i]!;
    const bottom = offsets[i + 1]!;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [selected, rows, offsets]);

  const onKey = (e: KeyboardEvent): void => {
    const map: Record<string, 1 | -1 | "first" | "last"> = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" };
    const step = map[e.key];
    if (step === undefined) return;
    e.preventDefault();
    model.select(stepItem(rows, selected, step));
  };
  const onClick = (e: React.MouseEvent): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-item-id]");
    if (row?.dataset.itemId) model.select(row.dataset.itemId);
  };

  return (
    <div
      ref={ref}
      className="lib-scroll ext-list"
      role="listbox"
      aria-label="Installed extensions"
      aria-activedescendant={selected ? `ext-row-${selected}` : undefined}
      tabIndex={0}
      onKeyDown={onKey}
      onClick={onClick}
    >
      <div style={{ height: w.total, position: "relative" }}>
        {rows.slice(w.start, w.end).map((r, i) => {
          const idx = w.start + i;
          if (r.kind === "header") {
            return (
              <div key={`h-${r.label}`} role="presentation" className="ext-group" style={{ top: offsets[idx], height: offsets[idx + 1]! - offsets[idx]! }}>
                {r.label} <span className="lib-count">{r.count.toLocaleString()}</span>
              </div>
            );
          }
          return <Row key={r.item.id} item={r.item} selected={r.item.id === selected} top={offsets[idx]!} />;
        })}
      </div>
    </div>
  );
}

const MEMBER_PAGE = 100;

export function ItemDetail({ model, item, busy }: { model: ExtensionsModel; item: InstalledItem; busy: boolean }): ReactNode {
  const [allMembers, setAllMembers] = useState(false);
  const members = allMembers ? item.members : item.members.slice(0, MEMBER_PAGE);
  const switchId = `ext-switch-${item.id}`;
  const updateAvail = hasUpdate(item);
  return (
    <section className="ext-detail" aria-label={`${item.name} details`} aria-busy={busy}>
      <header className="ext-detail-head">
        <h2>{item.name}</h2>
        <p className="lib-muted">
          {kindLabel(item.kind)}
          {item.version ? ` · version ${item.version}` : ""} · {item.publisherId}
        </p>
        <ItemBadges item={item} />
      </header>
      {item.description && <p>{item.description}</p>}
      <div className="ext-switch-row">
        <input
          id={switchId}
          type="checkbox"
          role="switch"
          aria-checked={item.enabled}
          checked={item.enabled}
          disabled={busy}
          onChange={(e) => void (e.target.checked ? model.requestEnable(item) : model.disable(item))}
        />
        <label htmlFor={switchId}>{item.enabled ? "Enabled" : "Disabled"}</label>
        {runsCode(item) && !item.enabled && <span className="lib-muted">Switching on asks for your consent first.</span>}
      </div>

      <dl className="ext-facts">
        <dt>Source</dt>
        <dd>
          {repoName(item.sourceUrl)}
          {item.subpath ? ` (folder ${item.subpath})` : ""}
          {item.ref ? ` · ref ${item.ref}` : ""}
        </dd>
        <dt>Pinned commit</dt>
        <dd>
          <code className="ext-commit">{item.pinnedCommit}</code>
        </dd>
        <dt>Installed</dt>
        <dd>
          {item.installedAt}
          {item.updatedAt ? ` · updated ${item.updatedAt}` : ""}
        </dd>
      </dl>

      {updateAvail && item.update && (
        <p className="ext-update-line">
          Update available: <code>{shortCommit(item.pinnedCommit)}</code> to <code>{shortCommit(item.update.latest)}</code> <span className="lib-muted">(checked {item.update.checkedAt})</span>
        </p>
      )}

      {runsCode(item) && (
        <div className="ext-runs-code">
          <h3>Can run code</h3>
          <p>
            {item.executableKinds.map((k) => consentTitle(k)).join(", ")}. It only runs while the item is on and consented, at the commit shown above.
          </p>
        </div>
      )}

      {item.permissions.length > 0 && (
        <>
          <h3>What it adds</h3>
          <ul className="ext-perms">
            {item.permissions.map((p, i) => (
              <li key={i}>
                {p.executable && <Badge tone="warn">code</Badge>} {p.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {item.members.length > 0 && (
        <>
          <h3>Members ({item.members.length.toLocaleString()})</h3>
          <ul className="ext-members" aria-label="Members">
            {members.map((m) => {
              const id = `ext-member-${item.id}-${m.memberId}`;
              const on = !item.disabledMembers.includes(m.memberId);
              return (
                <li key={m.memberId}>
                  <input id={id} type="checkbox" checked={on} disabled={busy} onChange={(e) => void model.setMember(item, m.memberId, e.target.checked)} />
                  <label htmlFor={id}>
                    {m.name} <span className="lib-muted">{m.type}</span> {m.executable && <Badge tone="warn">runs code</Badge>}
                  </label>
                </li>
              );
            })}
          </ul>
          {item.members.length > MEMBER_PAGE && !allMembers && (
            <button type="button" className="lib-link-btn" onClick={() => setAllMembers(true)}>
              Show all {item.members.length.toLocaleString()} members
            </button>
          )}
        </>
      )}

      {hasWarnings(item) && (
        <details className="ext-scan">
          <summary>
            Scan warnings ({item.scan.count})
          </summary>
          <FindingList findings={item.scan.findings} total={item.scan.count} />
        </details>
      )}

      <div className="ext-actions" role="group" aria-label="Actions">
        <button type="button" className="lib-btn" disabled={busy || model.getSnapshot().checking} onClick={() => void model.checkUpdates(item.id)}>
          Check for update
        </button>
        {updateAvail && (
          <button type="button" className="lib-btn lib-btn-primary" disabled={busy} onClick={() => void model.openPreview(item)}>
            Review update
          </button>
        )}
        {item.previous && (
          <button type="button" className="lib-btn" disabled={busy} onClick={() => model.requestRollback(item)}>
            Roll back to {shortCommit(item.previous.pinnedCommit)}
          </button>
        )}
        <button type="button" className="lib-btn" disabled={busy} onClick={() => model.requestRepair(item)}>
          Repair
        </button>
        <button type="button" className="lib-btn" data-danger="true" disabled={busy} onClick={() => model.requestUninstall(item)}>
          Remove
        </button>
      </div>
    </section>
  );
}

export function InstalledTab({ model, state, initialHeight }: { model: ExtensionsModel; state: ExtensionsState; initialHeight?: number }): ReactNode {
  const selected = state.selectedId ? state.items.find((i) => i.id === state.selectedId) : undefined;
  if (state.loadError && !state.loaded) {
    return (
      <div className="lib-empty" role="alert">
        <p className="lib-empty-title">Could not read the installed extensions</p>
        <p className="lib-muted">{state.loadError}</p>
        <button type="button" className="lib-btn" onClick={() => void model.loadInstalled()}>
          Try again
        </button>
      </div>
    );
  }
  if (!state.loaded) {
    return (
      <p className="lib-empty" role="status">
        Loading installed extensions…
      </p>
    );
  }
  if (state.items.length === 0) {
    return (
      <div className="lib-empty" role="status">
        <p className="lib-empty-title">Nothing installed yet</p>
        <p className="lib-muted">Use Browse to pick from the catalog, or Install to add a GitHub repository. Installs start switched off.</p>
      </div>
    );
  }
  return (
    <div className="ext-split">
      <div className="ext-split-list">
        <InstalledList model={model} state={state} initialHeight={initialHeight} />
      </div>
      <div className="ext-split-detail">
        {selected ? (
          <ItemDetail key={selected.id} model={model} item={selected} busy={state.busy.includes(selected.id)} />
        ) : (
          <div className="lib-empty" role="status">
            <p className="lib-empty-title">Select an item</p>
            <p className="lib-muted">Use the arrow keys in the list, or click an item.</p>
          </div>
        )}
      </div>
    </div>
  );
}
