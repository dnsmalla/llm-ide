// Engine interface for bus tasks (docs/superpowers/plans/2026-10-31-auto-tasks-audit.md section 4, G1):
//
//   runTask({ userId, engine: { provider, model?, credential? }, prompt, cwd, mode, signal, spawn, deps })
//     -> { text, usage?, stopReason, engine }
//
// Implementations: `claude` (the Agent SDK confined agent, read-only tools), `adapter` (a provider-catalog connection
// through the multi-provider adapter: text only, no file access), `codex` and `gemini` (the provider CLIs through
// providers/providers.mjs cliInvocation, in the job's own process group via ctx.spawn).
//
// Rules, all enforced here and tested:
//   - mode is 'read' only. Every engine refuses 'write' (kind_not_available): codex and gemini write mode needs an explicit
//     design and a user decision (the Swift runner passes --yolo, which turns their sandbox off; this never does).
//   - a CLI argv containing --yolo or --dangerously-* is refused before spawn, whoever built it.
//   - a CLI child gets minimalCliEnv (+ the provider's own key on the api-key path), never the server's env.
//   - gemini has no read-only flag, so a CLI run on a git checkout must leave `git status` unchanged: a changed tree fails
//     the run `read_only_violated`.
//   - codex and gemini are DISABLED for the bus (`available: false`, reason ENGINE_NOT_SANDBOXED) until an OS sandbox
//     exists. Their "read-only" holds only inside the checkout: the child still sees HOME/XDG/PATH, the CLI's login
//     files, and (codex -s read-only) can read ~/.ssh and any other file the user can; gemini has no sandbox flag at all.
//     Claude (the confined agent) and the text-only adapter stay available. Kept for the day a sandbox lands:
//     `deps.allowUnsandboxedCli` is a TEST-ONLY seam, no HTTP or env path sets it.
//   - NEVER an API key in a CLI child's env: the credential `api-key` is refused for CLI engines (a key in the env of a
//     process we cannot confine is a key the process can read and send anywhere). Documented gap: CLI engines run on the
//     CLI's own login only, once they are enabled.
//   - a missing login or key is a typed error (engine_not_logged_in, engine_no_key), never a silent fallback to another engine.
import crypto from 'node:crypto';
import { redactSecrets } from '../../core/redact-secrets.mjs';
import {
  cliInvocation, providerApiKey, minimalCliEnv,
} from '../../providers/providers.mjs';
import { completeViaAdapter } from '../../providers/adapter-complete.mjs';

export const ENGINE_IDS = ['claude', 'adapter', 'codex', 'gemini'];
export const MAX_ENGINE_TEXT = 256 * 1024;

const fail = (code, message) => Object.assign(new Error(message), { code });

/** The engine id for a provider name from the catalogue, or null. */
export function engineIdFor(provider) {
  if (provider === 'anthropic') return 'claude';
  if (provider === 'openai') return 'codex';
  if (provider === 'google') return 'gemini';
  if (typeof provider === 'string' && provider.startsWith('custom:')) return 'adapter';
  return null;
}

export const ENGINE_NOT_SANDBOXED = 'ENGINE_NOT_SANDBOXED';
const CLI_ENGINES = new Set(['codex', 'gemini']);

/** `{ id, available, reason? }` for one engine id. The CLI engines are unavailable: no OS sandbox confines them. */
export function engineStatus(id, deps = {}) {
  if (CLI_ENGINES.has(id) && !deps.allowUnsandboxedCli) return { id, available: false, reason: ENGINE_NOT_SANDBOXED };
  return { id, available: true };
}
/** Status of each id in `ids`, in order. */
export const engineStatusList = (ids, deps = {}) => ids.map((id) => engineStatus(id, deps));
const BAD_FLAG = /^--(yolo|dangerously-)/;
const AUTH_HINT = /(not logged in|log ?in|authenticat|unauthori[sz]ed|credential|api[ -_]?key|sign in|401|403)/i;

const capText = (t) => {
  const s = redactSecrets(String(t ?? ''));
  return Buffer.byteLength(s, 'utf8') > MAX_ENGINE_TEXT ? { text: s.slice(0, MAX_ENGINE_TEXT), truncated: true } : { text: s, truncated: false };
};

