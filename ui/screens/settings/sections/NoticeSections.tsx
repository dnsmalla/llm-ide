import { PARTIAL_NOTES } from "../notices.ts";

/** A short note under a group whose Mac counterpart is only partly implemented. */
export function PartialNote({ id }: { id: string }) {
  const text = PARTIAL_NOTES[id];
  return text ? <p className="st-hint" data-partial-note={id}>{text}</p> : null;
}
