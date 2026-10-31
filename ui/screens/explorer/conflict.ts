// Dirty / external-change / save-conflict logic for one open document. Pure.
//
// The disk is the only copy of the content; the editor buffer is a view. `diskHash` is the hash
// of the bytes this buffer was last loaded from or saved to. The host compares that hash on every
// save (optimistic concurrency), so an external edit is never overwritten without the user choosing
// "keep mine".

export type External = "none" | "changed" | "deleted";

export interface DocState {
  path: string;
  /** Hash of the bytes last read from / written to disk; null for a read-only or never-saved doc. */
  diskHash: string | null;
  /** Buffer differs from what was last saved (Monaco alternative version id based). */
  dirty: boolean;
  external: External;
  saving: boolean;
  /** Last error to show, from a failed save. */
  saveError: string | null;
}

export function newDoc(path: string, diskHash: string | null): DocState {
  return { path, diskHash, dirty: false, external: "none", saving: false, saveError: null };
}

export interface DiskProbe {
  exists: boolean;
  /** Hash of the file as it is now (when it exists). */
  hash?: string | null;
}

export type DiskAction =
  | { type: "none" }
  /** Buffer is clean: silently replace it with the new disk content. */
  | { type: "reload" }
  /** Buffer is dirty: ask (reload / keep mine). */
  | { type: "banner"; kind: "changed" | "deleted" };

/** Decide what a change notification means for this document. */
export function onDiskProbe(doc: DocState, probe: DiskProbe): { doc: DocState; action: DiskAction } {
  if (!probe.exists) {
    // A deleted clean file just closes in the UI; a dirty one keeps the buffer so work is not lost.
    return { doc: { ...doc, external: "deleted" }, action: { type: "banner", kind: "deleted" } };
  }
  if (probe.hash === doc.diskHash) {
    // Touched or rewritten with identical bytes (including our own save echoing back): nothing to do.
    return { doc: doc.external === "none" ? doc : { ...doc, external: "none" }, action: { type: "none" } };
  }
  if (!doc.dirty) return { doc: { ...doc, external: "none" }, action: { type: "reload" } };
  return { doc: { ...doc, external: "changed" }, action: { type: "banner", kind: "changed" } };
}

export function beginSave(doc: DocState): DocState {
  return { ...doc, saving: true, saveError: null };
}

export function saveSucceeded(doc: DocState, newHash: string): DocState {
  return { ...doc, diskHash: newHash, dirty: false, external: "none", saving: false, saveError: null };
}

/** The host answered a save with an error code. `conflict` / `exists` mean the disk moved on. */
export function saveFailed(doc: DocState, code: string, message: string): DocState {
  if (code === "conflict" || code === "exists") return { ...doc, saving: false, external: "changed", saveError: null };
  if (code === "not_found") return { ...doc, saving: false, external: "deleted", saveError: null };
  return { ...doc, saving: false, saveError: message };
}

/** The user picked "reload" in the banner (after the new content was loaded). */
export function reloaded(doc: DocState, newHash: string | null): DocState {
  return { ...doc, diskHash: newHash, dirty: false, external: "none", saveError: null };
}

/** "Keep mine": the next save overwrites with `force`, adopting the disk's current hash. */
export function keepMine(doc: DocState, currentDiskHash: string | null): DocState {
  return { ...doc, diskHash: currentDiskHash, external: "none" };
}

export function canSave(doc: DocState, readOnly: boolean): boolean {
  return !readOnly && doc.dirty && !doc.saving && doc.external !== "deleted";
}
