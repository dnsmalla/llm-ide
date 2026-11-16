// The SSH server folder picker, as the shell knows it. Screens far from the shell (a chat or graph card with no project)
// cannot receive a prop, so Shell registers its picker opener here. It is registered only in ssh mode: in local and hub
// mode no "Open server folder…" action is offered anywhere.

let handler: (() => void) | null = null;

export function setServerFolderHandler(next: (() => void) | null): void {
  handler = next;
}

export function serverFolderHandler(): (() => void) | null {
  return handler;
}

/** The opener Shell registers: the picker in ssh mode, nothing otherwise. */
export function serverFolderHandlerFor(ssh: boolean, openPicker: () => void): (() => void) | null {
  return ssh ? openPicker : null;
}
