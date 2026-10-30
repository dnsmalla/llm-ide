// Phase 0 condition 2: the packaged core must NOT bundle the Agent SDK's platform
// `claude` binary (239 MB; installer 160 MB -> 67 MB); the app points the SDK at the
// user's installed CLI instead. This module removes the platform packages at staging
// time and verifies the staged tree, so a dependency change cannot silently re-add it.
//
// Opt-out for spike/bench builds that still rely on the bundled binary (the server
// does not yet pass pathToClaudeCodeExecutable): LLMIDE_STAGE_ALLOW_SDK_BINARY=1.
import { existsSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/** SDK platform packages, e.g. @anthropic-ai/claude-agent-sdk-darwin-arm64. */
export const SDK_PLATFORM_PKG = /^claude-agent-sdk-.+/;

/** Directories under `<nm>/@anthropic-ai` that hold a platform binary. */
export function findSdkBinaryPackages(nodeModulesDir) {
  const scope = join(nodeModulesDir, '@anthropic-ai');
  if (!existsSync(scope)) return [];
  return readdirSync(scope).filter((n) => SDK_PLATFORM_PKG.test(n)).map((n) => join(scope, n));
}

/** Any regular file named `claude` / `claude.exe` anywhere under `dir` (belt and braces). */
export function findClaudeExecutables(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && (name === 'claude' || name === 'claude.exe')) hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

/** Deletes the SDK platform packages; returns the removed paths. */
export function removeSdkBinaryPackages(nodeModulesDir) {
  const found = findSdkBinaryPackages(nodeModulesDir);
  for (const p of found) rmSync(p, { recursive: true, force: true });
  return found;
}

/** Problems for a staged core root (empty = condition 2 holds). */
export function verifyNoSdkBinary(coreDir) {
  const problems = [];
  for (const p of findSdkBinaryPackages(join(coreDir, 'root', 'extension', 'node_modules'))) problems.push(`SDK binary package present: ${p}`);
  for (const p of findClaudeExecutables(join(coreDir, 'root'))) problems.push(`claude executable present: ${p}`);
  return problems;
}

export const sdkBinaryAllowed = () => process.env.LLMIDE_STAGE_ALLOW_SDK_BINARY === '1';
