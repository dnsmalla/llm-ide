// The Mac's built-in credential rows (Settings -> Providers): the Anthropic API key, the Jev decisions key and the
// optional SerpAPI key. Write-only: a key is typed into a SecretField, handed to the core once and never read back.
// The page only ever learns "saved" or "not set" from the names the status route returns.
import { call, type CoreClient } from "./core-api.ts";
import { decodeSecretNames } from "./decoders.ts";
import { decodeCliResult } from "./builtin-providers.ts";
import { scrubSecrets, type SecretField } from "./secret-field.ts";

export interface BuiltinKey {
  id: "anthropic" | "jev" | "serpapi";
  label: string;
  /** `/auth/me/secrets` name (in the core's allowlist, server/vault.mjs). */
  vaultKey: string;
  placeholder: string;
  hint: string;
  /** Provider the core's `/kb/providers/verify` checks before the key is saved; null = no verifier, saved as typed. */
  verifyAs: string | null;
  /** The smallest server API version whose vault accepts this key (absent = any). */
  minApiVersion?: number;
}

// Hints and placeholders are the Mac's (ProviderCatalog.swift:48-85).
export const BUILTIN_KEYS: readonly BuiltinKey[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    vaultKey: "claude.apiKey",
    // The Mac shows "sk-ant-…"; the page keeps key-looking text out of the DOM (components.test.mjs guard).
    placeholder: "Paste your Anthropic API key",
    hint: "claude-* models. Also works with no key via your logged-in `claude` CLI (subscription). The only provider the Claude Agent engine can run.",
    verifyAs: "anthropic",
  },
  {
    id: "jev",
    label: "Jev (decisions)",
    vaultKey: "jev.apiKey",
    placeholder: "Jev API key",
    hint: "Decision-only: answers yes/no, pick-one and score questions with calibrated probabilities. Used by the Decisions role in Model routing and by the agent's `decide` tool — not a chat model, so it never appears in the chat composer. Key required.",
    verifyAs: "jev",
    minApiVersion: 73,
  },
  {
    id: "serpapi",
    label: "Web Search (SerpAPI, optional)",
    vaultKey: "serpapi.apiKey",
    placeholder: "Optional — your SerpAPI key from https://serpapi.com",
    hint: "Web search works automatically through your Claude login (or Anthropic API key) — no setup needed. A SerpAPI key is only an optional fallback.",
    verifyAs: null,
  },
];

/** A message the page may show as written (its own wording, never a value). Other errors become generic text. */
export class KeyError extends Error {
  override name = "KeyError";
}

/** The rows this server accepts. An unknown API version hides the version-gated rows (fail closed). */
export function visibleBuiltinKeys(apiVersion: number | null): BuiltinKey[] {
  return BUILTIN_KEYS.filter((k) => k.minApiVersion === undefined || (apiVersion !== null && apiVersion >= k.minApiVersion));
}

export function keyStateLabel(stored: boolean | null): string {
  if (stored === null) return "Checking...";
  return stored ? "Saved" : "Not set";
}

/** Names of the keys the user has stored. Values are never in the response shape this reads. */
export async function loadStoredKeyNames(client: CoreClient): Promise<Set<string>> {
  return new Set(decodeSecretNames(await call(client, "GET", "/auth/me/secrets")));
}

/**
 * Takes the typed key out of the field (the field is empty afterwards, even when the request fails), verifies it
 * when the core has a verifier, then saves it. Returns the Mac's success notice. Throws a plain Error whose message
 * never contains the key.
 */
export async function saveBuiltinKey(client: CoreClient, key: BuiltinKey, field: SecretField): Promise<string> {
  const value = field.take().trim();
  if (!value) throw new KeyError("Type a key first.");
  if (key.verifyAs) {
    const r = decodeCliResult(await call(client, "POST", "/kb/providers/verify", { provider: key.verifyAs, mode: "key", apiKey: value }));
    if (!r) throw new KeyError("The core returned a verification answer this app cannot read.");
    if (!r.ok) {
      const detail = scrubSecrets(r.detail.split(value).join("[redacted]"));
      throw new KeyError(`Verification failed. The key was not saved.${detail ? ` ${detail}` : ""}`);
    }
  }
  await call(client, "POST", "/auth/me/secrets", { key: key.vaultKey, value });
  // No verifier exists for this key on the core (nor on the Mac), so say so rather than imply a check.
  return key.verifyAs ? "Verified and saved." : "Key saved (not verified).";
}

/** Removes a stored key through the same route with a null value. The caller asks for confirmation first. */
export async function clearBuiltinKey(client: CoreClient, key: BuiltinKey): Promise<void> {
  await call(client, "POST", "/auth/me/secrets", { key: key.vaultKey, value: null });
}
