// Library actions that open this computer's file manager. In ssh mode the Library's project files are on the server, so
// these are not offered: the reveal command is refused there and would only fail.
import { projectRelativeOf, type LocationReveal } from "./extensions/legacy-labels.ts";

/** The Library's "Reveal in Finder" for a project-relative path, or undefined when the menu item must be left out. */
export function fileManagerRevealFor(ssh: boolean, reveal: (relPath: string) => Promise<unknown>): ((relPath: string) => Promise<void>) | undefined {
  if (ssh) return undefined;
  return async (relPath) => {
    await reveal(relPath);
  };
}

/** Reveal for the extension panes: only a location inside the open project, and never in ssh mode. */
export function projectLocationReveal(ssh: boolean, rootOf: () => string | null, reveal: (relPath: string) => void): LocationReveal {
  return {
    canReveal: (location) => !ssh && projectRelativeOf(location, rootOf()) !== null,
    reveal: (location) => {
      if (ssh) return;
      const rel = projectRelativeOf(location, rootOf());
      if (rel !== null) reveal(rel);
    },
  };
}
