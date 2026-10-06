// Where each plugin was installed from (git / marketplace / zip), so the Mac
// can check for updates. The server NEVER fetches these URLs; it only records
// what the install route was handed and validates it hard, because the Mac
// later passes these values to git.
//
// File: <pluginDir>/../plugin-sources.json   Shape: { [pluginName]: source }
// Kept outside the plugin directory on purpose: a plugin package cannot ship
// its own record. Writes are atomic (tmp + rename), mode 0o600.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultPluginDir } from './loader.mjs';
import { logger } from '../core/logger.mjs';

const KINDS = new Set(['git', 'marketplace', 'zip']);
const MAX_URL = 512;
const MAX_PATH = 256;
const MAX_VERSION = 64;
const MAX_FILE_NAME = 255;
const MAX_HEADER_BYTES = 2048;

const REF_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ENTRY_RE = /^[a-z][a-z0-9-]{1,40}$/;
const SCP_URL_RE = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UNSAFE_CHARS_RE = /[\s\u0000-\u001f\u007f]/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;

function isString(value) { return typeof value === 'string'; }

const SCP_PARTS_RE = /^git@([^:]+):(.+)$/;
const SCP_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Hosts that point at this machine or a private network are refused: the Mac
// hands these URLs to git, so they must not become an SSRF/local-access door.
function publicHostName(rawHost) {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || IPV4_RE.test(host)) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  return true;
}

function validScpUrl(url) {
  const match = SCP_PARTS_RE.exec(url);
  if (!match) return false;
  const [, host, repoPath] = match;
  if (!SCP_HOST_RE.test(host)) return false;
  // Normalize like the https path so numeric forms (127.1, 2130706433, 0x7f000001)
  // resolve to what they really are before the host checks run.
  let normalized;
  try { normalized = new URL(`https://${host}`).hostname; } catch { return false; }
  const lastLabel = host.replace(/\.$/, '').split('.').pop();
  if (/^\d+$/.test(lastLabel) || /^0x[0-9a-f]+$/i.test(lastLabel)) return false;
  if (!publicHostName(host) || !publicHostName(normalized)) return false;
  return !repoPath.startsWith('-') && !repoPath.split('/').includes('..');
}

function validUrl(url) {
  if (!isString(url) || !url || url.length > MAX_URL || UNSAFE_CHARS_RE.test(url)) return false;
  if (SCP_URL_RE.test(url)) return validScpUrl(url);
  if (url.includes('?') || url.includes('#')) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return false;
  // Credentials must never be persisted or listed.
  if (parsed.username || parsed.password) return false;
  return publicHostName(parsed.hostname);
}

function validRef(ref) {
  return isString(ref) && REF_RE.test(ref) && !ref.startsWith('-');
}

function validPath(path) {
  if (!isString(path) || !path || path.length > MAX_PATH || path.startsWith('/')) return false;
  if (UNSAFE_CHARS_RE.test(path) || path.includes('\\')) return false;
  // Empty segments cover a trailing '/' and '//'; '.' and '..' cover traversal.
  return !path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

function validVersion(version) {
  return isString(version) && version.length <= MAX_VERSION && PRINTABLE_ASCII_RE.test(version);
}

function validFileName(name) {
  return isString(name) && name.length > 0 && name.length <= MAX_FILE_NAME
    && PRINTABLE_ASCII_RE.test(name) && !name.includes('/');
}

/**
 * Validate a provenance record and return a normalized copy holding only the
 * keys allowed for its kind. `ref` is kept only when present (null allowed).
 */
export function validateSource(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'source must be an object' };
  const { kind } = obj;
  if (!KINDS.has(kind)) return { ok: false, error: 'invalid kind' };
  if (kind === 'zip') {
    if (!validFileName(obj.fileName)) return { ok: false, error: 'invalid fileName' };
    return { ok: true, source: { kind, fileName: obj.fileName } };
  }
  if (!validUrl(obj.url)) return { ok: false, error: 'invalid url' };
  if (!isString(obj.commit) || !SHA_RE.test(obj.commit)) return { ok: false, error: 'invalid commit' };
  const source = { kind, url: obj.url };
  if (obj.ref !== undefined) {
    if (obj.ref !== null && !validRef(obj.ref)) return { ok: false, error: 'invalid ref' };
    source.ref = obj.ref;
  }
  source.commit = obj.commit;
  if (kind === 'marketplace') {
    if (!isString(obj.entry) || !ENTRY_RE.test(obj.entry)) return { ok: false, error: 'invalid entry' };
    if (!validPath(obj.path)) return { ok: false, error: 'invalid path' };
    if (!isString(obj.tree) || !SHA_RE.test(obj.tree)) return { ok: false, error: 'invalid tree' };
    source.entry = obj.entry;
    source.path = obj.path;
    source.tree = obj.tree;
    if (obj.version !== undefined) {
      if (!validVersion(obj.version)) return { ok: false, error: 'invalid version' };
      source.version = obj.version;
    }
  }
  return { ok: true, source };
}

/**
 * Decode the base64url(JSON) provenance header. Missing/empty means "no
 * provenance supplied" (ok, source null).
 */
export function decodeSourceHeader(value) {
  if (value === undefined || value === null || value === '') return { ok: true, source: null };
  if (!isString(value) || !BASE64URL_RE.test(value) || value.length > Math.ceil(MAX_HEADER_BYTES * 4 / 3) + 4) {
    return { ok: false, error: 'invalid source header' };
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > MAX_HEADER_BYTES) return { ok: false, error: 'source header too large' };
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return { ok: false, error: 'invalid source header' }; }
  return validateSource(parsed);
}

function sourcesFilePath(pluginDir) {
  return join(dirname(pluginDir ?? defaultPluginDir()), 'plugin-sources.json');
}

export function readSources(pluginDir) {
  const path = sourcesFilePath(pluginDir);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch (err) {
    logger.warn('plugin-sources.json unreadable; treating as empty', { path, error: err.message });
    return {};
  }
  logger.warn('plugin-sources.json has unexpected shape; treating as empty', { path });
  return {};
}

function writeSources(sources, pluginDir) {
  const path = sourcesFilePath(pluginDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(sources, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function getSource(name, pluginDir) {
  if (!isString(name)) return null;
  const all = readSources(pluginDir);
  return Object.hasOwn(all, name) && all[name] && typeof all[name] === 'object' ? all[name] : null;
}

export function setSource(name, source, pluginDir) {
  if (!isString(name) || !name) return;
  const all = readSources(pluginDir);
  all[name] = { ...source, installedAt: new Date().toISOString() };
  writeSources(all, pluginDir);
}

export function removeSource(name, pluginDir) {
  if (!isString(name)) return;
  const all = readSources(pluginDir);
  if (!Object.hasOwn(all, name)) return;
  delete all[name];
  writeSources(all, pluginDir);
}

/**
 * Drop records whose plugin is no longer installed. A plugin folder can vanish
 * or be overwritten outside the install route; a stale record would later
 * offer an "update" that replaces the wrong thing.
 */
export function pruneSources(installedNames, pluginDir) {
  const all = readSources(pluginDir);
  let changed = false;
  for (const name of Object.keys(all)) {
    if (!installedNames.has(name)) { delete all[name]; changed = true; }
  }
  if (changed) writeSources(all, pluginDir);
}
