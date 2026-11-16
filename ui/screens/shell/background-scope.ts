// Which project the desktop's background work (the Auto Tasks scheduler and the Loop run manager) may run for. Pure.

/**
 * The project root those loops may use, or null. Only the local mode qualifies: in ssh mode the project is a folder on
 * the server, and the loops' own file access (and their revert guard) is local. `mode` is the core's mode, undefined
 * until the first status read, which keeps them off until the mode is known.
 */
export function localBackgroundRoot(mode: string | undefined, projectRoot: string | null): string | null {
  return mode === "local" ? projectRoot : null;
}
