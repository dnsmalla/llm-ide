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
- [ ] Settings → **Forget this desktop** asks first, then returns to pairing and the token is gone.
- [ ] Resize to phone width; the composer and cards remain usable.
- [ ] Install the app from the browser's install control; it opens in its own window.
- [ ] Stop the web server and reopen the installed app: the shell loads and shows an offline state, not a blank page.
- [ ] Reconnect the host and reload: pairing/chat work again.

## 3b. Navigation, theme and layout (the app shell)

Run at a laptop width (at least 1100px) and again on an iPhone installed to the home screen (or a 390px-wide window).

- [ ] At 900px or wider there is a left sidebar (Ask, Execute, Auto Tasks, Loop, History, Settings); below 900px it becomes a bottom tab bar
      that clears the home indicator. No horizontal scroll at 360px.
- [ ] The active section is highlighted and read as the current page by a screen reader (aria-current). Tab reaches the nav, header and
      content in that order; **Skip to content** appears on the first Tab.
- [ ] The URL hash follows the section (`#/ask`, `#/history`, `#/settings/sources`). Reload on each: you land on the same screen. Back and
      Forward move between sections. An unknown hash falls back to Ask.
- [ ] Execute, Auto Tasks and Loop show their "coming next" page. Against a host without `read` (or without `tool_approvals`) those
      sections are absent from the nav. Against a hub, nothing offline-sync shows in Settings.
- [ ] The header shows the desktop name, the project picker and one pill: **Live**; **Reconnecting…** (stop the desktop); **Waiting for the desktop**
      (stop it mid-reply); the pill is announced when it changes. The offline copy page shows **Offline copy**.
- [ ] Settings → Appearance: System, Dark, Light, Midnight each repaint at once. Reload: the choice is kept. System follows the device
      (switch the OS between light and dark). With site data blocked, the choice still works for the session.
- [ ] Ask: Enter sends, Shift+Enter adds a line, the box grows to about seven lines. Scroll up during a reply: **Jump to latest** appears and
      works. A code block scrolls sideways (not the page) and **Copy** copies it. The empty chat shows three example prompts; one fills the box.
- [ ] Switch Ask to History and back: the unsent draft is still there.
- [ ] On iPhone: the keyboard does not hide the composer; the status bar and notch do not overlap the header; text stays readable in all
      three themes (no low-contrast grey on grey).
- [ ] Turn **Reduce Motion** on (OS setting): the pulsing status dot, shimmer and sheet slide stop.
- [ ] Settings → Change address opens a sheet: Esc and the backdrop close it, Tab stays inside it, focus returns to the button.

Dev only: `npm run dev`, then open `http://127.0.0.1:5180/#/__gallery` for every screen from fixtures
(`#/__gallery/<screen>?theme=light|dark|midnight&w=360`). It is not in the production build.

## 4. Domain check (later)

Build with `VITE_HOST_API_URL=wss://<host>:<port>/host-api/v1`, serve `dist`
over HTTPS, add the exact `https://<domain>` origin to the host's
`LLMIDE_HOST_API_WEB_ORIGINS`, and repeat the checks above. The browser must
trust the host's certificate; a self-signed certificate needs a manual trust
step. Chromium's Private Network Access rules may also block an HTTPS page
from reaching a LAN/loopback host.

## Read views (desktop core started with LLMIDE_HOST_API_READ=1, browser paired AFTER the switch)

Start the core yourself (`cd extension && LLMIDE_HOST_API_READ=1 npm run server`, with your `LLMIDE_DATA_DIR`) before the desktop app, which adopts it: a core the app starts never gets the switch, and then no panel appears.

- History shows Usage (one line per model) and Chats; the phone chat, the one you can send into, reads "(live chat)".
- Opening a chat shows "Read-only", no composer; Show older pages back; Back returns to the phone chat.
- A browser paired before the switch shows no panel (it must re-pair).
- History opens a past chat read-only; Back returns to the list. The live chat stays in Ask, so a running reply and its approval cards are unaffected.

## Offline sync (MEGA) — once, with a throwaway dedicated MEGA account (2FA off)

1. Desktop: set up sync with the dedicated account (Settings → sync), sync on. Start the desktop with
   `LLMIDE_SYNC_WEB_ORIGIN=http://127.0.0.1:5180`. Build and `npm start` this client.
2. Desktop: Add a phone or browser → Browser → open the link in the browser.
   - [ ] The address bar shows no `#pair=`; Back does not bring it back.
3. Enter a name, the MEGA email and password → Continue.
   - [ ] The same 6 digits show on both screens; press Codes match on the desktop; the browser shows the snapshot.
   - [ ] DevTools console: no CSP violations. If a MEGA host is blocked, note the exact host (design decision D1).
   - [ ] DevTools Network: the requests to `*.userstorage.mega.co.nz` succeed, with no "blocked by CORS policy" error.
     If they fail, MEGA's transfer hosts do not allow browser access: record it (README "Known risk"); the browser tier
     then needs a download proxy.
4. DevTools → Application:
   - [ ] IndexedDB `llmide-sync` → `device`: the CryptoKey entries show `extractable: false`.
   - [ ] Nothing in IndexedDB, localStorage or sessionStorage contains the MEGA password.
5. Quit the desktop. Reload the page → Unlock with the password.
   - [ ] "Desktop last seen …" shows; after 45 minutes the "Desktop offline or storage withholding updates" banner shows.
   - [ ] Queue a prompt; it is listed as waiting.
6. Start the desktop again.
   - [ ] Within about a minute the answer appears; with Host API paired, the live chat replaces the sync view.
7. DevTools → Network → Offline: the offline banner shows; back online: it checks at once.
8. Desktop: revoke this browser. - [ ] The browser shows "This browser was removed from sync".
9. Keyboard only, then VoiceOver: pairing form, the code (read as single digits), unlock, the inbox, meetings and plans.
10. iPhone, installed to the home screen: the installed app cannot receive an opened link (its storage is separate from
    Safari). - [ ] Copy the link from the desktop, paste it into the installed app's Pairing screen, and pairing works.

## 5. Documents and code (direct reads)

Needs a GitLab application and a Box Custom App set up as in docs/how-to/read-box-gitlab-on-phone-and-web.md, with
`http://127.0.0.1:5180` in the Box app's CORS Domains and the `/oauth-callback.html` redirect URI registered.

- [ ] Pairing screen → **Open documents and code**. Save the GitLab Application ID, **Sign in to GitLab**: a pop-up
      opens, GitLab asks for `read_api` and `read_repository` only, the pop-up closes, the card says signed in.
- [ ] Browse a project, open a folder, open a `.ts` file (plain text), a `.md` file (rendered, no images), a `.png`
      ("not shown"). Search inside the project. **Open on GitLab** opens a new tab.
- [ ] Box: save Client ID + secret, sign in (the consent screen shows read access only). Open a `.md`, a `.docx`
      (extracted text), a `.pdf` (**Save PDF** downloads it). DevTools shows no CSP violation, and the `.md` download
      redirect to `dl.boxcloud.com` succeeds (this is the browser CORS check the curl preflight could not make).
- [ ] Reload the page: both providers say "Set up. Sign in to browse." (tokens were in memory only).
- [ ] DevTools → Application: `localStorage` and `sessionStorage` hold no token; IndexedDB `llmide-sources` holds only
      the IDs and the Box secret.
- [ ] Turn the network off: the offline banner shows and Search is disabled.
- [ ] A screen reader announces the breadcrumbs ("Location"), the status line, and the file heading when a file opens.
