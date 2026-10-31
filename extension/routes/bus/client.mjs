// Which client class is this request? (docs/spec/command-bus.md section 1.4 and docs/spec/command-bus.md "Client class".)
//
// The bearer token carries NO client claim (server/auth.mjs: userId, role, jti), and the desktop UI and the Chrome
// extension hold the same kind of token, so a token alone cannot tell them apart. Two advisory headers fill the gap:
//   x-llmide-client      the class the caller says it is (a registry client class)
//   x-llmide-host-nonce  proof that the caller is the HOST that spawned this core: it must equal LLMIDE_CORE_NONCE
//                        (the per-launch random nonce the host already passes to the core; 32-128 hex characters)
// Rules, all CAPPED so a remote origin can never raise its own tier:
//   - with host proof the host vouches for the declared class (the Mac host forwards its phone as `ios-native` and its
//     own UI as `desktop-ui`), so the declared class is used as is;
//   - without proof the declared class is capped at `extension`: it may declare a LOWER class, never a higher one, and
//     an absent or unknown header is `extension`;
//   - `relay-bridge` is not a class: a bridge declares the class of the real client behind it (with proof), so an
//     undeclared bridge is the lowest class;
//   - LLMIDE_CORE_NONCE unset (a standalone dev server) means nobody can prove host: `desktop-ui` is unreachable, so
//     nothing can be approved. The opt-in LLMIDE_BUS_TRUST_CLIENT_HEADER=1 treats the declared class as proven; it is
//     for loopback development and tests only, and /health does not advertise it.
import crypto from 'node:crypto';
import { REGISTRY, classInfo } from './registry.mjs';

const NONCE_RE = /^[0-9a-f]{32,128}$/;

function hostProven(req) {
  if (process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER === '1') return true;
  const want = process.env.LLMIDE_CORE_NONCE || '';
  const got = req.headers?.['x-llmide-host-nonce'];
  if (!NONCE_RE.test(want) || typeof got !== 'string' || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { return false; }
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