/** `git status` signature of a checkout, or null when cwd is not one. Never writes (no optional locks). */
async function gitSignature(spawn, cwd) {
  try {
    const r = await spawn('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z'], { cwd, env: minimalCliEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
    if (r.code !== 0) return null;
    return crypto.createHash('sha256').update(r.stdout).digest('hex');
  } catch { return null; }
}

async function runCli({ userId, engine, prompt, cwd, spawn, deps, id }) {
  const provider = engine.provider;
  if (engine.credential === 'api-key') throw fail('kind_not_available', `The ${id} CLI engine runs on its own login only: an API key is never put in a CLI child's environment`);
  const inv = (deps.cliInvocation ?? cliInvocation)(provider, prompt, { cwd, model: engine.model });
  if (!inv) throw fail('engine_failed', 'unknown engine');
  if (inv.args.some((a) => BAD_FLAG.test(String(a)))) throw fail('engine_failed', 'refused: an unsafe CLI flag');
  const env = minimalCliEnv({});
  const before = await gitSignature(spawn, cwd);
  let r;
  try {
    r = await spawn(inv.bin, inv.args, { cwd, env });
  } catch (e) {
    if (e?.code === 'ENOENT') throw fail('engine_not_logged_in', `The ${id} CLI is not installed or not on PATH.`);
    throw fail('engine_failed', 'the engine could not start');
  }
  if (r.aborted) return { text: '', stopReason: 'aborted', engine: id };
  const after = await gitSignature(spawn, cwd);
  if (before && after && before !== after) throw fail('read_only_violated', `the ${id} run changed the working tree during a read-only task`);
  if (r.code !== 0) {
    const err = `${r.stderr || ''}\n${r.stdout || ''}`;
    if (AUTH_HINT.test(err)) throw fail('engine_not_logged_in', `The ${id} CLI is not signed in. Run its own login.`);
    throw fail('engine_failed', `the ${id} run failed`);
  }
  return { ...capText(r.stdout), stopReason: 'end', engine: id };
}

async function runClaude({ userId, engine, prompt, cwd, signal, deps }) {
  if (engine.credential === 'api-key' && !(deps.providerApiKey ?? providerApiKey)(userId, 'anthropic')) {
    throw fail('engine_no_key', 'No Anthropic API key is saved. Add one in Settings, Providers.');
  }
  const mod = deps.claudeEngine ?? await import('../../llm_agent/sdk/loop-agent.mjs');
  const rootCheck = mod.validateLoopRepoRoot(userId, cwd);
  if (!rootCheck.ok) throw fail('project_not_allowed', 'that project is not in your repo allow-list');
  const ac = new AbortController();
  if (signal?.aborted) ac.abort(); else signal?.addEventListener('abort', () => ac.abort(), { once: true });
  let out;
  try {
    out = await mod.runLoopAgent({
      message: prompt, skills: [], root: rootCheck.root, userId, model: engine.model, abortController: ac,
      allowAmbientAuth: true, readOnly: true, ...(deps.queryFactory ? { queryFactory: deps.queryFactory } : {}),
    });
  } catch (e) {
    if (ac.signal.aborted) return { text: '', stopReason: 'aborted', engine: 'claude' };
    if (e?.code === 'NO_KEY') throw fail('engine_no_key', 'No Anthropic key or login is available.');
    if (e?.code === 'PROVIDER_UNAVAILABLE' || e?.code === 'PROVIDER_NOT_AGENT_CAPABLE') throw fail('engine_not_logged_in', 'That provider is not usable for an agent run.');
    throw fail('engine_failed', 'the engine run failed');
  }
  if ((out.changedPaths || []).length || (out.createdPaths || []).length) throw fail('read_only_violated', 'a read-only run reported changed files');
  return { ...capText(out.reply), usage: out.usage, stopReason: out.resultSubtype || 'end', engine: 'claude' };
}

async function runAdapter({ userId, engine, prompt, signal, deps }) {
  try {
    const text = await (deps.completeViaAdapter ?? completeViaAdapter)(engine.provider, {
      userId, model: engine.model, prompt, signal, meter: { userId, endpoint: '/bus/commands' },
    });
    return { ...capText(text), stopReason: 'end', engine: 'adapter' };
  } catch (e) {
    if (signal?.aborted) return { text: '', stopReason: 'aborted', engine: 'adapter' };
    if (e?.code === 'PROVIDER_UNAVAILABLE' || e?.code === 'PROVIDER_BLOCKED') throw fail('engine_no_key', 'That provider connection is not usable. Check Settings, Providers.');
    throw fail('engine_failed', 'the engine run failed');
  }
}

export async function runTask({ userId, engine, prompt, cwd, mode = 'read', signal, spawn, deps = {} }) {
  if (mode !== 'read') throw fail('kind_not_available', 'write mode is not available on any engine');
  const id = engineIdFor(engine?.provider);
  if (!id) throw fail('invalid_args', 'unknown provider');
  if (id === 'claude') return runClaude({ userId, engine, prompt, cwd, signal, deps });
  if (id === 'adapter') return runAdapter({ userId, engine, prompt, signal, deps });
  if (!engineStatus(id, deps).available) throw fail('kind_not_available', `The ${id} engine is unavailable (${ENGINE_NOT_SANDBOXED}): no OS sandbox confines it`);
  return runCli({ userId, engine, prompt, cwd, signal, spawn, deps, id });
}
