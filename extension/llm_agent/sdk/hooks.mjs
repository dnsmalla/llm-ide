// Plugin hook execution for the v2 (Agent SDK) engine.
//
// A vendor plugin's `hooks/hooks.json` declares shell commands to run at
// points in a turn. That is materially more capability than anything else a
// plugin can carry — a skill only adds prompt text, a command only expands a
// template — so execution is gated three ways:
//
//   1. The plugin must be ENABLED for the user (the existing plugin toggle).
//   2. The user must additionally TRUST that plugin's hooks
//      (`plugins/state.mjs` → hooksTrusted, default off, per user).
//   3. Only `command` handlers on events this engine delivers ever run;
//      http/mcp_tool/prompt/agent handlers are catalogued by the loader and
//      never reach here (plugins/loader.mjs → parseHookDeclarations).
//
// Only the v2 SDK engine runs hooks. The legacy CLI path and the native
// provider loop have no hook surface, so a plugin's hooks are catalogued-only
// there — see the design spec's phase-3 section.
//
// Exit-code convention follows Claude Code's own: 0 = continue, 2 = block the
// action and feed stderr back as the reason, anything else = the hook itself
// failed (logged, turn continues — a broken hook must not wedge a session).

import { spawn } from 'node:child_process';

// A hook gets a bounded slice of the turn: its own declared timeout (already
// clamped by the loader) and a hard output cap, so a chatty or hung hook can
// neither flood the transcript nor stall the turn indefinitely.
const MAX_HOOK_OUTPUT_BYTES = 4_096;
const KILL_GRACE_MS = 2_000;

/**
 * Run one hook command, feeding it the event payload as JSON on stdin.
 *
 * Never throws: every failure path resolves to a `continue: true` result with
 * a `systemMessage` describing what went wrong, because a hook is an optional
 * side channel and the turn belongs to the user.
 *
 * @returns {Promise<{continue: boolean, stopReason?: string, systemMessage?: string}>}
 */
export function runHookCommand({ command, timeoutMs }, { input, cwd, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // `sh -c` because a hook command is a shell line (pipes, redirections,
      // `${VAR}` already expanded by the loader), exactly as both vendors
      // specify it. The command comes from a plugin the user explicitly
      // trusted for this purpose — that trust IS the gate.
      child = spawn('sh', ['-c', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: cwd || process.cwd(),
        env: env || process.env,
      });
    } catch (err) {
      resolve({ continue: true, systemMessage: `hook could not start: ${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const capture = (buf, which) => {
      const text = buf.toString('utf8');
      if (which === 'out') {
        if (stdout.length < MAX_HOOK_OUTPUT_BYTES) stdout += text.slice(0, MAX_HOOK_OUTPUT_BYTES - stdout.length);
      } else if (stderr.length < MAX_HOOK_OUTPUT_BYTES) {
        stderr += text.slice(0, MAX_HOOK_OUTPUT_BYTES - stderr.length);
      }
    };
    child.stdout.on('data', (b) => capture(b, 'out'));
    child.stderr.on('data', (b) => capture(b, 'err'));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };

    let killTimer;
    const timer = setTimeout(() => {
      // SIGTERM first, SIGKILL if it ignores that — a hook that traps TERM
      // must not hold the turn open.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
      finish({ continue: true, systemMessage: `hook timed out after ${timeoutMs}ms and was stopped` });
    }, Math.max(1, Number(timeoutMs) || 1));

    child.on('error', (err) => finish({ continue: true, systemMessage: `hook failed to run: ${err.message}` }));

    child.on('close', (code) => {
      if (code === 0) return finish({ continue: true });
      if (code === 2) {
        // The blocking case: stderr is the reason handed back to the model.
        const reason = (stderr || stdout).trim() || 'blocked by a plugin hook';
        return finish({ continue: false, stopReason: reason.slice(0, MAX_HOOK_OUTPUT_BYTES) });
      }
      return finish({
        continue: true,
        systemMessage: `hook exited ${code}: ${(stderr || stdout).trim().slice(0, 200)}`,
      });
    });

    // Payload on stdin, matching the vendors' hook contract. EPIPE is normal
    // here — a hook that ignores stdin (`exit 2`) closes it before we write.
    try {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input ?? {}));
    } catch { /* the close handler still resolves */ }
  });
}

/**
 * Translate the trusted plugins' hook declarations into the SDK's `hooks`
 * option: `{ [event]: [{ matcher?, hooks: [callback] }] }`.
 *
 * `plugins` is `[{ name, hooks }]` as the loader produced them; `trusted` is
 * the user's hooksTrusted Set. A plugin absent from that Set contributes
 * nothing — this function is the only place hook trust turns into behavior.
 */
export function buildPluginHooks(plugins, { trusted, cwd, env, onNote } = {}) {
  const byEvent = {};
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    if (!trusted || !trusted.has(plugin?.name)) continue;
    for (const declaration of Array.isArray(plugin.hooks) ? plugin.hooks : []) {
      const { event, matcher, command, timeoutMs } = declaration || {};
      if (!event || !command) continue;
      const callback = async (input) => {
        const result = await runHookCommand({ command, timeoutMs }, { input, cwd, env });
        if (result.systemMessage) {
          // Surfaced rather than swallowed: a hook that keeps timing out is
          // the plugin author's bug, and the operator needs to see it.
          onNote?.(`[plugin:${plugin.name}] ${event}: ${result.systemMessage}`);
        }
        return result;
      };
      if (!byEvent[event]) byEvent[event] = [];
      byEvent[event].push(matcher ? { matcher, hooks: [callback] } : { hooks: [callback] });
    }
  }
  return byEvent;
}
