// Byte budgets for a multi-part live finalize. The part count and line cap bound the shape, but a
// part can still be a full 8 MB request body; bound the bytes per user and for the process too.
export const MAX_PENDING_FINALIZE_BYTES_PER_USER = 32 * 1024 * 1024;
export const MAX_PENDING_FINALIZE_BYTES_TOTAL = 128 * 1024 * 1024;

export function finalizeBytes(captions) {
  try { return Buffer.byteLength(JSON.stringify(captions)); } catch { return Number.POSITIVE_INFINITY; }
}

/** null = fits; 'per_user' | 'total' = refused. */
export function byteCapRefusal(userUsed, totalUsed, add) {
  if (userUsed + add > MAX_PENDING_FINALIZE_BYTES_PER_USER) return 'per_user';
  if (totalUsed + add > MAX_PENDING_FINALIZE_BYTES_TOTAL) return 'total';
  return null;
}
