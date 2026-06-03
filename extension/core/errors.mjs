// Standardized error envelope.  Every error response from /kb/* and
// the legacy non-/kb routes uses this shape:
//
//   { error: { code: string, message: string, details?: unknown } }
//
// `code` is a stable machine-readable identifier (e.g. AUTH_REQUIRED,
// VALIDATION_FAILED, GUARDRAIL_FAILED) that the client can switch on
// without parsing prose.  `message` is human-readable.  `details` is
// optional and only included for codes that carry structured info
// (e.g. the guardrail report on GUARDRAIL_FAILED).
//
// AppError is the only exception type we throw inside route handlers;
// it serializes through `sendError` without leaking stacks.  Anything
// else that escapes is treated as an INTERNAL_ERROR and logged at
// error level so it shows up in monitoring without being silenced.

export class AppError extends Error {
  constructor(code, message, { status = 400, details, cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

// Common factories — name parity with the codes the client matches on.

export const errAuth = (msg = 'Authentication required') =>
  new AppError('AUTH_REQUIRED', msg, { status: 401 });

export const errForbidden = (msg = 'Forbidden') =>
  new AppError('FORBIDDEN', msg, { status: 403 });

export const errNotFound = (what = 'Resource') => {
  // Caller may pass either a noun ("Plan") or a phrase ("No route for X");
  // only append " not found" when the noun form would otherwise read awkwardly.
  const msg = /\bnot found\b/i.test(what) ? what : `${what} not found`;
  return new AppError('NOT_FOUND', msg, { status: 404 });
};

export const errValidation = (msg, details) =>
  new AppError('VALIDATION_FAILED', msg, { status: 400, details });

export const errConflict = (msg) =>
  new AppError('CONFLICT', msg, { status: 409 });

export const errRateLimit = (retryAfterSec) =>
  new AppError('RATE_LIMITED', 'Too many requests', {
    status: 429,
    details: { retryAfterSec },
  });

export const errInternal = (msg = 'Internal error', details) =>
  new AppError('INTERNAL_ERROR', msg, { status: 500, details });

// Write the error response.  Logs once at the appropriate level so we
// never both log AND silently swallow.
export function sendError(res, err, { logger } = {}) {
  const isApp = err instanceof AppError;
  const status = isApp ? err.status : 500;
  const code = isApp ? err.code : 'INTERNAL_ERROR';
  const message = isApp ? err.message : 'Internal error';
  const body = { error: { code, message } };
  if (isApp && err.details !== undefined) body.error.details = err.details;

  if (logger) {
    if (status >= 500) {
      logger.error('request_failed', {
        code,
        message: err.message,
        stack: err.stack,
      });
    } else {
      logger.warn('request_rejected', { code, message: err.message });
    }
  }

  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
