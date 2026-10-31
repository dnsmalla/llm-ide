// Built-in providers (the Mac's always-present rows): Claude on the user's `claude login` subscription, and the
// keyless CLI fallbacks for OpenAI (codex) and Gemini. No key is involved here; the only calls are the core's
// `/kb/providers/verify` CLI probe and the keyless Anthropic model listing.
import { call, type CoreClient } from "./core-api.ts";

export type BuiltinId = "anthropic" | "openai" | "google" | "deepseek";

export interface BuiltinProvider {
  id: BuiltinId;
  name: string;
  /** The CLI this provider can use with a subscription login; null = key only. */
  cli: string | null;
  hint: string;
}

export const BUILTIN_PROVIDERS: readonly BuiltinProvider[] = [
  {
    id: "anthropic",
    name: "Claude (subscription / CLI login)",
    cli: "claude",
    hint:
      "Uses the `claude login` subscription on this computer — no API key needed. The Claude Agent engine runs on this " +
      "login when no key is set, and its model list comes from the account itself.",
  },
  {
    id: "openai",
    name: "OpenAI (Codex CLI)",
    cli: "codex",
    hint:
      "With an API key (Add from catalog) chats get this app's tools. The check below confirms whether `codex` is " +
      "installed and signed in; a keyless CLI turn is not offered in the desktop chat picker yet.",
  },
  {
    id: "google",
    name: "Google Gemini (Gemini CLI)",
    cli: "gemini",
    hint:
      "With an API key (Add from catalog) chats get this app's tools. The check below confirms whether `gemini` is " +
      "installed and signed in; a keyless CLI turn is not offered in the desktop chat picker yet.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    cli: null,
    hint: "Key required — DeepSeek has no CLI subscription mode. Add it from the catalog with an API key.",
  },
] as const;

export interface CliResult {
  ok: boolean;
  detail: string;
}

const clip = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** `{ ok, detail }` from `/kb/providers/verify` (mode cli). */
export function decodeCliResult(v: unknown): CliResult | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.ok !== "boolean") return null;
  return { ok: o.ok, detail: clip(o.detail, 240) };
}

/** Runs the CLI version probe for a built-in provider. Never touches a key. */
export async function checkProviderCli(client: CoreClient, id: BuiltinId, signal?: AbortSignal): Promise<CliResult> {
  const body = await call(client, "POST", "/kb/providers/verify", { provider: id, mode: "cli" }, signal);
  const r = decodeCliResult(body);
  if (!r) throw new Error("the core returned a verification answer this app cannot read");
  return r;
}

export interface ModelCount {
  count: number;
  detail: string;
}

/** The keyless Anthropic model list (the SDK answers from the account's `claude login`). */
export function decodeModelCount(v: unknown): ModelCount {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const list = Array.isArray(o.entries) ? o.entries : Array.isArray(o.models) ? o.models : [];
  return { count: list.length, detail: clip(o.detail, 200) };
}

export async function checkClaudeModels(client: CoreClient, signal?: AbortSignal): Promise<ModelCount> {
  return decodeModelCount(await call(client, "POST", "/kb/providers/models", { provider: "anthropic" }, signal));
}

/** What the Claude row's status badge says. */
export function claudeStatusLabel(cli: CliResult | null, models: ModelCount | null): string {
  if (!cli) return "Checking...";
  if (!cli.ok) return "CLI not found";
  return models && models.count > 0 ? `Signed in · ${models.count} models` : "CLI found";
}

export function cliStatusLabel(r: CliResult | null): string {
  if (!r) return "Checking...";
  return r.ok ? "CLI found" : "CLI not found";
}
