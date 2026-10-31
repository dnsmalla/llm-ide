// Groups the desktop cannot do yet: the real header and, when open, an honest card (see ../notices.ts).
// No control lives here by design.
import type { ComponentType } from "react";
import { NOTICES, PARTIAL_NOTES, type GroupNotice } from "../notices.ts";

export function ManagedNotice({ notice }: { notice: GroupNotice }) {
  return (
    <div className="st-note" role="group" aria-label="Status on the desktop">
      <p className="st-label">{notice.status === "Planned" ? "Status: planned" : "Managed in the Mac app"}</p>
      <p>{notice.mac}</p>
      <p className="st-hint">Meanwhile: {notice.meanwhile}</p>
    </div>
  );
}

/** A short note under a group whose Mac counterpart is only partly implemented. */
export function PartialNote({ id }: { id: string }) {
  const text = PARTIAL_NOTES[id];
  return text ? <p className="st-hint" data-partial-note={id}>{text}</p> : null;
}

const make = (id: string): ComponentType => {
  const n = NOTICES[id];
  if (!n) throw new Error(`no notice for settings group "${id}"`);
  return function NoticeGroup() {
    return <ManagedNotice notice={n} />;
  };
};

export const BuildGroup = make("build");
export const MobileGroup = make("mobile");
export const TokenSavingGroup = make("token-saving");
export const LoopDefaultsGroup = make("loop-defaults");
export const DocGenGroup = make("doc-gen");
export const OptionalComponentsGroup = make("optional-components");
export const SelfHealGroup = make("self-heal");
export const ConnectionsGroup = make("connections");
export const PathsGroup = make("paths");
export const RepositoriesGroup = make("repositories");
export const MemoryGroup = make("memory");
export const CodeGraphGroup = make("code-graph");
