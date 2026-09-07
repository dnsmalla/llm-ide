import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;
// Was execFile's `maxBuffer`. Kept so a command that floods stdout still
// can't grow the server's heap without bound. Compared against decoded
// string length, which under-counts multi-byte output — deliberately the
// forgiving direction, since the cap exists to stop runaway growth, not to
// police an exact byte count.
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;
// Grace between SIGTERM and SIGKILL. Same escalation sdk/hooks.mjs uses for
// plugin hook commands, for the same reason: a shell that traps TERM must not
// keep running once nobody is waiting on it.
const KILL_GRACE_MS = 2_000;

// The server's environment is NOT the command's environment.
//
// Every approved command used to inherit `process.env` wholesale — which on
// this server includes ANTHROPIC_API_KEY plus whatever the launching shell
// carried (cloud keys, CI tokens). One approved `env`, `curl -d "$(env)"` or
// even a build script's telemetry then exfiltrated the OPERATOR's credentials,
// not the model's. An allowlist is the only defensible direction for THAT
// class: a denylist has to predict every credential name a future deployment
// invents, and misses one every time.
//
// SCOPE — read this before trusting the list for more than it does:
//   CLOSED:     env-borne secrets. A command can no longer read a credential
//               out of the server's own process environment.
//   NOT CLOSED: anything reachable through the filesystem. HOME is on the list
//               of necessity — git, npm, gh and swift are unusable without it
//               — so an approved command still reads ~/.aws/credentials,
//               ~/.config/gh/hosts.yml, ~/.npmrc, ~/.claude/.credentials.json
//               and ~/.ssh/*. `cat ~/.aws/credentials` is one `curl` away.
//               This narrows one channel; it does NOT close the
//               credential-exfiltration class. The approval gate is what
//               stands between a model and those files.
//
// Each name below is here because ordinary dev commands break without it:
//   PATH                    — `sh` otherwise finds nothing but its builtins
//   HOME                    — git/npm/swift/gh all read per-user config from it
//   USER, LOGNAME           — git identity fallbacks and `whoami`-style output
//   SHELL                   — tools that re-exec a shell (git's pager, make)
//   LANG, LC_ALL, LC_CTYPE  — UTF-8 I/O; without these, Japanese paths and
//                             file contents come back mojibake
//   TZ                      — commit/log timestamps in the user's zone
//   TMPDIR                  — the correct scratch dir; absent, tools fall back
//                             to /tmp, which may not be writable
//   TERM                    — keeps colour/pager capability probes sane
//   XDG_CONFIG_HOME,
//   XDG_CACHE_HOME,
//   XDG_DATA_HOME           — the Linux equivalents of the HOME-relative dirs
//   __CF_USER_TEXT_ENCODING — macOS CoreFoundation locale; absent, Apple
//                             toolchain binaries emit encoding noise on stderr
//
// SSH_AUTH_SOCK is a deliberate credential-adjacent pass-through:
// `git fetch` / `git push` over an ssh remote is a first-class approved
// command and silently loses authentication without it. Be precise about what
// it grants, because it is more than it looks: the socket is scoped to neither
// git nor a host, so ANY command in the group can authenticate as this user to
// EVERY host that trusts the agent's loaded keys, for as long as the command
// runs. It does not hand over the private keys themselves — but "cannot read
// the key" is not "cannot use the key", and HOME (which this list must carry)
// already exposes ~/.ssh to the very same command, so dropping this line would
// not make key material private; it would only break ssh remotes.
//
// Proxy + TLS trust. Without these, every network command — `git fetch`,
// `npm install`, `gh pr list`, `curl` — hangs or fails with an opaque network
// error inside run-bash while working fine in the user's own terminal, and
// nothing in the error points at this list. Both cases of each proxy name are
// passed on purpose: libcurl reads the lowercase form, most Go/Java/Node
// tooling the uppercase, and plenty of tools read only one of the two.
//   HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY (+ lowercase)
//   NODE_EXTRA_CA_CERTS,
//   SSL_CERT_FILE, SSL_CERT_DIR   — the corporate MITM root; absent, TLS fails
//                                   with a certificate error, not a proxy one
//   GIT_SSH_COMMAND               — how a proxied ssh remote gets its
//                                   ProxyCommand. Passing SSH_AUTH_SOCK while
//                                   dropping this was incoherent: behind a
//                                   proxy, the very fetch SSH_AUTH_SOCK exists
//                                   for cannot open a connection at all.
//   GIT_CONFIG_PARAMETERS         — git's own env-borne config, e.g. the
//                                   http.proxyAuthMethod=basic this machine's
//                                   shell already sets
//
// TRADEOFF, stated rather than glossed: a proxy URL can embed basic-auth
// credentials (http://user:pass@host), so passing HTTP_PROXY can pass a
// secret. Accepted knowingly, for two reasons. (1) It is not the weakest link:
// the same command already gets HOME, and ~/.netrc, ~/.aws/credentials and
// ~/.config/gh are strictly richer targets than one proxy password. (2) A
// shell tool that cannot reach the network is not a shell tool — the failure
// mode of omitting these is silent hangs on the most common commands there
// are. If proxy userinfo ever becomes unacceptable, the fix is to strip the
// userinfo and point the command at a local credential-injecting proxy, not to
// drop the variables and ship the hangs.
const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  '__CF_USER_TEXT_ENCODING',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS',
]);

