// Groups the desktop cannot do yet: the real header and, when open, an honest card (see ../notices.ts).
// No control lives here by design.
import { PARTIAL_NOTES, type GroupNotice } from "../notices.ts";

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
