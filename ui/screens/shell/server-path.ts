// SSH server mode: the project lives on the server, so "Reveal in Finder" (this computer's file manager cannot open a
// server file) becomes "Copy server path", which copies the absolute path on the server. One rule for every reveal button.

export const REVEAL_LABEL = "Reveal in Finder";
export const COPY_SERVER_PATH_LABEL = "Copy server path";

/**
 * The absolute server path of a project-relative path: the open root joined with '/'. An empty relative path is the
 * root itself. Pure string work: the host re-checks every path it is asked about, this only builds the text to copy.
 */
export function serverPathOf(root: string, relPath: string): string {
  const base = root.replace(/\/+$/, "");
  const rel = relPath.replace(/^\/+/, "");
  if (rel) return `${base}/${rel}`;
  return base || "/";
}

/** Puts text on the clipboard. A refused or missing clipboard is not an error worth showing: the copy just does not happen. */
export function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  } catch {
    /* clipboard unavailable */
  }
}

/** The file-manager button for a project-relative path: its label and what it does. */
export interface FileManagerAction {
  label: string;
  run(relPath: string): Promise<void>;
}

/**
 * The file-manager action for a project-relative path. On this computer it reveals the file through `reveal`. In ssh
 * mode it copies the absolute server path built from `root`, the open project's root. Undefined when the action cannot
 * be offered: no reveal here, or no open root in ssh mode.
 */
export function fileManagerActionFor(
  ssh: boolean,
  root: string | null,
  reveal: ((relPath: string) => Promise<unknown>) | undefined,
  copy: (text: string) => void = copyText,
): FileManagerAction | undefined {
  if (ssh) {
    if (!root) return undefined;
    return {
      label: COPY_SERVER_PATH_LABEL,
      run: async (relPath) => {
        copy(serverPathOf(root, relPath));
      },
    };
  }
  if (!reveal) return undefined;
  return {
    label: REVEAL_LABEL,
    run: async (relPath) => {
      await reveal(relPath);
    },
  };
}
