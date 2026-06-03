// QA-result connector.  Parses JUnit-style XML (the lingua franca for
// pytest, jest, go test, mvn surefire, ctest, etc.) into one row per
// failing/erroring test and aggregate rows for passing suites.  We only
// keep the body of failures — passing tests bloat the index and add
// nothing for a planner trying to spot regressions.
//
// Pure regex parsing: we deliberately avoid bundling an XML parser to
// stay zero-dep.  JUnit's flat schema (testsuite > testcase) makes this
// reliable enough for the typical CI dump.

import { ingestSources, deleteSourcesByPrefix } from '../kb/db.mjs';

// Two passes — self-closing first, then open/close — so we don't have
// to fight regex alternation greediness when both forms appear in the
// same suite.
const TESTCASE_SELF_RE = /<testcase\b([^>]*?)\/>/g;
const TESTCASE_OPEN_RE = /<testcase\b([^>]*[^/])>([\s\S]*?)<\/testcase>/g;
const FAILURE_RE  = /<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/;
const ATTR_RE     = /(\w[\w:-]*)\s*=\s*"([^"]*)"/g;

function parseAttrs(s) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseJUnit(xml) {
  const cases = [];
  const pushCase = (attrStr, inner) => {
    const attrs = parseAttrs(attrStr || '');
    const name = attrs.name || 'unknown';
    const classname = attrs.classname || attrs.class || '';
    const time = Number(attrs.time || 0) || 0;
    const fail = inner ? inner.match(FAILURE_RE) : null;
    cases.push({
      name,
      classname,
      time,
      status: fail ? fail[1] : 'pass',
      failureType: fail ? parseAttrs(fail[2] || '').type || null : null,
      message:    fail ? parseAttrs(fail[2] || '').message || '' : '',
      detail:     fail ? decodeXml(fail[3] || '') : '',
    });
  };

  // Strip self-closing matches first so the open/close pass can't span
  // across them (a self-closing tag has no body to claim).
  let stripped = xml;
  TESTCASE_SELF_RE.lastIndex = 0;
  let m;
  while ((m = TESTCASE_SELF_RE.exec(xml)) !== null) {
    pushCase(m[1], '');
  }
  stripped = xml.replace(TESTCASE_SELF_RE, '');

  TESTCASE_OPEN_RE.lastIndex = 0;
  while ((m = TESTCASE_OPEN_RE.exec(stripped)) !== null) {
    pushCase(m[1], m[2]);
  }
  return cases;
}

const MAX_XML_BYTES = 10 * 1024 * 1024; // 10 MB — reject oversized payloads

// Index a JUnit XML payload.  `source` is a label that becomes the ref
// prefix — typically the CI run id or filename — so re-indexing a newer
// run for the same `source` replaces the previous rows.
export function indexJUnit(userId, { xml, source = 'qa-run', type } = {}) {
  // Validate `type` when provided — must be a primitive string, not an object.
  if (type !== undefined && (typeof type !== 'string')) {
    throw new Error('indexJUnit: type must be a string');
  }
  // Validate `source` when provided — must be a string.
  if (source !== undefined && typeof source !== 'string') {
    throw new Error('indexJUnit: source must be a string');
  }
  // XML size cap — a multi-MB blob can stall the sync regex parser and
  // exhaust memory; 10 MB is well above any realistic JUnit report size.
  if (typeof xml === 'string' && xml.length > MAX_XML_BYTES) {
    throw new Error(`indexJUnit: XML input too large (${xml.length} bytes > ${MAX_XML_BYTES} byte limit)`);
  }
  const cases = parseJUnit(xml);
  const safeSource = String(source).slice(0, 200).replace(/[^\w./-]+/g, '_');
  deleteSourcesByPrefix(userId, 'qa', `${safeSource}::`);

  const items = cases.map((c) => {
    const ref = `${safeSource}::${c.classname}::${c.name}`;
    const failed = c.status !== 'pass';
    const title = failed
      ? `FAIL ${c.classname ? `${c.classname}.` : ''}${c.name}`
      : `pass ${c.classname ? `${c.classname}.` : ''}${c.name}`;
    // Indexing every passing case is a lot of noise; we keep them but
    // with empty body so they only surface in stats / aggregate views.
    const body = failed
      ? [c.message, c.detail].filter(Boolean).join('\n').slice(0, 20_000)
      : '';
    return {
      kind: 'qa',
      ref,
      chunkIdx: 0,
      title,
      body,
      meta: {
        source: safeSource,
        classname: c.classname,
        name: c.name,
        status: c.status,
        failureType: c.failureType,
        durationSec: c.time,
      },
    };
  });

  const written = ingestSources(userId, items);
  const failed = items.filter((i) => i.meta.status !== 'pass').length;
  return { source: safeSource, total: items.length, failed, chunks: written };
}

