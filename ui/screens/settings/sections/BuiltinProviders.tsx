import { useCallback, useEffect, useState } from "react";
import {
  BUILTIN_PROVIDERS,
  checkClaudeModels,
  checkProviderCli,
  claudeStatusLabel,
  cliStatusLabel,
  type CliResult,
  type ModelCount,
} from "../builtin-providers.ts";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";

interface RowState {
  busy: boolean;
  cli: CliResult | null;
  models: ModelCount | null;
  error: string | null;
}

/**
 * The Mac's always-present provider rows: Claude on the local `claude login` subscription, the keyless codex and
 * gemini CLI fallbacks, and DeepSeek's key-only note. Nothing here stores or sends a key; the checks are the core's
 * CLI version probe and the keyless Anthropic model listing.
 */
export function BuiltinProviders() {
  const { client } = useEnv();
  const [byId, setById] = useState<Record<string, RowState>>({});

  const check = useCallback(
    async (id: string) => {
      setById((m) => ({ ...m, [id]: { busy: true, cli: m[id]?.cli ?? null, models: m[id]?.models ?? null, error: null } }));
      try {
        const cli = await checkProviderCli(client, id as never);
        let models: ModelCount | null = null;
        if (id === "anthropic" && cli.ok) {
          try {
            models = await checkClaudeModels(client);
          } catch {
            models = null;
          }
        }
        setById((m) => ({ ...m, [id]: { busy: false, cli, models, error: null } }));
      } catch (e) {
        setById((m) => ({ ...m, [id]: { busy: false, cli: null, models: null, error: describeError(e) } }));
      }
    },
    [client],
  );

  useEffect(() => {
    for (const p of BUILTIN_PROVIDERS) if (p.cli) void check(p.id);
  }, [check]);

  return (
    <div className="st-note" role="group" aria-label="Built-in providers">
      <span className="st-label">Built-in providers</span>
      <p className="st-hint">
        Always available, no connection needed. The Claude engine runs on this computer&apos;s <code>claude login</code>{" "}
        subscription when no API key is set, and its model list comes from the account. The Codex and Gemini rows check
        whether those CLIs are installed and signed in; add an API key from the catalog to select those providers in
        chats.
      </p>
      {BUILTIN_PROVIDERS.map((p) => {
        const st = byId[p.id];
        const cli = st?.cli ?? null;
        const label = p.id === "anthropic" ? claudeStatusLabel(cli, st?.models ?? null) : cliStatusLabel(cli);
        const bad = cli !== null && !cli.ok;
        return (
          <div key={p.id} className="st-stack" data-builtin={p.id}>
            <div className="st-row">
              <strong className="st-grow">{p.name}</strong>
              {p.cli ? (
                <span className="st-status" data-tone={st?.busy ? undefined : bad ? "warning" : cli ? "ok" : undefined}>
                  {st?.busy ? "Checking..." : label}
                </span>
              ) : (
                <span className="st-status">Key only</span>
              )}
              {p.cli ? (
                <Button label={`Check the ${p.cli} CLI`} disabled={st?.busy === true} onClick={() => void check(p.id)}>
                  {st?.busy ? "Checking..." : "Check CLI"}
                </Button>
              ) : null}
            </div>
            <p className="st-hint">{p.hint}</p>
            {cli?.detail ? <p className="st-hint">{cli.detail}</p> : null}
            {p.id === "anthropic" && cli?.ok && st?.models?.detail ? <p className="st-hint">{st.models.detail}</p> : null}
            {st?.error ? <ErrorText text={st.error} /> : null}
          </div>
        );
      })}
    </div>
  );
}
