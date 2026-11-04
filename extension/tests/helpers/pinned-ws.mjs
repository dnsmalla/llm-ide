// Test-only pinned Host API client: TLS with no CA trust, accepted ONLY if the server's leaf SPKI hash
// equals `fingerprint`; then a raw WebSocket upgrade. Resolves {status, socket} or rejects 'pin_mismatch'.
import tls from 'node:tls';
import { fingerprintOfSpki } from '../../server/host-identity.mjs';

export function pinnedUpgrade({ port, fingerprint, origin, path = '/host-api/v1' }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'localhost' });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const spki = socket.getPeerX509Certificate().publicKey.export({ type: 'spki', format: 'der' });
      if (fingerprintOfSpki(spki) !== fingerprint) { socket.destroy(); return reject(new Error('pin_mismatch')); }
      socket.write([`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? [`Origin: ${origin}`] : []), '', ''].join('\r\n'));
      socket.once('data', (buf) => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.toString('latin1'))?.[1]), socket }));
    });
  });
}
