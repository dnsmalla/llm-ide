// The hub project chosen in remote mode. One module-level value keeps ChatScreen and the project bar
// in step without adding another React context; it is not persisted here (the bar stores it per hub).
let selected: string | null = null;
const listeners = new Set<() => void>();
export const remoteProjectId = (): string | null => selected;
export function setRemoteProjectId(id: string | null): void {
  if (selected === id) return;
  selected = id;
  for (const l of [...listeners]) l();
}
export function subscribeRemoteProject(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l); }
