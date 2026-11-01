// Per-machine shell-command approvals for Loop stages. The Mac's VerifyApprovalStore is per machine; this is the
// desktop equivalent for shell stages: a command must be approved once for a project before a run can execute it.
// Approvals are UI state only; the host still resolves the command from the committed loop.json, never from the page.
const KEY = "llmide.loopApprovals.v1";

function read(storage: Storage | undefined = globalThis.localStorage): string[] {
  try {
    const raw = storage?.getItem(KEY);
    const v = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-500) : [];
  } catch { return []; }
}

function key(root: string, command: string): string {
  return `${root.replace(/\/+$/, "")}\u0000${command.trim()}`;
}

export function isApproved(root: string, command: string, storage: Storage | undefined = globalThis.localStorage): boolean {
  return read(storage).includes(key(root, command));
}

export function approve(root: string, command: string, storage: Storage | undefined = globalThis.localStorage): void {
  const list = read(storage);
  const k = key(root, command);
  if (!list.includes(k)) list.push(k);
  try { storage?.setItem(KEY, JSON.stringify(list.slice(-500))); } catch { /* session only */ }
}

export function revokeAll(storage: Storage | undefined = globalThis.localStorage): void {
  try { storage?.removeItem(KEY); } catch { /* session only */ }
}