// Belt and braces for the allowlist above: if a later edit widens it, a
// credential-SHAPED name still must not reach a child. Matches the shapes that
// actually ship secrets rather than trying to enumerate vendors.
//
// It is applied to the allowlist itself, so a name added above that happens to
// match is silently dropped — the failure would look like "the proxy variable
// isn't reaching the command" with nothing to explain it. None of the current
// entries match (NODE_EXTRA_CA_CERTS is CERTS, not KEY/SECRET/TOKEN;
// GIT_CONFIG_PARAMETERS is not CREDENTIAL), and a test pins that.
const CREDENTIAL_NAME_RE = /(^ANTHROPIC_|^AWS_|^GITHUB_|^GITLAB_|^OPENAI_|^GOOGLE_|API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|_SESSION$)/i;

/**
 * The minimal environment an approved command runs with.
 *
 * Exported for tests: asserting on the built object is the only way to prove
 * a name is absent for the right reason (not on the list) rather than merely
 * unset in the test process.
 */
export function buildChildEnv(source = process.env) {
  const env = {};
  for (const name of ENV_ALLOWLIST) {
    if (CREDENTIAL_NAME_RE.test(name)) continue;
    const value = source[name];
    if (typeof value === 'string') env[name] = value;
  }
  return env;
}

// True when `target` is an existing directory at or below `root`, after
// resolving symlinks on both sides.
function isDirectoryWithinRoot(target, root) {
  let real;
  let realRoot;
  try {
    real = fs.realpathSync(target);
    realRoot = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory()) return false;
  } catch {
    return false;
  }
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/**
 * Resolve the directory a run-bash call will execute in: explicit arg →
 * workspace root → home.
 *
 * A model-supplied `cwd` is resolved against the workspace and must be an
 * existing directory inside it (realpath containment, like writePathGate).
 * Without that, `{ cwd: "/Users/me/.aws", command: "cat credentials" }`
 * relocates a gate-approved command onto a file the gate never saw — so with
 * no workspace open there is nothing to contain it in, and it is refused
 * rather than resolved against $HOME. Exported so the gate judges the SAME
 * directory the command will actually run in.
 *
 * @returns {{ cwd: string } | { error: string }}
 */
export function resolveBashCwd(args, ctx = {}) {
  const workspaceRoot = ctx?.workspaceRoot ? path.resolve(ctx.workspaceRoot) : null;
  if (typeof args?.cwd !== 'string' || !args.cwd) {
    return { cwd: workspaceRoot ?? os.homedir() };
  }
  if (!workspaceRoot) {
    return { error: 'cwd requires an open project workspace; omit cwd or open a project folder first.' };
  }
  const cwd = path.resolve(workspaceRoot, args.cwd);
  if (!isDirectoryWithinRoot(cwd, workspaceRoot)) {
    return { error: `cwd must be an existing directory inside the project workspace (${workspaceRoot}).` };
  }
  return { cwd };
}

