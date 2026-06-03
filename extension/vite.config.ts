import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifestJson from './manifest.json';

// In production we use the strict CSP and empty WAR shipped in
// manifest.json. In `vite dev` mode crxjs serves its HMR client over
// ws://localhost:<port> and registers a refresh handler script; both
// are blocked by the production CSP / empty web_accessible_resources.
// Patch the manifest at config time so dev iteration works without
// loosening prod security.
export default defineConfig(({ mode }) => {
  const isDev = mode !== 'production';
  // Shallow clone so we don't mutate the JSON module export.
  const manifest = JSON.parse(JSON.stringify(manifestJson));
  if (isDev) {
    if (manifest.content_security_policy?.extension_pages) {
      manifest.content_security_policy.extension_pages =
        manifest.content_security_policy.extension_pages
          .replace(
            "connect-src ",
            "connect-src ws://localhost:* http://localhost:* ",
          );
    }
    // crxjs needs the HMR runtime / refresh stub web-accessible.
    // The wildcard host pattern matches every page so HMR fires
    // regardless of where the extension is exercised in dev.
    manifest.web_accessible_resources = [
      { resources: ['*'], matches: ['<all_urls>'], use_dynamic_url: true },
    ];
  }
  return {
    plugins: [
      react(),
      crx({ manifest }),
    ],
    build: {
      outDir: 'dist',
      sourcemap: false,           // never ship maps to end users
    },
  };
});
