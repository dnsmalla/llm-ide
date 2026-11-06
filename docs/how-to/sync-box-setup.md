# Box sync setup

1. **What it does.** With the desktop off, the phone and web app read the last encrypted snapshot and queue chat prompts. Box holds ciphertext only.
2. **Before you start.** Make a Box account only for LLM-IDE (free, 10 GB). Box has no single-folder access, so every phone or browser you add can read and write that whole Box account.
3. **Create the Box app.** Box developer console → Create Platform App / Custom App → User Authentication (OAuth 2.0). Scope: "Read and write all files and folders stored in Box". Redirect URIs: `http://127.0.0.1/kb/sync/box/callback`, `https://<pwa-origin>/box-callback.html`, and `llmide-box://oauth` (if Box refuses the custom scheme, use only the https one). CORS domain: `https://<pwa-origin>`. Copy the client ID and secret.
4. **Desktop.** Settings → Phone and web sync → Storage: Box → paste the ID and secret → Connect Box → approve in the browser. Sync on when the card says connected.
5. **Add a phone or browser.** The pairing code carries the Box app ID and secret; keep it out of view. Each device signs in to Box once (the browser once per session).
6. **Where secrets live.** Desktop vault: client secret and refresh token. iPhone Keychain, this device only. Browser: tokens in memory, app ID and secret in site data. Nothing in logs.
7. **Limits and upkeep.** Box refresh tokens expire after 60 days unused; use Settings → Connect Box again. Rate limit: 1000 calls/min; sync uses about 30.
8. **Revoke.** Remove the device in Settings (deletes its folder), revoke the app in Box Account Settings → Apps, or reset the client secret and re-pair every device.
9. **Switching storage (MEGA ↔ Box)** removes paired devices and deletes the old storage's sync files. Pair again.
10. **Live test (developers).** See the header of `extension/tests/sync-store-box.test.mjs`; set `LLMIDE_SYNC_BOX_IT=1` and use a throwaway account.