/**
 * Spawn the command and settle with WHY it ended, never throwing.
 *
 * Replaces `execFile`, which could express the timeout but neither of the
 * other two things this function exists for:
 *
 *  - `detached: true` makes the child a process-group LEADER, so the kill
 *    below reaches the whole tree. execFile's SIGTERM landed on `/bin/sh`
 *    alone, and every grandchild it had started (`npm test`'s node, a dev
 *    server holding a port) survived as an orphan.
 *  - an abort mid-flight stops the command. Before, the caller's Stop
 *    cancelled only the client-side task while the command ran on for the
 *    remainder of its timeout — up to the full 120 s.
 *
 * @returns {Promise<{kind:'exit',code:number|null,signal:string|null,stdout:string,stderr:string}
 *   | {kind:'timeout'|'abort'|'overflow'}
 *   | {kind:'spawn-error',message:string}>}
 */
function runShellCommand({ command, cwd, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: buildChildEnv(),
        // stdin is /dev/null rather than an open pipe nobody writes to: a
        // command that reads stdin now sees EOF and returns, instead of
        // blocking until the timeout with no way for anyone to feed it.
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        // NOTE: `signal` is deliberately NOT passed to spawn, even though
        // spawn DOES read it (child_process's CommonSpawnOptions extends
        // Abortable). Its abort calls `subprocess.kill()` — the direct child
        // only. Verified empirically on this Node: with `signal` handed to
        // spawn, the `sh` died and its backgrounded grandchild kept running,
        // which is the exact leak this handler exists to close. The abort
        // listener below kills the process GROUP instead.
      });
    } catch (err) {
      resolve({ kind: 'spawn-error', message: err.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer;
    let killRequested = false;

    // Stop listening for output and let the pipes go. Without this, a command
    // that keeps writing after we have settled keeps `stdout`/`stderr` alive
    // and growing for a result nobody will ever read again; destroying the
    // streams is what makes those strings collectable AND gives the writer an
    // EPIPE, which usually ends it before the SIGKILL has to.
    const releaseStreams = () => {
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        stream.removeAllListeners('data');
        try { stream.destroy(); } catch { /* already gone */ }
      }
    };

    // NOTE: `finish` deliberately does NOT clear `killTimer` — same reasoning
    // as sdk/hooks.mjs. The turn stops waiting on a killed command
    // immediately, but the escalation that actually kills a TERM-trapping
    // tree has to outlive that decision; clearing it here would leave the
    // group running as orphans. Only the child's own exit cancels it (see the
    // 'close' handler). What must NOT outlive `finish` is the *listening*:
    // hence releaseStreams here and the `settled` check in `capture`.
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      releaseStreams();
      resolve(result);
    };

    // Negative pid = the whole process group, which is why `detached` above
    // matters: without it, `-pid` is not a group we own and grandchildren
    // outlive the kill.
    //
    // IDEMPOTENT ON PURPOSE — one SIGTERM and one escalation timer, ever.
    // Every caller of this is a repeatable event: `data` fires again after the
    // overflow trip, and a timeout can land on an already-aborted command.
    // Re-entering used to re-send SIGTERM and, worse, overwrite `killTimer`
    // with a fresh 2 s timer while abandoning the previous one — a command
    // that ignores TERM and floods stdout measured 1,762 abandoned timers and
    // 257 MB RSS, each timer later firing SIGKILL at a pgid long since reaped
    // (and in principle reusable).
    const killGroup = () => {
      if (killRequested) return;
      killRequested = true;
      // A child whose fork failed has no pid (the failure arrives on the
      // 'error' event, which can be after an abort). `-undefined` is NaN;
      // the try below would swallow the throw, but there is no group to
      // signal and no reason to schedule an escalation for it.
      const { pid } = child;
      if (typeof pid !== 'number') return;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      }, KILL_GRACE_MS);
    };

    function onAbort() {
      killGroup();
      finish({ kind: 'abort' });
    }

    const timer = setTimeout(() => {
      killGroup();
      finish({ kind: 'timeout' });
    }, timeoutMs);

    // Aborting the turn (client disconnect / Stop) must take the command with
    // it. `once` plus the removeEventListener in `finish` keeps a long-lived
    // turn signal from accumulating listeners across many commands.
    signal?.addEventListener?.('abort', onAbort, { once: true });

    // setEncoding uses a StringDecoder, so a multi-byte character split
    // across two chunks still decodes correctly (raw Buffer concatenation
    // per chunk would corrupt Japanese output).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // The only errors these pipes produce are EPIPE/ECONNRESET shapes from the
    // destroy in releaseStreams, i.e. our own doing. An 'error' event with no
    // listener would throw out of the stream machinery, so absorb them.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    const capture = (text, which) => {
      // Output that arrives after we settled belongs to nobody: appending it
      // grows the heap for a result already returned, and re-tripping the cap
      // below would call killGroup again.
      if (settled) return;
      if (which === 'out') stdout += text; else stderr += text;
      if (stdout.length + stderr.length > MAX_BUFFER_CHARS) {
        killGroup();
        finish({ kind: 'overflow' });
      }
    };
    child.stdout.on('data', (t) => capture(t, 'out'));
    child.stderr.on('data', (t) => capture(t, 'err'));

    child.on('error', (err) => finish({ kind: 'spawn-error', message: err.message }));
    child.on('close', (code, sig) => {
      // The tree is gone — the escalation timer has nothing left to kill.
      if (killTimer) clearTimeout(killTimer);
      finish({ kind: 'exit', code, signal: sig, stdout, stderr });
    });
  });
}

