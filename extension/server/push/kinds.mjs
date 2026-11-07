// The push kinds (push notifications plan): the desktop notifier's webview kinds (desktop/src-tauri/src/notify.rs
// Kind::from_webview), never update_ready or core_down (host-only facts with no meaning on a phone). A payload names a
// kind and a count only; the device builds the words from its own copy of the notify.rs table (web/public/sw-push.js,
// ios_app/MyApp/Supporting/Localizable.strings). tests/push-kinds.test.mjs keeps all four in step.
export const PUSH_KINDS = Object.freeze([
  'approval_chat', 'approval_job', 'loop_done', 'loop_failed', 'autotask_done', 'autotask_failed',
  'graph_done', 'graph_failed', 'docgen_done', 'docgen_failed', 'sync_attention',
]);
/** Kinds whose text names a count (notify.rs `if many`). */
export const COUNTED = new Set(['approval_chat', 'approval_job']);
export const isPushKind = (k) => typeof k === 'string' && PUSH_KINDS.includes(k);
const clampCount = (n) => (Number.isInteger(n) ? Math.min(Math.max(n, 1), 999) : 1);

/** The Web Push plaintext, encrypted before it leaves this process. */
export const webPayload = (kind, count) => JSON.stringify({ k: kind, n: clampCount(count) });

/** The APNs payload: a localized alert resolved by the app's Localizable.strings, so Apple sees a kind and a count only. */
export function apnsPayload(kind, count) {
  const n = clampCount(count);
  const many = COUNTED.has(kind) && n > 1;
  const alert = { title: 'LLM-IDE', 'loc-key': `PUSH_${kind.toUpperCase()}${many ? '_MANY' : ''}`, ...(many ? { 'loc-args': [n > 99 ? '99+' : String(n)] } : {}) };
  return JSON.stringify({ aps: { alert, sound: 'default' }, k: kind });
}
