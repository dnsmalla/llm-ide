// Shared decode helpers for untrusted values (host/core replies, stored JSON).
// Pure and dependency-free so node tests can import it directly.

/** True for a plain JSON object: not null, not an array. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
