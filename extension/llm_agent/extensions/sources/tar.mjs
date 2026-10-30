// A small, strict reader for the gzip'd tar a GitHub archive is. It never
// touches the disk: it returns the regular files in memory so the caller can
// inspect and scan them first, and refuses anything that could escape a target
// directory or exhaust memory.
//
//   - links, devices, fifos are skipped (never created), and reported;
//   - a path that is absolute, has a `..`, a backslash, a control character, is
//     too long or too deep rejects the WHOLE archive (a hostile one);
//   - caps: compressed size, unpacked size, file count, size of one file.
//
// Only what git archive produces is understood: ustar, pax (x/g) and GNU long
// names (L). Anything else in a header is rejected as a bad archive.

import zlib from 'node:zlib';

export class ArchiveError extends Error {
  constructor(code, message) { super(message); this.name = 'ArchiveError'; this.code = code; }
}

export const ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 10 * 1024 * 1024,
  unpackedBytes: 40 * 1024 * 1024,   // tar stream incl. headers and padding
  totalFileBytes: 25 * 1024 * 1024,  // sum of the files we keep
  fileBytes: 2 * 1024 * 1024,        // one file; larger ones are skipped
  files: 3000,
  pathChars: 240,
  depth: 20,
});

const BLOCK = 512;
const CONTROL = /[\u0000-\u001f\u007f\\]/;

const cstr = (buf, off, len) => {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end === -1 || end > off + len ? off + len : end);
};

function octal(buf, off, len) {
  const s = cstr(buf, off, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new ArchiveError('bad_archive', 'unreadable tar header field');
  return parseInt(s, 8);
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(data.toString('ascii', i, sp), 10);
    if (!Number.isInteger(len) || len < 1 || i + len > data.length) throw new ArchiveError('bad_archive', 'bad pax record');
    const rec = data.toString('utf8', sp + 1, i + len).replace(/\n$/, '');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** The path inside the repository, or null for the root entry. Throws on an unsafe path. */
export function safeRelativePath(raw, limits = ARCHIVE_LIMITS) {
  if (typeof raw !== 'string' || !raw || raw.length > limits.pathChars || CONTROL.test(raw) || raw.startsWith('/')) {
    throw new ArchiveError('unsafe_path', 'the archive holds an unsafe path');
  }
  const segs = raw.split('/').filter((s, i, a) => s !== '' || i === a.length - 1);
  if (segs[segs.length - 1] === '') segs.pop();
  if (segs.length > limits.depth + 1) throw new ArchiveError('unsafe_path', 'the archive holds a path that is too deep');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..' || s.length > 255) throw new ArchiveError('unsafe_path', 'the archive holds an unsafe path');
  }
  const rest = segs.slice(1); // GitHub wraps everything in <repo>-<sha>/
  return rest.length ? rest.join('/') : null;
}

/**
 * @param {Buffer} gz
 * @returns {{ files: Map<string, Buffer>, skipped: Array<{ path: string, reason: string }>, totalBytes: number }}
 */
export function extractTarGz(gz, limits = ARCHIVE_LIMITS) {
  if (!Buffer.isBuffer(gz) || gz.length === 0) throw new ArchiveError('bad_archive', 'empty archive');
  if (gz.length > limits.compressedBytes) throw new ArchiveError('too_large', 'the archive is too large');
  let tar;
  try { tar = zlib.gunzipSync(gz, { maxOutputLength: limits.unpackedBytes }); } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw new ArchiveError('too_large', 'the archive unpacks to too much data');
    throw new ArchiveError('bad_archive', 'the archive is not a valid gzip file');
  }
  const files = new Map();
  const skipped = [];
  let total = 0;
  let pos = 0;
  let pax = null;
  let longName = null;
  while (pos + BLOCK <= tar.length) {
    const h = tar.subarray(pos, pos + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
    if (sum !== octal(h, 148, 8)) throw new ArchiveError('bad_archive', 'tar checksum mismatch');
    let name = cstr(h, 0, 100);
    if (cstr(h, 257, 5) === 'ustar') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    let size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const dataStart = pos + BLOCK;
    if (dataStart + size > tar.length) throw new ArchiveError('bad_archive', 'truncated archive');
    const data = tar.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g' || type === 'K') continue;
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (pax?.path) name = pax.path;
    if (longName) name = longName;
    if (pax?.size !== undefined) { const n = Number(pax.size); if (Number.isFinite(n) && n >= 0) size = n; }
    pax = null; longName = null;
    const rel = safeRelativePath(name, limits);
    if (rel === null || type === '5') continue;
    if (type !== '0' && type !== '7') { skipped.push({ path: rel, reason: type === '2' || type === '1' ? 'link' : 'special' }); continue; }
    if (rel.split('/').includes('.git')) continue;
    if (size > limits.fileBytes) { skipped.push({ path: rel, reason: 'too_large' }); continue; }
    if (files.size >= limits.files) throw new ArchiveError('too_large', 'the archive holds too many files');
    total += size;
    if (total > limits.totalFileBytes) throw new ArchiveError('too_large', 'the archive holds too much data');
    // A file and a directory of one name cannot both exist.
    files.set(rel, Buffer.from(data.subarray(0, size)));
  }
  for (const p of files.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (files.has(parts.slice(0, i).join('/'))) throw new ArchiveError('unsafe_path', 'the archive holds a file that is also a directory');
    }
  }
  return { files, skipped, totalBytes: total };
}
