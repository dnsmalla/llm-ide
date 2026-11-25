// Settings > Security: "Don't ask before Bypass". The host owns the pref; turning it on shows the host's native dialog
// (Cancel first), so a decline simply leaves it off. Turning it off asks nothing.
export const BYPASS_SKIP_TEXT = {
  label: "Don't ask before Bypass",
  hint: "Off by default. When on, choosing Bypass in a chat no longer shows the confirmation window: Bypass turns on without asking, in every chat, and tools then run without asking, including commands that change or delete files. Turning this on asks once, in a window of its own.",
} as const;

export interface BypassSkipHost {
  getBypassSkipConfirm?(): Promise<boolean>;
  setBypassSkipConfirm?(on: boolean): Promise<boolean>;
}

/** Host errors are `{code, message}` objects; show their message plainly. */
function hostMessage(e: unknown): string {
  const m = typeof e === "string" ? e : (e as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m.slice(0, 200) : "The host could not change this setting.";
}

/** Applies the switch and returns the value to show (what the host says is now stored, never what was asked for) and,
 *  when the host refused, its plain message (e.g. after too many declined dialogs). */
export async function applyBypassSkip(host: BypassSkipHost, on: boolean, current: boolean): Promise<{ value: boolean; error: string | null }> {
  if (!host.setBypassSkipConfirm) return { value: current, error: null };
  try {
    return { value: (await host.setBypassSkipConfirm(on)) === true, error: null };
  } catch (e) {
    const value = host.getBypassSkipConfirm ? await host.getBypassSkipConfirm().catch(() => current) : current;
    return { value, error: hostMessage(e) };
  }
}
