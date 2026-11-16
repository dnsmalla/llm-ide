// The SSH server folder picker, as the shell knows it. Screens far from the shell (a chat or graph card with no project)
// cannot receive a prop, so Shell registers its `onOpenServerFolder` here. Unset until the picker ships: then no
// "Open server folder…" action is offered anywhere.

let handler: (() => void) | null = null;

export function setServerFolderHandler(next: (() => void) | null): void {
  handler = next;
}

export function serverFolderHandler(): (() => void) | null {
  return handler;
}
