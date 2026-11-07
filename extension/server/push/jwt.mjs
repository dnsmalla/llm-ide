// ES256 compact JWS (ECDSA P-256 + SHA-256, raw r||s signature) for VAPID (RFC 8292) and APNs provider tokens.
import crypto from 'node:crypto';

const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function es256Jwt(header, claims, key) {
  const input = `${part({ ...header, alg: 'ES256' })}.${part(claims)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
