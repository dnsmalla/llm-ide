// The command bus registry (schema/bus/registry.json, byte-identical copy beside this file) and the PURE tier gate.
// No I/O besides reading the JSON once. The gate is the one place that decides what a client class may start; the Mac's
// tier gate can read the same JSON and the same fixtures (schema/bus/fixtures/tiers).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REGISTRY = JSON.parse(readFileSync(fileURLToPath(new URL('./registry.json', import.meta.url)), 'utf8'));
export const COMMAND_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL('./command.schema.json', import.meta.url)), 'utf8'));
export const LIMITS = REGISTRY.limits;
export const CLIENT_CLASSES = Object.keys(REGISTRY.clientClasses);
export const kindInfo = (kind) => (Object.hasOwn(REGISTRY.kinds, kind) ? REGISTRY.kinds[kind] : null);
export const classInfo = (client) => (Object.hasOwn(REGISTRY.clientClasses, client) ? REGISTRY.clientClasses[client] : null);

/**
 * Receipt-time decision for `kind` started by `client`. Pure.
 * `flagEnabled`: the user's enable flag for the kind (set from the desktop only).
 * @returns {{ outcome: 'run'|'needs_approval'|'tier_denied'|'kind_not_allowed'|'unknown_kind'|'not_available', reason?: string }}
 */
export function decideReceipt({ client, kind, flagEnabled = false }) {
  const info = kindInfo(kind);
  if (!info) return { outcome: 'unknown_kind' };
  const cls = classInfo(client);
  // A kind may name the only client classes allowed to start it (custom.run: desktop-ui). Checked before the tier so every
  // other class gets the same answer, whatever its tier ceiling.
  if (Array.isArray(info.clients) && !info.clients.includes(client)) return { outcome: 'kind_not_allowed', reason: 'kind_clients' };
  if (!cls || !cls.mayStart.includes(info.tier)) return { outcome: 'tier_denied', reason: 'client_class' };
  if (!info.available) return { outcome: 'not_available' };
  const approval = REGISTRY.tiers[info.tier].approval;
  if (approval === 'desktop' || approval === 'desktop_confirm') return { outcome: 'needs_approval', reason: 'tier' };
  // A read-only auto-task kind starts without a click only when its enable flag is on, or when the desktop itself asks.
  if (info.tier === 'T0' && client !== 'desktop-ui' && !flagEnabled) return { outcome: 'needs_approval', reason: 'switch_off' };
  return { outcome: 'run' };
}

/** May this client class approve a pending command? Only a class marked mayApprove. */
export const mayApprove = (client) => classInfo(client)?.mayApprove === true;
