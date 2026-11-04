// Per-connection v1 phase gate and canonical command ids — the Node twin of the Mac's
// HostApiV1Session.swift / HostApiV1CommandIds.swift..
import { HOST_API_COMMANDS } from './commands.generated.mjs';

const refuse = (code, message) => ({ allow: false, code, message });
const ALLOW = Object.freeze({ allow: true });

export class HostApiSession {
  phase = { kind: 'awaitingHello' };

  greeted(clientName) { this.phase = { kind: 'awaitingAuth', clientName }; }

  // Only the pairing/token step may authenticate; from any other phase this is a no-op.
  authenticated(userId, deviceId) {
    if (this.phase.kind !== 'awaitingAuth') return;
    this.phase = { kind: 'authed', userId, deviceId, clientName: this.phase.clientName };
  }

  get deviceId() { return this.phase.kind === 'authed' ? this.phase.deviceId : null; }
  get userId() { return this.phase.kind === 'authed' ? this.phase.userId : null; }

  gate(command, served) {
    switch (this.phase.kind) {
      case 'awaitingHello':
        return command === 'host.hello' ? ALLOW : refuse('auth_failed', 'Send host.hello first.');
      case 'awaitingAuth':
        if (command === 'host.auth.pair' || command === 'host.auth.token' || command === 'host.ping') return ALLOW;
        if (command === 'host.hello') return refuse('denied', 'This connection already sent host.hello.');
        return refuse('auth_failed', 'Pair or authenticate first.');
      default: {
        if (command === 'host.auth.pair' || command === 'host.auth.token') return refuse('denied', 'This connection is already authenticated.');
        if (command === 'host.hello') return refuse('denied', 'This connection already sent host.hello.');
        const capability = HOST_API_COMMANDS[command]?.capability;
        return capability && served.has(capability) ? ALLOW : refuse('capability_unavailable', `This Mac does not serve ${capability ?? command} right now.`);
      }
    }
  }
}

export const helloRefusal = (apiVersions) => (apiVersions.includes(1) ? null : 'This Mac speaks Host API version 1 only.');

const PREFIX = 'h1.';
export const internalId = (session, external) => `${PREFIX}${session}.${external}`;

export function parseId(id) {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  const seg = rest.slice(0, dot);
  if (!/^(0|[1-9][0-9]*)$/.test(seg)) return null;
  const session = Number(seg);
  const external = rest.slice(dot + 1);
  // Canonical only: the id must round-trip (rejects "h1.007.x", unsafe-integer overflow).
  if (!external || internalId(session, external) !== id) return null;
  return { session, external };
}

export const isV1Id = (id) => parseId(id) !== null;
