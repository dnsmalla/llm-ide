# Web client — manual check

Run this once before calling the web client shipped. The automated tests cover
the protocol, UI render and origin policy; this covers the actual browser.

## 1. Start the desktop host

```bash
LLMIDE_HOST_API_DEV=1 \
LLMIDE_HOST_API_WEB_ORIGINS=http://127.0.0.1:5180 \
npm --prefix desktop run tauri dev
```

In the desktop app: **Settings → Host API pairing → Show pairing PIN**. Keep
the six digits, port and fingerprint/URL on screen.

## 2. Build and serve the web client

```bash
cd web
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:5180>.

## 3. Check

- [ ] The page loads with no console errors and no CSP violations.
- [ ] Enter the host URL shown by the desktop, then the PIN; pairing succeeds.
- [ ] Send a message; the reply streams and **Stop** cancels it.
- [ ] Clear history asks first, then the empty state returns.
- [ ] An AskUserQuestion renders its options; answering clears the card.
- [ ] If the host grants `tool_approvals`, a tool request shows **Allow once** /
      **Deny** and the answer clears the card.
- [ ] Reload the page: it reconnects with the stored token, without the PIN.
- [ ] Desktop **Revoke** on that browser: the page returns to pairing with the
      revoked notice.
- [ ] **Forget this host** returns to pairing and the token is gone.
- [ ] Resize to phone width; the composer and cards remain usable.
- [ ] Install the app from the browser's install control; it opens in its own window.
- [ ] Stop the web server and reopen the installed app: the shell loads and shows an offline state, not a blank page.
- [ ] Reconnect the host and reload: pairing/chat work again.

## 4. Domain check (later)

Build with `VITE_HOST_API_URL=wss://<host>:<port>/host-api/v1`, serve `dist`
over HTTPS, add the exact `https://<domain>` origin to the host's
`LLMIDE_HOST_API_WEB_ORIGINS`, and repeat the checks above. The browser must
trust the host's certificate; a self-signed certificate needs a manual trust
step. Chromium's Private Network Access rules may also block an HTTPS page
from reaching a LAN/loopback host.

## Read views (desktop core started with LLMIDE_HOST_API_READ=1, browser paired AFTER the switch)

Start the core yourself (`cd extension && LLMIDE_HOST_API_READ=1 npm run server`, with your `LLMIDE_DATA_DIR`) before the desktop app, which adopts it: a core the app starts never gets the switch, and then no panel appears.

- The panel shows Usage (one line per model) and Chats; the phone chat, the one you can send into, reads "(live chat)".
- Opening a chat shows "Read-only", no composer; Show older pages back; Back returns to the phone chat.
- A browser paired before the switch shows no panel (it must re-pair).
- While a past chat is open, a running reply's approval cards appear only after Back.
