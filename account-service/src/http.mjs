export class HttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export async function readJson(req, limit = 16 * 1024) {
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'json_required');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json');
  return value;
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
