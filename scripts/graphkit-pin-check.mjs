#!/usr/bin/env node
// graph-kit pin check. One pin selects the graph-kit revision llm-ide uses: the
// submodule gitlink (index entry of graph-kit/). The desktop and the graph gates
// read the checkout; the Swift Mac app and its Package.swift/Package.resolved pins
// are gone.
//
// Usage:
//   node scripts/graphkit-pin-check.mjs              offline: the gitlink exists (make regression)
//   node scripts/graphkit-pin-check.mjs --online     also: the pinned sha exists on the graph-kit
//                                                    remote. Asks the remote, not the local clone:
//                                                    a branch/tag tip from `git ls-remote`, else
//                                                    `git fetch origin <sha>` in the submodule, else
//                                                    the GitHub API. Fetches the submodule first.
//                                                    Unreachable remote = warning, never a failure.
//
// Warnings (never failures): the submodule worktree HEAD differs from the
// gitlink, the submodule is not checked out, or the remote could not be asked.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GRAPHKIT_URL = 'https://github.com/dnsmalla/graph-kit.git';
export const GRAPHKIT_REPO = 'dnsmalla/graph-kit';
export const SUBMODULE_PATH = 'graph-kit';
const REMOTE_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;

// `git ls-files -s <path>` line: "160000 <sha> 0\t<path>". Mode 160000 is a gitlink.
export function parseGitlink(lsFilesOutput) {
  for (const line of String(lsFilesOutput).split('\n')) {
    const m = /^160000 ([0-9a-f]{40}) \d+\t/.exec(line);
    if (m) return m[1];
  }
  return null;
}

// Returns { problems: string[], warnings: string[] }. Problems fail the gate.
export function comparePins({ gitlink }) {
  const problems = [];
  if (!gitlink) problems.push(`no submodule gitlink for ${SUBMODULE_PATH} in the index`);
  return { problems, warnings: [] };
}

// `git ls-remote <url>` output: "<sha>\t<ref>" per line.
export function parseLsRemote(text) {
  return String(text)
    .split('\n')
    .map((line) => /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ sha: m[1], ref: m[2] }));
}

// True when the sha is the tip of some ref (branch, tag or a peeled annotated tag).
export function pinIsRemoteTip(sha, refs) {
  return refs.some((r) => r.sha === sha);
}

// Outcome of `git fetch origin <sha>` in the submodule: the remote's own answer
// for that one object. "not our ref" is the server saying it does not have the
// object reachable from its refs. Anything else (network, auth) is unknown.
export function classifyShaFetch({ ok, stderr = '' }) {
  if (ok) return 'present';
  if (/not our ref|couldn't find remote ref|unadvertised object/i.test(String(stderr))) return 'absent';
  return 'unknown';
}

// Outcome of `gh api repos/<repo>/commits/<sha>`. `missing` = gh is not installed.
export function classifyGhProbe({ ok, stderr = '', missing = false }) {
  if (missing) return 'skipped';
  if (ok) return 'present';
  if (/HTTP 404|Not Found/i.test(String(stderr))) return 'absent';
  return 'unknown';
}

// The online decision table. Inputs are facts gathered from the remote:
//   remoteRefs  parsed ls-remote output, or null when the remote could not be asked
//   remoteError first line of the ls-remote error (shown when remoteRefs is null)
//   shaProbe    'present' | 'absent' | 'unknown' | 'skipped'  (submodule fetch by sha)
//   ghProbe     'present' | 'absent' | 'unknown' | 'skipped'  (GitHub API)
//   fetchOk     whether `git fetch origin` in the submodule succeeded
//   hasSub      whether the submodule is checked out
// Returns { problems, warnings }. Only a definite "absent" fails the gate.
export function decideOnline({ sha, remoteRefs, remoteError = '', shaProbe = 'skipped', ghProbe = 'skipped', fetchOk = false, hasSub = false }) {
  const short = sha.slice(0, 12);
  if (remoteRefs === null) {
    return {
      problems: [],
      warnings: [`graph-kit remote unreachable, existence check skipped: ${remoteError || 'ls-remote failed'}`],
    };
  }
  if (pinIsRemoteTip(sha, remoteRefs)) return { problems: [], warnings: [] };
  const probes = [shaProbe, ghProbe];
  if (probes.includes('present')) return { problems: [], warnings: [] };
  if (probes.includes('absent')) {
    return {
      problems: [
        `pinned graph-kit revision ${sha} does not exist on ${GRAPHKIT_URL}. ` +
          `If it is a local commit, push graph-kit (\`git -C ${SUBMODULE_PATH} push origin main\`). ` +
          `If it should already be on the remote, fetch or checkout the submodule ` +
          `(\`git submodule update --init ${SUBMODULE_PATH}\`) and check the pin again.`,
      ],
      warnings: [],
    };
  }
  const why = [];
  if (!hasSub) why.push('the submodule is not checked out');
  if (hasSub && !fetchOk) why.push('the submodule fetch failed, so its view may be stale');
  if (shaProbe === 'unknown') why.push('asking the remote for the sha failed');
  if (ghProbe === 'unknown') why.push('the GitHub API could not confirm it');
  if (ghProbe === 'skipped' && shaProbe === 'skipped') why.push('no tool could ask the remote about a non-tip sha');
  return {
    problems: [],
    warnings: [`could not confirm pinned ${short} on the remote (${why.join('; ') || 'unknown reason'}); not a failure`],
  };
}

function git(args, cwd = ROOT, timeout = REMOTE_TIMEOUT_MS) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0] ?? '';
}

