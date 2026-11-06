// The /sync/ locations of deploy/vps/llm-ide.com.nginx, emulated over the directory the SFTP store writes (nginx alias
// /srv/llmide-sync/data/ = <fake sftp root>/data). The location regexes are read from the vhost file itself, first match
// wins as in nginx. GET serves only allow-listed files (absent → null). PUT writes only allow-listed files into folders
// that already exist (create_full_put_path off → 409) and refuses bodies over 64 KiB (413). A request no location
// allows throws NGINX_DENIED, so a test fails loudly where real nginx would answer a quiet 404.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VHOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/vps/llm-ide.com.nginx');
const PUT_MAX = 65536; // client_max_body_size 64k (asserted against the vhost in sync-own-server.test.mjs)
const denied = (method, p) => Object.assign(new Error(`nginx: no ${method} location for /sync/${p}`), { code: 'NGINX_DENIED' });

export const vhostText = () => fs.readFileSync(VHOST, 'utf8');

export function syncLocations(text = vhostText()) {
  return [...text.matchAll(/location ~ "(\^\/sync\/[^"]+)" \{([\s\S]*?)\n {4}\}/g)]
    .map((m) => ({ re: new RegExp(m[1]), method: /limit_except (GET|PUT) /.exec(m[2])?.[1] ?? null, body: m[2] }));
}

export function createFakeNginx(dataDir, { locations = syncLocations() } = {}) {
  const log = [];
  const route = (p) => locations.find((l) => l.re.test(`/sync/${p}`)) ?? null;
  return {
    log,
    async get(p) {
      const loc = route(p);
      log.push(['GET', p]);
      if (loc?.method !== 'GET') throw denied('GET', p);
      try { return fs.readFileSync(path.join(dataDir, p)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async put(p, bytes) {
      const loc = route(p);
      log.push(['PUT', p]);
      if (loc?.method !== 'PUT') throw denied('PUT', p);
      if (bytes.length > PUT_MAX) throw Object.assign(new Error('nginx 413'), { code: 'SYNC_TOO_LARGE' });
      const file = path.join(dataDir, p);
      if (!fs.existsSync(path.dirname(file))) throw Object.assign(new Error(`nginx 409 /sync/${p}`), { code: 'SYNC_MISSING' });
      fs.writeFileSync(file, bytes);
    },
  };
}
