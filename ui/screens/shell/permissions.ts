// Plan H1.2: the action classes the core says the caller may use (GET /auth/me member.permissions).
// Courtesy only — the core enforces every class; this hides what it would refuse. null = unknown
// (an older core): hide nothing.
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function permissionsFromMe(body: unknown): ReadonlySet<string> | null {
  if (!isRec(body) || !isRec(body.member) || !Array.isArray(body.member.permissions)) return null;
  return new Set(body.member.permissions.filter((p): p is string => typeof p === "string"));
}

export function chatBlockReason(perms: ReadonlySet<string> | null): string | null {
  return perms && !perms.has("model.ask") && !perms.has("model.read") ? "Your team role cannot run chat. Ask a team admin for access." : null;
}

/** Engineers (model.exec) get every mode; a read-only member loses Execute; a viewer only Asks. */
export function allowedModes<T extends { id: string }>(perms: ReadonlySet<string> | null, modes: readonly T[]): readonly T[] {
  if (!perms || perms.has("model.exec")) return modes;
  if (perms.has("model.read")) return modes.filter((m) => m.id !== "execute");
  return modes.filter((m) => m.id === "ask");
}
