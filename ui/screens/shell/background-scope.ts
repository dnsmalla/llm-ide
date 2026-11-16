// Which project the desktop's background work (the Auto Tasks scheduler and the Loop run manager) may run for. Pure.

/**
 * The project root those loops may use, or null. Only ssh mode turns them off: there the project is a folder on the
 * server, and the loops' file access and revert guard are local. Local and hub mode keep them, because a hub can have a
 * project root (project_open is refused only in ssh mode). `mode` is undefined until the first status read, which keeps
 * them off until the mode is known.
 */
export function backgroundRoot(mode: string | undefined, projectRoot: string | null): string | null {
  if (mode === undefined || mode === "ssh") return null;
  return projectRoot;
}
