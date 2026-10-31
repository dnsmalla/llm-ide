// Which client class is this request? (docs/spec/command-bus.md section 1.4 and "Client class".)
//
// The bearer token carries NO client claim (server/auth.mjs: userId, role, jti), and the desktop UI and the Chrome
// extension hold the same kind of token, so a token alone cannot tell them apart. Two advisory headers fill the gap:
//   x-llmide-client      the class the caller says it is (a registry client class)
//   x-llmide-host-nonce  proof that the caller is the HOST that spawned this core: it must equal
//                        HMAC-SHA256(LLMIDE_HOST_APPROVAL_KEY, "bus-host-proof/v1") (core/host-approval.mjs busHostProof).
//                        It is a secret DERIVED from the approval key. It is NOT LLMIDE_CORE_NONCE: that nonce is served
//                        unauthenticated on GET /health (identity echo for the host), so it is never accepted as proof.
// Rules, all CAPPED so a remote origin can never raise its own tier:
//   - with host proof the host vouches for the declared class (the Mac host forwards its phone as `ios-native` and its
//     own UI as `desktop-ui`), so the declared class is used as is;
//   - without proof the declared class is capped at `extension`: it may declare a LOWER class, never a higher one, and
//     an absent or unknown header is `extension`;
//   - `relay-bridge` is not a class: a bridge declares the class of the real client behind it (with proof), so an
//     undeclared bridge is the lowest class;
//   - LLMIDE_HOST_APPROVAL_KEY unset or malformed (a standalone dev server): nobody can prove host, `desktop-ui` is
//     unreachable, so nothing can be approved. The opt-in LLMIDE_BUS_TRUST_CLIENT_HEADER=1 treats the declared class as
//     proven; it is for loopback development and tests only, /health does not advertise it, and it is REFUSED when the
//     server is bound to a non-loopback address or NODE_ENV=production.
import { REGISTRY, classInfo } from './registry.mjs';
import { verifyBusHostProof } from '../../core/host-approval.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** True when the trust-the-header escape hatch may be honoured at all: loopback bind, not production. */
export function trustClientHeaderAllowed(env = process.env) {
  if (env.LLMIDE_BUS_TRUST_CLIENT_HEADER !== '1') return false;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return false;
  const host = String(env.LLMIDE_HOST || '127.0.0.1').trim().toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

function hostProven(req) {
  if (trustClientHeaderAllowed()) return true;
  return verifyBusHostProof(req);
}

/** @returns {{ client: string, declared: string|null, proven: boolean }} */
export function resolveClient(req) {
  const raw = req.headers?.['x-llmide-client'];
  const declared = typeof raw === 'string' && classInfo(raw.trim()) ? raw.trim() : (raw === 'relay-bridge' ? 'relay-bridge' : null);
  const proven = hostProven(req);
  const rank = (c) => classInfo(c)?.rank ?? 1;
  if (declared === 'relay-bridge') return { client: 'phone-pwa', declared, proven };
  if (!declared) return { client: 'extension', declared, proven };
  if (proven) return { client: declared, declared, proven };
  const capped = rank(declared) <= rank('extension') ? declared : 'extension';
  return { client: capped, declared, proven };
}

export const CLIENT_CLASS_IDS = Object.keys(REGISTRY.clientClasses);
