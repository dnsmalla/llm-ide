export class HttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req, limit = 16 * 1024) {
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'json_required');
  const text = await readBody(req, limit);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json');
  return value;
}

// OAuth 2.0 token requests use the standard form encoding (RFC 6749 4.1.3); JSON is also accepted
// for the desktop client. Duplicate parameter detection stays with the caller.
export async function readForm(req, limit = 16 * 1024) {
  if (!/^application\/x-www-form-urlencoded(\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'form_required');
  }
  return new URLSearchParams(await readBody(req, limit));
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

// The OAuth authorize redirect is a top-level navigation to an already validated URI.
export function redirect(res, location) {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end();
}

// Marks a route a native client calls directly (OAuth token exchange, desktop registration): it may
// send no Origin, but a browser's foreign Origin is still refused (guard.checkOriginIfPresent).
export function nativeClient(handler) {
  handler.nativeClient = true;
  return handler;
}
