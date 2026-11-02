// "Sign out and disconnect all accounts" (Mac HeaderAccountMenu.swift:58-63). The Mac wipes its Keychain (GitHub and
// GitLab tokens, and the session) and its saved repositories. Here the tokens are vault keys, so the set is exactly
// the two git tokens; provider keys, Slack, Box, email and Google connections are left alone, as on the Mac.
import { decodeSecretNames } from "../settings/decoders.ts";
import { clearSavedRepos, readRepoConfig } from "../settings/repo-config.ts";

/** The vault names this removes, in order. Both are in the core allowlist (extension/server/vault.mjs). */
export const DISCONNECT_KEYS = [
  { key: "github.token", label: "GitHub token" },
  { key: "gitlab.token", label: "GitLab token" },
] as const;

export interface DisconnectItem {
  key: string;
  label: string;
}

export interface DisconnectPlan {
  /** Only the tokens that are saved right now. */
  keys: DisconnectItem[];
  savedRepos: number;
}

export interface DisconnectFailure {
  key: string;
  label: string;
  code: string;
}

export interface DisconnectOutcome {
  removed: string[];
  failed: DisconnectFailure[];
  reposCleared: boolean;
  signedOut: boolean;
  /** The session ended partway (the shell client drops it on a 401): the rest were not tried and are still saved. */
  sessionLost?: boolean;
}

/** The shell core client's `request` (path plus options); it throws on a refusal. */
export interface SecretsClient {
  request(path: string, opts?: { method?: "GET" | "POST"; body?: unknown }): Promise<unknown>;
}

export function planDisconnect(storedNames: readonly string[], savedRepos: number): DisconnectPlan {
  return { keys: DISCONNECT_KEYS.filter((k) => storedNames.includes(k.key)).map((k) => ({ key: k.key, label: k.label })), savedRepos };
}

/** The confirmation's list, from the real plan. Empty when nothing is saved. */
export function describePlan(plan: DisconnectPlan): string {
  const parts: string[] = plan.keys.map((k) => k.label);
  if (plan.savedRepos > 0) parts.push(`${plan.savedRepos} saved ${plan.savedRepos === 1 ? "repository" : "repositories"}`);
  return parts.join(", ");
}

/** Reads what is saved: the status names (never a value) and the local saved-repository count. */
export async function readDisconnectPlan(client: SecretsClient, storage?: Storage): Promise<DisconnectPlan> {
  const names = decodeSecretNames(await client.request("/auth/me/secrets"));
  const cfg = readRepoConfig(storage);
  return planDisconnect(names, cfg.saved.gitlab.length + cfg.saved.github.length);
}

function codeOf(e: unknown): string {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z_]{3,40}$/.test(code) ? code : "FAILED";
}

/**
 * Deletes each planned token in turn (a failure does not stop the next one), then, only if all of them worked, clears
 * the saved repositories and signs out. A failure leaves the user signed in and the repositories listed, so the
 * dialog can be run again for what is left.
 */
export async function disconnectAll(
  client: SecretsClient,
  plan: DisconnectPlan,
  signOut: () => Promise<void>,
  options: { storage?: Storage; onStep?: (text: string) => void } = {},
): Promise<DisconnectOutcome> {
  const removed: string[] = [];
  const failed: DisconnectFailure[] = [];
  for (const { key, label } of plan.keys) {
    options.onStep?.(`Removing ${label}...`);
    try {
      await client.request("/auth/me/secrets", { method: "POST", body: { key, value: null } });
      removed.push(key);
    } catch (e) {
      const code = codeOf(e);
      failed.push({ key, label, code });
      if (code === "SESSION_EXPIRED" || code === "NO_SESSION") {
        // The client already dropped the session: every further delete would fail the same way. Say what is left.
        const rest = plan.keys.slice(plan.keys.findIndex((k) => k.key === key) + 1);
        for (const r of rest) failed.push({ key: r.key, label: r.label, code });
        return { removed, failed, reposCleared: false, signedOut: false, sessionLost: true };
      }
    }
  }
  if (failed.length > 0) return { removed, failed, reposCleared: false, signedOut: false };
  // Read fresh, not from the plan: the Mac always empties both lists, even ones saved after the dialog opened.
  const reposCleared = clearSavedRepos(options.storage) > 0;
  options.onStep?.("Signing out...");
  await signOut();
  return { removed, failed, reposCleared, signedOut: true };
}

/** Runs `fn` once at a time: a call made while one is in flight gets the same promise (double-click protection). */
export function singleFlight<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let current: Promise<R> | null = null;
  return (...args: A) => {
    if (current) return current;
    current = fn(...args).finally(() => {
      current = null;
    });
    return current;
  };
}