function offlineReport() {
  const problems = [];
  const warnings = [];
  const gitlink = parseGitlink(git(['ls-files', '-s', SUBMODULE_PATH]));
  const cmp = comparePins({ gitlink });
  problems.push(...cmp.problems);
  warnings.push(...cmp.warnings);

  const subDir = join(ROOT, SUBMODULE_PATH);
  if (!existsSync(join(subDir, '.git'))) {
    warnings.push(`submodule ${SUBMODULE_PATH} is not checked out (git submodule update --init ${SUBMODULE_PATH})`);
  } else if (gitlink) {
    const head = git(['rev-parse', 'HEAD'], subDir).trim();
    if (head !== gitlink) {
      warnings.push(`submodule worktree HEAD ${head.slice(0, 12)} differs from the gitlink ${gitlink.slice(0, 12)} (the gitlink is what gets committed)`);
    }
  }
  return { gitlink, problems, warnings };
}

// Gathers the remote facts and hands them to decideOnline. Fetches the submodule
// first so its view is current; a failed fetch only marks the answer as possibly
// stale and never decides the outcome by itself.
function onlineProblems(sha) {
  const subDir = join(ROOT, SUBMODULE_PATH);
  const hasSub = existsSync(join(subDir, '.git'));

  let fetchOk = false;
  if (hasSub) {
    try {
      git(['fetch', '--quiet', 'origin'], subDir, FETCH_TIMEOUT_MS);
      fetchOk = true;
    } catch {
      fetchOk = false;
    }
  }

  let remoteRefs = null;
  let remoteError = '';
  try {
    remoteRefs = parseLsRemote(git(['ls-remote', GRAPHKIT_URL]));
  } catch (err) {
    remoteError = firstLine(err.stderr || err.message);
  }

  let shaProbe = 'skipped';
  let ghProbe = 'skipped';
  if (remoteRefs !== null && !pinIsRemoteTip(sha, remoteRefs)) {
    shaProbe = hasSub ? probeShaOnRemote(sha, subDir) : 'skipped';
    if (shaProbe !== 'present') ghProbe = probeGitHubApi(sha);
  }
  return decideOnline({ sha, remoteRefs, remoteError, shaProbe, ghProbe, fetchOk, hasSub });
}

function probeShaOnRemote(sha, subDir) {
  try {
    git(['fetch', '--quiet', '--no-tags', 'origin', sha], subDir, FETCH_TIMEOUT_MS);
    git(['cat-file', '-e', `${sha}^{commit}`], subDir);
    return 'present';
  } catch (err) {
    return classifyShaFetch({ ok: false, stderr: err.stderr });
  }
}

function probeGitHubApi(sha) {
  try {
    const out = execFileSync('gh', ['api', `repos/${GRAPHKIT_REPO}/commits/${sha}`, '--jq', '.sha'], {
      encoding: 'utf8',
      timeout: REMOTE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return classifyGhProbe({ ok: out.trim() === sha, stderr: '' });
  } catch (err) {
    return classifyGhProbe({ ok: false, stderr: String(err.stderr ?? ''), missing: err.code === 'ENOENT' });
  }
}

function main(argv) {
  const online = argv.includes('--online');
  const rep = offlineReport();
  const problems = [...rep.problems];
  const warnings = [...rep.warnings];
  if (online && rep.gitlink) {
    const o = onlineProblems(rep.gitlink);
    problems.push(...o.problems);
    warnings.push(...o.warnings);
  }
  for (const w of warnings) console.warn(`graphkit-pin-check: warning: ${w}`);
  if (problems.length) {
    for (const p of problems) console.error(`graphkit-pin-check: FAIL: ${p}`);
    return 1;
  }
  console.log(`graphkit-pin-check: ok (${online ? 'online' : 'offline'}) gitlink=${rep.gitlink.slice(0, 12)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`graphkit-pin-check: ${err.message}`);
    process.exitCode = 1;
  }
}
