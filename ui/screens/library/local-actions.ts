// Library actions that open this computer's file manager. In ssh mode the Library's project files are on the server, so
// "Reveal in Finder" becomes "Copy server path" (see shell/server-path.ts); the actions that need this computer are left out.
import { projectRelativeOf, type LocationReveal } from "./extensions/legacy-labels.ts";
import { COPY_SERVER_PATH_LABEL, copyText, fileManagerActionFor } from "../shell/server-path.ts";

/** The Library's "Choose folder…" action, or null in ssh mode: the notes folder is on this computer. */
export function libraryChooseFor(ssh: boolean, choose: () => void): (() => void) | null {
  return ssh ? null : choose;
}

/** Export a note through the save panel, or undefined in ssh mode: the save panel and its file are this computer's. */
export function exportFileFor<T extends (name: string, text: string) => Promise<string | null>>(ssh: boolean, exportNote: T): T | undefined {
  return ssh ? undefined : exportNote;
}

/**
 * Reveal for the extension panes: only a location inside the open project. Outside ssh mode it reveals; in ssh mode it
 * copies the absolute server path.
 */
export function projectLocationReveal(
  ssh: boolean,
  rootOf: () => string | null,
  reveal: (relPath: string) => void,
  copy: (text: string) => void = copyText,
): LocationReveal {
  return {
    label: ssh ? COPY_SERVER_PATH_LABEL : undefined,
    canReveal: (location) => projectRelativeOf(location, rootOf()) !== null,
    reveal: (location) => {
      const root = rootOf();
      const rel = projectRelativeOf(location, root);
      if (rel === null) return;
      void fileManagerActionFor(ssh, root, (relPath) => Promise.resolve(reveal(relPath)), copy)?.run(rel);
    },
  };
}
