// The three modals of the Extensions screen: consent, update preview, confirm. They render the model's single
// `sheet` union; the buttons only call model actions (the model enforces the consent and binding rules).
import { useRef, useState, type ReactNode } from "react";
import type { UpdatePreview } from "./decoders.ts";
import type { ConfirmAction, ConsentRequest, ExtensionsModel } from "./model.ts";
import { flagText, repoName } from "./presentation.ts";
import { FILE_ROW_HEIGHT, fileWindow } from "./list-model.ts";
import { shortCommit } from "./sanitize.ts";
import { Badge, FindingList, Modal } from "./ui.tsx";
import { useScroller } from "../use-library.ts";

const Commit = ({ value }: { value: string }): ReactNode => (
  <code className="ext-commit" title={value}>
    {value}
  </code>
);

// ---- consent ------------------------------------------------------------------------------------
export function ConsentSheet({ model, request, ticked, canConfirm }: { model: ExtensionsModel; request: ConsentRequest; ticked: readonly string[]; canConfirm: boolean }): ReactNode {
  const enable = request.purpose === "enable";
  return (
    <Modal
      titleId="ext-consent-title"
      title={`Allow ${request.itemName} to run code?`}
      onClose={() => model.dismissSheet()}
      footer={
        <>
          <button type="button" className="lib-btn" onClick={() => model.dismissSheet()}>
            Cancel
          </button>
          <button type="button" className="lib-btn lib-btn-primary" disabled={!canConfirm} aria-disabled={!canConfirm} onClick={() => void model.confirmConsent()}>
            {enable ? "Allow and switch on" : "Allow and update"}
          </button>
        </>
      }
    >
      <p>
        {enable ? "Switching this item on lets the kinds of code below run on your machine." : "The new version declares the kinds of code below. Without your consent it is switched off after the update."} Tick each one to continue. Your consent covers only this commit.
      </p>
      <p className="ext-commit-line">
        Commit <Commit value={request.commit} />
      </p>
      <ul className="ext-consent-list" aria-label="Kinds of code that would run">
        {request.lines.map((l) => {
          const id = `ext-consent-${l.kind}`;
          return (
            <li key={l.kind} className="ext-consent-line">
              <input id={id} type="checkbox" checked={ticked.includes(l.kind)} onChange={(e) => model.tick(l.kind, e.target.checked)} />
              <label htmlFor={id}>
                <strong>{l.title}</strong>
                <span className="lib-muted ext-block">{l.detail}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {!canConfirm && <p className="lib-muted">The button stays off until every kind is ticked.</p>}
    </Modal>
  );
}

// ---- confirm ------------------------------------------------------------------------------------
function confirmCopy(a: ConfirmAction): { title: string; body: ReactNode; button: string; danger: boolean } {
  switch (a.kind) {
    case "uninstall":
      return {
        title: `Remove ${a.itemName}?`,
        body: (
          <>
            <p>
              This removes <strong>{a.itemName}</strong> at commit <Commit value={a.commit} />, its switches and every stored version of it. You can install it again later.
            </p>
          </>
        ),
        button: "Remove",
        danger: true,
      };
    case "rollback":
      return {
        title: `Roll back ${a.itemName}?`,
        body: (
          <p>
            <strong>{a.itemName}</strong> goes back to commit <Commit value={a.toCommit} />. The version you roll away from is kept, so you can roll forward again. If the earlier version can run code, the item stays on only when its consent covers that commit.
          </p>
        ),
        button: "Roll back",
        danger: true,
      };
    case "repair":
      return {
        title: `Repair ${a.itemName}?`,
        body: (
          <p>
            Re-downloads the files of <strong>{a.itemName}</strong> at the pinned commit <Commit value={a.commit} /> when they are missing or damaged. It never fetches a newer version, and it refuses if the files differ from the recorded fingerprint. This contacts GitHub.
          </p>
        ),
        button: "Repair",
        danger: true,
      };
    case "install": {
      const e = a.entry;
      return {
        title: `Install ${e.name}?`,
        body: (
          <p>
            Adds <strong>{e.name}</strong> from <strong>{e.sourceUrl ? repoName(e.sourceUrl) : "its repository"}</strong>
            {e.sourcePath ? <> (folder {e.sourcePath})</> : null} at the commit it has today. It starts switched off and nothing runs at install. This contacts GitHub.
          </p>
        ),
        button: "Install",
        danger: false,
      };
    }
  }
}

export function ConfirmSheet({ model, action }: { model: ExtensionsModel; action: ConfirmAction }): ReactNode {
  const c = confirmCopy(action);
  return (
    <Modal
      titleId="ext-confirm-title"
      title={c.title}
      onClose={() => model.dismissSheet()}
      footer={
        <>
          <button type="button" className="lib-btn" onClick={() => model.dismissSheet()}>
            Cancel
          </button>
          <button type="button" className="lib-btn" data-danger={c.danger} onClick={() => void model.confirmAction()}>
            {c.button}
          </button>
        </>
      }
    >
      {c.body}
    </Modal>
  );
}

// ---- preview ------------------------------------------------------------------------------------
interface FileRow {
  path: string;
  note: string;
}

/** The windowed rows of one open group. Mounted only while the group is open, so a closed group costs nothing. */
function FileList({ id, label, rows, count, initialHeight }: { id: string; label: string; rows: FileRow[]; count: number; initialHeight?: number }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollTop, height } = useScroller(ref, initialHeight ?? 220);
  const w = fileWindow(rows.length, scrollTop, height);
  return (
    <div id={id} ref={ref} className="ext-filelist" role="list" aria-label={`${label} files`} tabIndex={0}>
      <div style={{ height: w.padTop }} aria-hidden="true" />
      {rows.slice(w.start, w.end).map((r, i) => (
        <div key={w.start + i} role="listitem" className="ext-filerow" style={{ height: FILE_ROW_HEIGHT }} aria-posinset={w.start + i + 1} aria-setsize={rows.length}>
          <span className="ext-filepath">{r.path}</span>
          <span className="lib-muted">{r.note}</span>
        </div>
      ))}
      <div style={{ height: w.padBottom }} aria-hidden="true" />
      {count > rows.length && <p className="lib-muted">Only the first {rows.length} are listed.</p>}
    </div>
  );
}

function FileGroup({ label, rows, count, initialHeight, initiallyOpen = false }: { label: string; rows: FileRow[]; count: number; initialHeight?: number; initiallyOpen?: boolean }): ReactNode {
  const [open, setOpen] = useState(initiallyOpen);
  if (count === 0) return null;
  const id = `ext-files-${label.toLowerCase()}`;
  return (
    <div className="ext-filegroup">
      <button type="button" className="lib-link-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {label.toLowerCase()} ({count.toLocaleString()})
      </button>
      {open && <FileList id={id} label={label} rows={rows} count={count} initialHeight={initialHeight} />}
    </div>
  );
}

const bytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function PreviewBody({ preview, initialHeight, openGroups = false }: { preview: UpdatePreview; initialHeight?: number; openGroups?: boolean }): ReactNode {
  const f = preview.files;
  const added = f.added.map((x) => ({ path: x.path, note: bytes(x.size ?? 0) }));
  const removed = f.removed.map((x) => ({ path: x.path, note: bytes(x.size ?? 0) }));
  const changed = f.changed.map((x) => ({ path: x.path, note: `${bytes(x.before ?? 0)} to ${bytes(x.after ?? 0)}` }));
  const newKinds = preview.newKinds;
  return (
    <>
      {preview.flags.length > 0 && (
        <ul className="ext-flags" aria-label="What to look at">
          {preview.flags.map((fl) => (
            <li key={fl}>
              <Badge tone="warn">{flagText(fl)}</Badge>
            </li>
          ))}
        </ul>
      )}
      <p>
        Version {preview.versionFrom ?? "unknown"} to {preview.versionTo ?? "unknown"}. Commit <Commit value={preview.from} /> to <Commit value={preview.to} />.
      </p>
      {newKinds.length > 0 && (
        <div className="ext-new-code">
          <h3>New code that can run</h3>
          <p>
            Kinds: <strong>{newKinds.join(", ")}</strong>.
          </p>
          {preview.newMembers.length > 0 && (
            <ul>
              {preview.newMembers.slice(0, 30).map((m) => (
                <li key={m.memberId}>
                  {m.type}: {m.name}
                </li>
              ))}
              {preview.newMembers.length > 30 && <li>and {preview.newMembers.length - 30} more</li>}
            </ul>
          )}
        </div>
      )}
      {preview.wasEnabled && (
        <p className="lib-muted">{preview.staysEnabledWithoutConsent ? "It is on now and stays on after the update." : "It is on now. It is switched off after the update unless you consent to the code it declares."}</p>
      )}
      <h3>Files</h3>
      <p className="lib-muted">
        {f.counts.added.toLocaleString()} added, {f.counts.removed.toLocaleString()} removed, {f.counts.changed.toLocaleString()} changed.
        {f.truncated ? " The lists below are cut short; the counts are complete." : ""}
      </p>
      <FileGroup label="Added" rows={added} count={f.counts.added} initialHeight={initialHeight} initiallyOpen={openGroups} />
      <FileGroup label="Removed" rows={removed} count={f.counts.removed} initialHeight={initialHeight} initiallyOpen={openGroups} />
      <FileGroup label="Changed" rows={changed} count={f.counts.changed} initialHeight={initialHeight} initiallyOpen={openGroups} />
      <h3>Scan</h3>
      <p className="lib-muted">
        Warnings before: {preview.scan.beforeCount}. After: {preview.scan.afterCount}. Resolved: {preview.scan.resolvedCount}. New: {preview.scan.newFindings.length}.
      </p>
      {preview.scan.newFindings.length > 0 && <FindingList findings={preview.scan.newFindings} />}
    </>
  );
}

export function PreviewSheet({ model, itemName, preview, initialHeight }: { model: ExtensionsModel; itemName: string; preview: UpdatePreview; initialHeight?: number }): ReactNode {
  const needsConsent = preview.consent.required && preview.consent.kinds.length > 0;
  return (
    <Modal
      wide
      titleId="ext-preview-title"
      title={`Review update: ${itemName}`}
      onClose={() => model.dismissSheet()}
      footer={
        <>
          <button type="button" className="lib-btn" onClick={() => model.dismissSheet()}>
            Cancel
          </button>
          <button type="button" className="lib-btn lib-btn-primary" onClick={() => void model.applyPreview()}>
            {needsConsent ? "Continue to consent" : `Update to ${shortCommit(preview.to)}`}
          </button>
        </>
      }
    >
      <PreviewBody preview={preview} initialHeight={initialHeight} />
    </Modal>
  );
}