/**
 * Execute a shell command and return stdout + stderr.
 * @param {object} args
 * @param {string} args.command
 * @param {string} [args.cwd]
 * @param {number} [args.timeout]
 * @param {object} ctx
 * @param {string} [ctx.workspaceRoot]  — from agentContext, the active project root
 * @param {AbortSignal} [ctx.signal]    — the turn's abort signal, when the
 *   caller has one. Aborting kills the command's whole process group.
 */
export async function handleRunBash(args, ctx = {}) {
  const command = (args?.command || '').trim();
  if (!command) return { error: 'Missing command argument.' };

  const timeoutMs = Math.min(
    typeof args?.timeout === 'number' && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  const resolved = resolveBashCwd(args, ctx);
  if (resolved.error) return { error: resolved.error };
  const { cwd } = resolved;

  const signal = ctx?.signal;
  // An already-aborted turn must not start a new command at all — spawning
  // one would leak a process the abort can never be delivered to.
  if (signal?.aborted) return { error: 'Command aborted before it started.', exitCode: null };

  const res = await runShellCommand({ command, cwd, timeoutMs, signal });

  if (res.kind === 'spawn-error') {
    return { error: `Command failed to start: ${res.message}`, exitCode: null };
  }
  if (res.kind === 'timeout') {
    return { error: `Command timed out after ${timeoutMs / 1000}s.`, exitCode: null };
  }
  if (res.kind === 'abort') {
    return { error: 'Command aborted.', exitCode: null };
  }
  if (res.kind === 'overflow') {
    return { error: `Command produced more than ${MAX_BUFFER_CHARS} characters of output and was stopped.`, exitCode: null };
  }

  const { stdout, stderr, code, signal: killedBy } = res;
  if (code === 0) {
    const out = [stdout, stderr].filter(Boolean).join('\n').trimEnd();
    return {
      stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
      stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
      output: out.slice(0, MAX_OUTPUT_CHARS) || '(no output)',
      exitCode: 0,
    };
  }

  const out = [stdout, stderr].filter(Boolean).join('\n').trimEnd();
  return {
    error: `Command failed (exit ${code ?? '?'}): ${out.slice(0, 1000) || (killedBy ? `killed by ${killedBy}` : 'no output')}`,
    stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
    stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
    exitCode: code ?? 1,
  };
}

// ──── Tests (run via: node llm_agent/runtime/handlers/run-bash.mjs)

export async function runTests() {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const tests = [];

  tests.push({
    name: 'returns output for a simple command',
    fn: async () => {
      const r = await handleRunBash({ command: 'echo hello' });
      assert(!r.error, `unexpected error: ${r.error}`);
      assert(r.stdout.trim() === 'hello', `unexpected stdout: ${r.stdout}`);
    },
  });

  tests.push({
    name: 'returns error on missing command',
    fn: async () => {
      const r = await handleRunBash({});
      assert(r.error && r.error.includes('Missing'), 'expected missing error');
    },
  });

  tests.push({
    name: 'returns exitCode on failure',
    fn: async () => {
      const r = await handleRunBash({ command: 'exit 42' });
      assert(r.exitCode === 42 || r.error, 'expected failure');
    },
  });

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
    } catch (e) {
      console.log(`✗ ${t.name}: ${e.message}`);
      throw e;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runTests();
}
