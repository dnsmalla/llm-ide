// Parsing of the package spec inside an MCP server's `{command, args}`
// (`npx -y @scope/pkg@1.2.3`, `uvx mcp-server-git`). Pure: no I/O. Only
// `args[argIndex]` is ever rewritten, so every other argument is left alone.

import path from 'node:path';

export const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const PYPI_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const NPM_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const PYPI_VERSION_RE = /^\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?$/;
const TAG_RE = /^[a-z][a-z0-9-]*$/;
const NPM_NAME_MAX = 214;
const PYPI_NAME_MAX = 100;

export function isValidName(runner, name) {
  if (typeof name !== 'string') return false;
  if (runner === 'npx') return name.length <= NPM_NAME_MAX && NPM_NAME_RE.test(name);
  if (runner === 'uvx') return name.length <= PYPI_NAME_MAX && PYPI_NAME_RE.test(name);
  return false;
}

export function isValidVersion(runner, version) {
  if (typeof version !== 'string') return false;
  return (runner === 'npx' ? NPM_VERSION_RE : PYPI_VERSION_RE).test(version);
}

function isPackageFlag(runner, arg) {
  if (arg === '--package' || arg === '-p' || arg.startsWith('--package=')) return true;
  return runner === 'uvx' && (arg === '--from' || arg.startsWith('--from='));
}

function splitSpec(runner, spec) {
  // npx: the last '@' not at index 0 separates the version (index 0 is a scope).
  if (runner === 'npx') {
    const at = spec.lastIndexOf('@');
    return at > 0 ? [spec.slice(0, at), spec.slice(at + 1), true] : [spec, null, false];
  }
  const eq = spec.indexOf('==');
  if (eq > 0) return [spec.slice(0, eq), spec.slice(eq + 2), true];
  const at = spec.indexOf('@');
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1), true] : [spec, null, false];
}

/**
 * Locate the package spec in an npx/uvx launch.
 * @returns {{runner, name, version, tag, argIndex} | null}
 */
export function parseRunnerSpec({ command, args } = {}) {
  if (typeof command !== 'string' || !Array.isArray(args)) return null;
  const base = path.basename(command);
  if (base !== 'npx' && base !== 'uvx') return null;
  const runner = base;
  let argIndex = 0;
  while (argIndex < args.length && typeof args[argIndex] === 'string' && args[argIndex].startsWith('-')) {
    if (isPackageFlag(runner, args[argIndex])) return null;
    argIndex++;
  }
  const spec = args[argIndex];
  if (typeof spec !== 'string' || spec === '') return null;
  const [name, suffix, hasSuffix] = splitSpec(runner, spec);
  if (!isValidName(runner, name)) return null;
  if (!hasSuffix) return { runner, name, version: null, tag: null, argIndex };
  if (isValidVersion(runner, suffix)) return { runner, name, version: suffix, tag: null, argIndex };
  if (runner === 'npx' && TAG_RE.test(suffix)) return { runner, name, version: null, tag: suffix, argIndex };
  return null;
}

/** Copy of `args` with only the spec argument replaced by `name@version`. */
export function withVersion(parsed, { args }, version) {
  if (!isValidVersion(parsed.runner, version)) throw new Error('invalid version');
  const next = [...args];
  next[parsed.argIndex] = `${parsed.name}@${version}`;
  return next;
}
