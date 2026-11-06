# Sync SP7: direct reads of Box documents and GitLab code (web + iPhone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With the desktop off, the web app (`web/`) and the iPhone app (`ios_app/`) sign in to the user's own GitLab and Box with read-only OAuth, then browse GitLab projects and Box folders, open one file or document read-only, and search, all directly against gitlab.com and the Box API. Nothing passes through the sync store or the desktop.

**Architecture:** Each platform gets one small "sources" layer. It has four parts. (1) OAuth: authorization code + PKCE S256 with read-only scopes (`read_api read_repository` for GitLab, `root_readonly` for Box). The web opens a popup, and a static same-origin callback page hands the code back over `BroadcastChannel`. The iPhone uses `ASWebAuthenticationSession` with an `llmide-oauth://` callback. (2) One guarded GET: https only, to four exact hosts; a per-provider pace; a byte cap; 401 refreshes once; 429/202 honour `Retry-After`. (3) Two clients behind one `SourceClient` interface (`list` / `open` / `search` / `webUrl`). (4) Preview rules that decide how a file is shown: code and text as plain text, Markdown through the existing no-HTML Markdown view (web only), PDF via PDFKit on iOS or "Save PDF" on the web, Office documents via Box's `extracted_text`; everything else is "not shown". A React-free controller and one screen on the web, and a store plus SwiftUI views on iOS, sit on top.

**Tech Stack:** TypeScript 5.9 + React 19 (`web/`), WebCrypto `subtle.digest`, `BroadcastChannel`, IndexedDB, `node --test --experimental-strip-types` (Node 22); Swift 5.9, CryptoKit, `AuthenticationServices`, PDFKit, swift-testing (`ios_app/SharedProtocol`), SwiftUI (iOS 16 target).

**Spec:** `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` §9 (direct reads), §10 (rate limits), §14 (SP7 row), §15 Q11 (Box `root_readonly`) and Q12 (GitLab OAuth PKCE, `read_api` + `read_repository`, PAT only as fallback); ADR `docs/decisions/0020-box-encrypted-sync.md`; research memo `docs/superpowers/research/2026-11-05-offline-desktop-research.md` §3. Code read for shapes: `extension/connectors/box.mjs` (`isAllowedBoxUrl`, `boxGet`, `parseFolderItems`, `fetchExtractedText`, page-length end signal "B4"), `extension/routes/router.mjs` `/kb/repos/check-token` and `/kb/issues/*` (GitLab `api/v4`, project path encoding), `web/src/screens/SyncTier.tsx`, `web/src/sync/keystore.ts`, `ios_app/MyApp/Views/Control/SyncOfflineViews.swift`, `ios_app/MyApp/Services/SyncStore.swift` (`Keychain`), `ios_app/SharedProtocol/Sources/SharedProtocol/MegaClient.swift` (transport-injection pattern).

## Grounding (checked 2026-11-06)

- **gitlab.com CORS** (curl preflight from `Origin: https://llm-ide.com`, `Access-Control-Request-Headers: authorization`): `/api/v4/projects?membership=true`, `/projects/:id/repository/tree`, `/repository/files/:path/raw`, `/projects/:id/search?scope=blobs` all answer `access-control-allow-origin: *`, `access-control-allow-headers: authorization`, and `access-control-expose-headers` includes `X-Next-Page`. `/oauth/token` (POST, `content-type`) and `/oauth/revoke` answer `*`. **No proxy is needed for gitlab.com.**
- **Box CORS** (curl preflight): `api.box.com/2.0/folders/0/items`, `api.box.com/oauth2/token`, `dl.boxcloud.com/...` and `public.boxcloud.com/...` all answer `access-control-allow-origin: *`, `access-control-allow-headers: authorization`. A POST to `/oauth2/token` from a foreign origin returns `access-control-allow-origin: *` with `invalid_client`. Box docs: an origin that is not in the app's **CORS Domains** gets 403 `cors_origin_not_whitelisted`; with no domains set, every call fails (https://developer.box.com/guides/security/cors/).
- **GitLab OAuth PKCE** (https://docs.gitlab.com/api/oauth2/): PKCE works "without requiring access to the Client Secret", `code_challenge_method=S256`, and the verifier is 43–128 characters. The example `expires_in` is 7200. Refresh = `client_id&refresh_token&grant_type=refresh_token&redirect_uri`, and it rotates both tokens. Revoke is `/oauth/revoke`. Production redirect URIs must be HTTPS; HTTP is allowed in development. Preflight is supported on `/oauth/token`, `/oauth/revoke` and `/oauth/userinfo`. Apps that are not confidential (Confidential unticked) use PKCE with no secret.
- **GitLab.com limits** (https://docs.gitlab.com/user/gitlab_com/rate_limits/): Free authenticated API burst **100/min** (the 5,000/h hourly figure is *proposed, not in effect*); raw endpoints 300/min per project/file; search 100/min per user. On 429 use `Retry-After`. Every response carries `RateLimit-Remaining` (observed: `ratelimit-limit: 500` unauthenticated).
- **Box OAuth** (https://developer.box.com/reference/post-oauth2-token/): `client_secret` is "used in combination with `authorization_code`"; **`code_verifier` is not listed** (PKCE is undocumented). Refresh tokens are valid 60 days and **single use** (https://developer.box.com/guides/authentication/tokens/refresh/). Scopes: `root_readonly` = "Read all files and folders". Passing `scope=root_readonly` on the authorize URL restricts the token (https://developer.box.com/guides/api-calls/permissions-and-errors/scopes/). Redirect URIs must be HTTPS, or HTTP for localhost/loopback (Box OAuth setup guide). Custom URL schemes are mentioned only in older community posts.
- **Box download**: `GET /files/:id/content` answers 302 with a `location` on `dl.boxcloud.com/d/1/.../download` (https://developer.box.com/guides/downloads/file/). It may answer with `retry-after` when the file is not ready.
- **iOS**: `ASWebAuthenticationSession.Callback.https(host:path:)` needs iOS 17.4 and associated domains. The app targets iOS 16.0 (`IPHONEOS_DEPLOYMENT_TARGET = 16.0`) and has no entitlements file, so this plan uses the custom-scheme callback (`callbackURLScheme:`), which works on iOS 16.
- **Repo**: no syntax-highlighting library exists in `web/` or `ios_app/`. Monaco is desktop-only (`ui/screens/explorer/EditorPane.tsx`), and adding a dependency for highlighting is decision D3. `ui/screens/explorer/lang.ts` `languageFor` (pure, no imports) is reused for language labels. The web `Markdown` view (`ui/screens/chat/MarkdownView.tsx`) renders an AST with no HTML strings and no `<img>`.

## Shared Box auth module (SP6 coordination)

**SP7 owns the device-side OAuth module on both platforms:** `web/src/sources/oauth.ts` and `ios_app/SharedProtocol/Sources/SharedProtocol/SourceOAuth.swift`. Their `authorizeUrl` / `SourceOAuth.authorizeURL` take an optional `scope` argument. SP6 (Box as the sync backend on devices) **imports these functions and passes `root_readwrite`**. It keeps its own token slot and its own Box app. The SP7 read-only document token is **never** used for sync writes, and an SP6 sync token is never used for document reads. So SP7 works the same whether the sync backend is MEGA, SFTP or Box (spec Q11). If the SP6 plan defines its own Box OAuth code, it should be changed to import this module (tell the SP6 author).

## User decisions (secure, free defaults; the plan builds the default)

| # | Decision | Default built here |
|---|---|---|
| D1 | Self-hosted GitLab | **Off: gitlab.com only.** A later change adds a base URL (iOS) plus the credential-free VPS `location /gitlab/` proxy (web, spec §9), because the web CSP cannot list an unknown host. |
| D2 | Which file types to preview | Code/text as plain text; Markdown rendered with the no-HTML view (web), as text (iOS); PDF in PDFKit (iOS) or **"Save PDF" only** on the web (no in-browser viewer, since `object-src 'none'` stays); Office files via Box `extracted_text`; HTML/SVG shown **as source text, never rendered**; images, archives and media "not shown". |
| D3 | Syntax highlighting | **None** (no library exists; no new dependency). Monospaced text with a language label. |
| D4 | Web token persistence | **Memory only.** Sign in again each browser session. Refresh tokens are never written to storage. |
| D5 | Where the Box app secret lives | The user's **own** Box app. Its client ID + secret sit in IndexedDB `llmide-sources` (web) and in the Keychain, this-device-only (iOS). Stated risk: script on the web origin could read it, which the CSP limits to first-party script. |
| D6 | Whose OAuth apps | **The user's own** GitLab application (Confidential unticked) and Box Custom App. IDs are entered on each device. No shared LLM-IDE app and no secret in the build. |
| D7 | Offline cache of documents/code | **None.** Offline shows a clear "you are offline" state; nothing read from Box/GitLab is persisted. |
| D8 | Size caps | Text/code 1 MiB (longer is truncated with a notice); Box extracted text 2 MiB; PDF 20 MiB (larger is "open on Box/GitLab"); JSON pages 2 MiB. |
| D9 | iOS Box redirect URI | `llmide-oauth://box/callback` (custom scheme). If the Box console refuses it, the fallback is a static https bounce page (follow-up, not built). |
| D10 | iOS web-auth session cookies | `prefersEphemeralWebBrowserSession = false` (reuse the Safari login). `true` is more private but asks for the password every time. |
| D11 | PAT fallback (Q12) | **Not built.** OAuth only, so no long-lived token is ever typed into a device. |

## Global Constraints

- **Read-only scopes only:** GitLab `read_api read_repository`; Box `root_readonly`, passed as `scope` on the authorize URL. A token response whose `scope` names `api`, `write_repository` or `root_readwrite` is refused (`scope_too_wide`) and never kept.
- **No write calls:** the clients issue `GET` only. The only `POST`s are to the token and revoke endpoints.
- **Exact hosts:** API traffic goes only to `https://gitlab.com`, `https://api.box.com`, `https://dl.boxcloud.com` and `https://public.boxcloud.com`, enforced in code (`isAllowedUrl` / `SourceHTTP.isAllowed`) and, on the web, in CSP `connect-src`. Sign-in pages (`gitlab.com/oauth/authorize`, `account.box.com/api/oauth2/authorize`) are navigations, not `connect-src`.
- **CSP (web): one change.** `connect-src` gains exactly `https://gitlab.com https://api.box.com https://dl.boxcloud.com https://public.boxcloud.com`, appended after the MEGA hosts, in `web/vite.config.ts`, `web/scripts/serve.mjs`, `deploy/vps/llm-ide.com.nginx` and the Caddy example in `web/DEPLOY.md`. Nothing else changes; `script-src 'self'`, `object-src 'none'`, `img-src 'self' data:`, `form-action 'none'` stay.
- **Tokens:** web: in memory only (D4); the PKCE verifier and state are in memory only; **never `localStorage` or `sessionStorage`**. iOS: Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (the existing `SyncStore.Keychain` helper).
- **Rendering:** every name, path, snippet and body renders as React text / SwiftUI `Text` / `UITextView` with `dataDetectorTypes = []`, or through the web's shared `Markdown` view. No `dangerouslySetInnerHTML`, `innerHTML`, `iframe`, `embed`, `object`, `WKWebView`, `eval`. Nothing a provider returns is executed. Links open only `https://` URLs, in a new tab (web) or Safari (iOS).
- **Rate limits:** pace GitLab at ≤ 60 requests/min and Box at ≤ 240/min per client; at most 2 `Retry-After` waits (each capped at 60 s) per request; search runs only on submit (no as-you-type).
- **Timeouts:** 20 s per request.
- **No real network in CI.** Unit tests use `web/tests/helpers/fake-sources.mjs` and `ios_app/SharedProtocol/Tests/SharedProtocolTests/FakeSourceServer.swift`. Live tests are opt-in by environment variable and skip otherwise.
- **iOS ATS:** add `NSExceptionDomains` for `box.com`, `boxcloud.com` and `gitlab.com` (subdomains included, `NSExceptionAllowsInsecureHTTPLoads` false, TLS ≥ 1.2). The top-level `NSAllowsArbitraryLoads` stays as it is (it serves the LAN Mac link; see its history in git). Code also refuses any non-https URL.
- **Accessibility:** every input has a label; progress uses `role="status"` + `aria-live="polite"`; errors use `StatusBanner severity="error"` (`role="alert"`); breadcrumbs are `<nav aria-label="Location">` with `aria-current="page"`; focus moves to the file heading when a file opens; everything is a native button/link/form. iOS: Dynamic Type (scaled monospaced font), combined accessibility elements with hints, labelled text and PDF views.
- **Web conventions** (`web/tests/scaffold.test.mjs`): exact version pins (no new dependency is added); no raw HTML or dynamic code in `web/src`.
- **Do not modify** `extension/**`, `schema/**`, `desktop/**`, `ui/**` (read/import only), or the existing sync code paths in `web/src/sync/*` and `SharedProtocol/Sync*.swift`, except: the `Keychain.Item` enum in `ios_app/MyApp/Services/SyncStore.swift` (two new cases), `SyncTier.tsx` (one optional prop), and `web/tests/sync-keystore.test.mjs` (move its fake IndexedDB into a helper).
- **Working tree caution:** `ios_app/MyApp/Supporting/Info.plist` and several `desktop/`/`ui/` files had uncommitted changes from another session when this plan was written. Before Task 10, run `git status --short ios_app/MyApp/Supporting/Info.plist`. If it is modified and the change is not yours, stage only your hunk with `git add -p` and leave the rest unstaged.
- Commit on `main` (user rule: no branches), Conventional Commits, one concern per commit, each message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

---

## File Structure

| File | New/Modify | Responsibility |
|---|---|---|
| `web/src/sources/oauth.ts` | create | PKCE, authorize URLs, callback wait over `BroadcastChannel`, token exchange/refresh/revoke, strict token parse (shared with SP6) |
| `web/public/oauth-callback.html`, `web/public/oauth-callback.js` | create | static same-origin callback: strip the code from the URL, post it to the opener tab, close |
| `web/public/sw.js` | modify | never intercept the callback page (else it would overwrite the cached shell) |
| `web/src/sources/http.ts` | create | `guardedGet`: host allow-list, pace, byte cap, 401 refresh, 429/202 back-off, error codes |
| `web/src/sources/preview.ts` | create | file name → preview kind, caps, binary sniff, `loadPreview` |
| `web/src/sources/model.ts` | create | `Entry`, `Page`, `Opened`, `SourceClient`, `dedupe` |
| `web/src/sources/gitlab.ts` | create | GitLab client (projects, tree, raw file, blob search, web URLs) |
| `web/src/sources/box.ts` | create | Box client (folder items, content, extracted text, search, web URLs) |
| `web/src/sources/config.ts` | create | app settings (IDs, Box secret) in IndexedDB `llmide-sources`; never tokens |
| `web/src/sources/controller.ts` | create | React-free state: sign-in, tokens in memory, navigation, search, open, offline |
| `web/src/screens/SourcesScreen.tsx` | create | provider cards, browser, file view; `SourcesEntry` |
| `web/src/App.tsx`, `web/src/screens/SyncTier.tsx`, `web/src/web.css` | modify | route to the screen; entry points; layout |
| `web/tests/helpers/fake-sources.mjs`, `web/tests/helpers/fake-idb.mjs` | create | fake gitlab.com + Box; shared fake IndexedDB |
| `web/tests/sources-*.test.mjs`, `web/tests/live/sources-live.test.mjs` | create | unit, screen and opt-in live tests |
| `web/vite.config.ts`, `web/scripts/serve.mjs`, `deploy/vps/llm-ide.com.nginx`, `web/DEPLOY.md`, `web/tests/scaffold.test.mjs` | modify | CSP `connect-src` |
| `ios_app/SharedProtocol/Sources/SharedProtocol/SourceOAuth.swift` | create | PKCE, authorize URL, callback parse, exchange/refresh/revoke (shared with SP6) |
| `ios_app/SharedProtocol/Sources/SharedProtocol/SourceHTTP.swift` | create | transport with byte cap + redirect guard, `SourceSession` (pace, refresh, back-off), models, preview rules |
| `ios_app/SharedProtocol/Sources/SharedProtocol/GitLabReadClient.swift`, `BoxReadClient.swift` | create | the two clients |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/FakeSourceServer.swift`, `Source*Tests.swift` | create | fake APIs, unit + opt-in live tests |
| `ios_app/MyApp/Services/SourceReadStore.swift` | create | configs + tokens in the Keychain, `ASWebAuthenticationSession`, clients |
| `ios_app/MyApp/Views/Control/SourceReadViews.swift` | create | settings card, root section, browser, file view (UITextView, PDFKit) |
| `ios_app/MyApp/Services/SyncStore.swift`, `ios_app/MyApp/MyAppApp.swift`, `ios_app/MyApp/Views/Control/SyncOfflineViews.swift`, `ios_app/MyApp/Views/Settings/SettingsView.swift`, `ios_app/MyApp/Supporting/Info.plist`, `ios_app/MyApp.xcodeproj/project.pbxproj` | modify | Keychain items, environment object, entry points, ATS, project membership |
| `docs/how-to/read-box-gitlab-on-phone-and-web.md`, `web/README.md`, `web/MANUAL-CHECK.md`, spec §14 | create/modify | setup, manual checks, status |

---

### Task 1: Web OAuth (PKCE, popup callback) and the callback page

**Files:**
- Create: `web/src/sources/oauth.ts`
- Create: `web/public/oauth-callback.html`, `web/public/oauth-callback.js`
- Modify: `web/public/sw.js` (fetch handler)
- Test: `web/tests/sources-oauth.test.mjs`, `web/tests/pwa.test.mjs` (one assertion)

**Interfaces:**
- Produces (used by Tasks 5, 6 and SP6):
  - `type Provider = "gitlab" | "box"`, `interface ProviderConfig { clientId: string; clientSecret?: string }`, `interface Tokens { access: string; refresh: string | null; expiresAt: number }`
  - `ENDPOINTS: Record<Provider, { authorize; token; revoke; scope }>`, `CHANNEL = "llmide-oauth"`, `CALLBACK_PATH = "oauth-callback.html"`, `SIGN_IN_TIMEOUT_MS`
  - `class OAuthError extends Error { code: string }`
  - `randomString(bytes?: number, rand?: (n: number) => Uint8Array): string`, `challengeFor(verifier: string): Promise<string>`
  - `checkConfig(p: Provider, c: ProviderConfig): ProviderConfig`
  - `authorizeUrl(p, cfg, redirectUri, state, challenge, scope?): string`, `callbackUrl(baseURI: string): string`
  - `interface ChannelLike { onmessage: ((e: { data: unknown }) => void) | null; close(): void }`
  - `type Every = (fn: () => void, ms: number) => () => void`
  - `waitForCode(state: string, channel: ChannelLike, o?: { timeoutMs?: number; isClosed?: () => boolean; every?: Every }): Promise<string>`
  - `parseTokens(json: unknown, now: number): Tokens`
  - `exchangeCode(p, cfg, code, verifier, redirectUri, fetchImpl?, now?): Promise<Tokens>`, `refreshTokens(p, cfg, refresh, redirectUri, fetchImpl?, now?): Promise<Tokens>`, `revokeToken(p, cfg, token, fetchImpl?): Promise<void>`

- [ ] **Step 1: Write the failing test** `web/tests/sources-oauth.test.mjs`

```js
// Device OAuth for direct reads: PKCE S256 (RFC 7636 vector), read-only authorize URLs, the callback wait (state check,
// closed pop-up, timeout), strict token parsing, and the callback page itself. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { authorizeUrl, callbackUrl, challengeFor, checkConfig, exchangeCode, parseTokens, randomString, refreshTokens, revokeToken, waitForCode, OAuthError } from '../src/sources/oauth.ts';

const GL = { clientId: 'a'.repeat(64) };
const BOX = { clientId: 'b'.repeat(32), clientSecret: 'boxsecret0123456789abcdef' };
const code = (c) => (e) => { assert.ok(e instanceof OAuthError); assert.equal(e.code, c); return true; };

test('PKCE: the RFC 7636 appendix B vector, and verifiers are 43 url-safe characters', async () => {
  assert.equal(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1zMq7d1Dip6EGHG9w');
  const v = randomString();
  assert.match(v, /^[A-Za-z0-9_-]{43}$/);
});

test('authorize URLs ask for read-only scopes with S256', () => {
  const g = new URL(authorizeUrl('gitlab', GL, 'https://llm-ide.com/app/oauth-callback.html', 'st', 'ch'));
  assert.equal(g.origin + g.pathname, 'https://gitlab.com/oauth/authorize');
  assert.equal(g.searchParams.get('scope'), 'read_api read_repository');
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(g.searchParams.get('response_type'), 'code');
  const b = new URL(authorizeUrl('box', BOX, 'https://llm-ide.com/app/oauth-callback.html', 'st', 'ch'));
  assert.equal(b.origin + b.pathname, 'https://account.box.com/api/oauth2/authorize');
  assert.equal(b.searchParams.get('scope'), 'root_readonly');
  assert.equal(b.searchParams.has('client_secret'), false, 'the secret never goes into a URL');
  assert.equal(new URL(authorizeUrl('box', BOX, 'x', 's', 'c', 'root_readwrite')).searchParams.get('scope'), 'root_readwrite', 'SP6 passes its own scope');
  assert.equal(callbackUrl('https://llm-ide.com/app/'), 'https://llm-ide.com/app/oauth-callback.html');
  assert.equal(callbackUrl('http://127.0.0.1:5180/'), 'http://127.0.0.1:5180/oauth-callback.html');
});

test('config: IDs and the Box secret are shape-checked', () => {
  assert.deepEqual(checkConfig('gitlab', { clientId: GL.clientId, clientSecret: 'dropped' }), GL);
  assert.throws(() => checkConfig('gitlab', { clientId: 'x' }), code('bad_client_id'));
  assert.throws(() => checkConfig('box', { clientId: BOX.clientId }), code('bad_client_secret'));
});

test('waitForCode: ignores other states, resolves the matching code, rejects closed pop-ups and timeouts', async () => {
  const ch = { onmessage: null, closed: 0, close() { this.closed += 1; } };
  let tick = null; const every = (fn) => { tick = fn; return () => { tick = null; }; };
  const p = waitForCode('S1', ch, { every });
  ch.onmessage({ data: { state: 'other', code: 'evil-code-123' } });
  ch.onmessage({ data: { state: 'S1', code: 'good-code-123' } });
  assert.equal(await p, 'good-code-123');
  assert.equal(ch.closed, 1); assert.equal(tick, null);
  let closed = false;
  const q = waitForCode('S2', { onmessage: null, close() {} }, { every, isClosed: () => closed });
  closed = true; tick();
  await assert.rejects(q, code('sign_in_cancelled'));
  const r = waitForCode('S3', { onmessage: null, close() {} }, { every, timeoutMs: 2000 });
  tick(); tick();
  await assert.rejects(r, code('sign_in_timeout'));
  const c = { onmessage: null, close() {} };
  const d = waitForCode('S4', c, { every });
  c.onmessage({ data: { state: 'S4', error: 'access_denied' } });
  await assert.rejects(d, code('sign_in_cancelled'));
});

test('tokens: strict parse, wide scopes refused, expiry a minute early', () => {
  const t = parseTokens({ access_token: 'acc-12345678', refresh_token: 'ref-1', expires_in: 7200, scope: 'read_api read_repository' }, 1000);
  assert.deepEqual(t, { access: 'acc-12345678', refresh: 'ref-1', expiresAt: 1000 + 7200_000 - 60_000 });
  assert.throws(() => parseTokens({ access_token: 'acc-12345678', scope: 'api read_api' }, 0), code('scope_too_wide'));
  assert.throws(() => parseTokens({ access_token: 'acc-12345678', scope: 'root_readwrite' }, 0), code('scope_too_wide'));
  assert.throws(() => parseTokens({ access_token: 3 }, 0), code('bad_token_response'));
  assert.equal(parseTokens({ access_token: 'acc-12345678' }, 0).refresh, null);
});

test('exchange, refresh and revoke post the right forms; Box adds its secret, GitLab never has one', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)), init }); return new Response(JSON.stringify({ access_token: 'acc-12345678', refresh_token: 'r2', expires_in: 3600 }), { status: 200 }); };
  await exchangeCode('gitlab', GL, 'good-code-123', 'verif', 'https://x/cb', fetchImpl, () => 0);
  assert.equal(seen[0].url, 'https://gitlab.com/oauth/token');
  assert.deepEqual(seen[0].form, { grant_type: 'authorization_code', code: 'good-code-123', client_id: GL.clientId, redirect_uri: 'https://x/cb', code_verifier: 'verif' });
  assert.equal(seen[0].init.credentials, 'omit');
  await exchangeCode('box', BOX, 'good-code-123', 'verif', 'https://x/cb', fetchImpl, () => 0);
  assert.equal(seen[1].url, 'https://api.box.com/oauth2/token');
  assert.equal(seen[1].form.client_secret, BOX.clientSecret);
  await refreshTokens('gitlab', GL, 'r1', 'https://x/cb', fetchImpl, () => 0);
  assert.deepEqual(seen[2].form, { grant_type: 'refresh_token', refresh_token: 'r1', client_id: GL.clientId, redirect_uri: 'https://x/cb' });
  await revokeToken('box', BOX, 'acc-12345678', fetchImpl);
  assert.equal(seen[3].url, 'https://api.box.com/oauth2/revoke');
  assert.deepEqual(seen[3].form, { client_id: BOX.clientId, token: 'acc-12345678', client_secret: BOX.clientSecret });
  const refuse = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  await assert.rejects(exchangeCode('gitlab', GL, 'c-123456789', 'v', 'u', refuse), code('grant_expired'));
  await assert.rejects(exchangeCode('gitlab', GL, 'c-123456789', 'v', 'u', async () => { throw new TypeError('fetch failed'); }), code('unreachable'));
  await revokeToken('gitlab', GL, 't', async () => { throw new TypeError('x'); }); // best effort: never throws
});

test('the callback page strips the code from the address, posts it on the channel, and closes', () => {
  const dir = join(import.meta.dirname, '../public');
  const html = readFileSync(join(dir, 'oauth-callback.html'), 'utf8');
  assert.match(html, /<script src="\.\/oauth-callback\.js"><\/script>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'/);
  const posted = []; const replaced = []; let closed = false;
  const el = { textContent: '' };
  vm.runInNewContext(readFileSync(join(dir, 'oauth-callback.js'), 'utf8'), {
    URLSearchParams,
    location: { search: '?code=good-code-123&state=S1', pathname: '/app/oauth-callback.html' },
    history: { replaceState: (...a) => replaced.push(a) },
    BroadcastChannel: class { constructor(n) { this.n = n; } postMessage(m) { posted.push([this.n, m]); } close() {} },
    document: { getElementById: () => el },
    setTimeout: (fn) => fn(),
    window: { close: () => { closed = true; } },
  });
  assert.deepEqual(replaced[0], [null, '', '/app/oauth-callback.html']);
  assert.deepEqual(posted, [['llmide-oauth', { state: 'S1', code: 'good-code-123', error: null }]]);
  assert.equal(closed, true);
  assert.match(el.textContent, /close this window/);
});
```

Add to `web/tests/pwa.test.mjs`, inside the existing test `"the worker caches only the shell, only GET, and never the Host API"` after the `host-api` assertion:

```js
  assert.match(sw, /url\.pathname\.endsWith\("\/oauth-callback\.html"\)/, "the sign-in callback is never cached as the shell");
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/sources-oauth.test.mjs tests/pwa.test.mjs`
Expected: FAIL (`Cannot find module '../src/sources/oauth.ts'`; the pwa assertion fails).

- [ ] **Step 3: Implement**

`web/src/sources/oauth.ts`:

```ts
// Device OAuth for direct reads (design 9, Q11, Q12): authorization code + PKCE (S256) in a pop-up; the same-origin
// callback page hands the code back over BroadcastChannel. Read-only scopes by default. Shared with SP6, which passes its
// own `scope`. Nothing here touches localStorage or sessionStorage: verifier and state live in the caller's memory.
export type Provider = "gitlab" | "box";
export interface ProviderConfig { clientId: string; clientSecret?: string }
export interface Tokens { access: string; refresh: string | null; expiresAt: number }

export const ENDPOINTS = {
  gitlab: { authorize: "https://gitlab.com/oauth/authorize", token: "https://gitlab.com/oauth/token", revoke: "https://gitlab.com/oauth/revoke", scope: "read_api read_repository" },
  box: { authorize: "https://account.box.com/api/oauth2/authorize", token: "https://api.box.com/oauth2/token", revoke: "https://api.box.com/oauth2/revoke", scope: "root_readonly" },
} as const;
export const CHANNEL = "llmide-oauth";
export const CALLBACK_PATH = "oauth-callback.html";
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "OAuthError"; }
}

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const realRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const randomString = (bytes = 32, rand: (n: number) => Uint8Array = realRandom): string => b64url(rand(bytes));
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SECRET = /^[A-Za-z0-9]{16,128}$/;
export function checkConfig(p: Provider, c: ProviderConfig): ProviderConfig {
  if (!CLIENT_ID.test(c?.clientId ?? "")) throw new OAuthError("bad_client_id");
  if (p === "gitlab") return { clientId: c.clientId };
  if (!SECRET.test(c.clientSecret ?? "")) throw new OAuthError("bad_client_secret");
  return { clientId: c.clientId, clientSecret: c.clientSecret };
}

export function authorizeUrl(p: Provider, cfg: ProviderConfig, redirectUri: string, state: string, challenge: string, scope: string = ENDPOINTS[p].scope): string {
  const u = new URL(ENDPOINTS[p].authorize);
  u.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: "code", state, scope, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return u.toString();
}
export const callbackUrl = (baseURI: string): string => new URL(CALLBACK_PATH, baseURI).toString();

export interface ChannelLike { onmessage: ((e: { data: unknown }) => void) | null; close(): void }
export type Every = (fn: () => void, ms: number) => () => void;
const realEvery: Every = (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); };
const CODE = /^[A-Za-z0-9._~-]{8,2048}$/;

/** Resolves the code for `state` from the callback page; a 1 s ticker notices a closed pop-up or the timeout. */
export function waitForCode(state: string, channel: ChannelLike, o: { timeoutMs?: number; isClosed?: () => boolean; every?: Every } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let ticks = 0;
    let stop: () => void = () => {};
    const end = (fn: () => void) => { stop(); channel.close(); fn(); };
    stop = (o.every ?? realEvery)(() => {
      ticks += 1;
      if (o.isClosed?.()) end(() => reject(new OAuthError("sign_in_cancelled")));
      else if (ticks * 1000 >= (o.timeoutMs ?? SIGN_IN_TIMEOUT_MS)) end(() => reject(new OAuthError("sign_in_timeout")));
    }, 1000);
    channel.onmessage = (e) => {
      const d = e.data as { state?: unknown; code?: unknown; error?: unknown } | null;
      if (!d || d.state !== state) return; // another tab's sign-in: not ours
      if (typeof d.code === "string" && CODE.test(d.code)) { const c = d.code; end(() => resolve(c)); }
      else end(() => reject(new OAuthError(d.error === "access_denied" ? "sign_in_cancelled" : "sign_in_failed")));
    };
  });
}

const WIDE = /(^|\s)(api|write_repository|root_readwrite)(\s|$)/;
export function parseTokens(json: unknown, now: number): Tokens {
  const j = json as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
  const access = j?.access_token, refresh = j?.refresh_token, exp = j?.expires_in;
  if (typeof access !== "string" || access.length < 8 || access.length > 4096) throw new OAuthError("bad_token_response");
  if (refresh != null && (typeof refresh !== "string" || refresh.length > 4096)) throw new OAuthError("bad_token_response");
  if (typeof j?.scope === "string" && WIDE.test(j.scope)) throw new OAuthError("scope_too_wide");
  const ttl = typeof exp === "number" && exp > 0 ? Math.min(exp, 86_400) : 3600;
  return { access, refresh: typeof refresh === "string" ? refresh : null, expiresAt: now + ttl * 1000 - 60_000 };
}

async function post(url: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  let r: Response;
  try {
    r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(),
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch { throw new OAuthError("unreachable"); }
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new OAuthError(r.status === 400 || r.status === 401 ? ((json as { error?: unknown } | null)?.error === "invalid_grant" ? "grant_expired" : "client_refused") : "provider_error");
  return json;
}

export async function exchangeCode(p: Provider, cfg: ProviderConfig, code: string, verifier: string, redirectUri: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<Tokens> {
  const form: Record<string, string> = { grant_type: "authorization_code", code, client_id: cfg.clientId, redirect_uri: redirectUri, code_verifier: verifier };
  // Box documents no PKCE and requires its secret (spec 8.2); the verifier is sent anyway and is harmless.
  if (p === "box") form.client_secret = cfg.clientSecret ?? "";
  return parseTokens(await post(ENDPOINTS[p].token, form, fetchImpl), now());
}

export async function refreshTokens(p: Provider, cfg: ProviderConfig, refresh: string, redirectUri: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<Tokens> {
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refresh, client_id: cfg.clientId };
  if (p === "gitlab") form.redirect_uri = redirectUri;
  else form.client_secret = cfg.clientSecret ?? "";
  return parseTokens(await post(ENDPOINTS[p].token, form, fetchImpl), now());
}

/** Best effort: a failed revoke still ends the session here, and the token expires on its own. */
export async function revokeToken(p: Provider, cfg: ProviderConfig, token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const form: Record<string, string> = { client_id: cfg.clientId, token };
  if (p === "box") form.client_secret = cfg.clientSecret ?? "";
  try { await post(ENDPOINTS[p].revoke, form, fetchImpl); } catch { /* see above */ }
}
```

`web/public/oauth-callback.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'" />
    <title>LLM-IDE sign-in</title>
  </head>
  <body>
    <p id="s" role="status">Finishing sign-in…</p>
    <script src="./oauth-callback.js"></script>
  </body>
</html>
```

`web/public/oauth-callback.js`:

```js
// The OAuth redirect target (design 9). It removes the code from the address bar and history, hands it to the
// LLM-IDE tab that opened the sign-in (same origin only, over BroadcastChannel), and closes. It stores nothing.
(function () {
  var p = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  var msg = { state: p.get("state"), code: p.get("code"), error: p.get("error") };
  var ch = new BroadcastChannel("llmide-oauth");
  ch.postMessage(msg);
  ch.close();
  document.getElementById("s").textContent = msg.code ? "Signed in. You can close this window." : "Sign-in did not finish. You can close this window.";
  setTimeout(function () { window.close(); }, 300);
})();
```

`web/public/sw.js`, in the `fetch` listener, directly after `if (url.pathname.endsWith("/sw.js")) return;`, add:

```js
  // The sign-in callback must never be cached: the navigate branch would store it as the shell ("./").
  if (url.pathname.endsWith("/oauth-callback.html") || url.pathname.endsWith("/oauth-callback.js")) return;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && node --test --experimental-strip-types tests/sources-oauth.test.mjs tests/pwa.test.mjs && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/sources/oauth.ts web/public/oauth-callback.html web/public/oauth-callback.js web/public/sw.js web/tests/sources-oauth.test.mjs web/tests/pwa.test.mjs
git commit -m "feat(web): read-only OAuth with PKCE and a pop-up callback for direct reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Web guarded GET and preview rules

**Files:**
- Create: `web/src/sources/http.ts`, `web/src/sources/preview.ts`, `web/src/sources/model.ts`
- Test: `web/tests/sources-http.test.mjs`

**Interfaces:**
- Consumes: `Provider` (Task 1).
- Produces:
  - `http.ts`: `type SourceErrorCode`; `class SourceError extends Error { code: SourceErrorCode; retryAfterSec: number | null }`; `ALLOWED_HOSTS`; `isAllowedUrl(u: string): boolean`; `interface Auth { token(): Promise<string>; refresh(): Promise<string | null> }`; `interface Pacer { wait(): Promise<void> }`; `interface HttpDeps { fetchImpl?; sleep?; online?; now? }`; `interface Got { status: number; headers: Headers; bytes: Uint8Array; truncated: boolean }`; `createPacer(perMinute, d?)`; `readCapped(res, cap)`; `guardedGet(url, auth, pacer, cap, d?, headers?): Promise<Got>`; `parseJson(g: Got): unknown`; `checkQuery(q: string): string`
  - `preview.ts`: `type PreviewKind = "code" | "markdown" | "text" | "pdf" | "extracted" | "unsupported"`; `CAPS`; `previewKind(name, provider): { kind: PreviewKind; language: string }`; `decodeText(b): string | null`; `loadPreview(entry, p, webUrl, get): Promise<Opened>`
  - `model.ts`: `ProjectRef`, `Entry`, `Page`, `Reason`, `Opened`, `SourceClient`, `dedupe`

- [ ] **Step 1: Write the failing test** `web/tests/sources-http.test.mjs`

```js
// The one guarded GET under both clients, and the preview rules. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer, guardedGet, isAllowedUrl, parseJson, checkQuery, readCapped, SourceError } from '../src/sources/http.ts';
import { decodeText, loadPreview, previewKind, CAPS } from '../src/sources/preview.ts';

const auth = (tokens = ['t1'], refreshTo = 't2') => { let i = 0; return { refreshes: 0, async token() { return tokens[i]; }, async refresh() { this.refreshes += 1; i += 1; tokens[i] = refreshTo; return refreshTo; } }; };
const free = { wait: async () => {} };
const err = (c) => (e) => { assert.ok(e instanceof SourceError, String(e)); assert.equal(e.code, c); return true; };
const res = (body, status = 200, headers = {}) => new Response(body, { status, headers });

test('host allow-list: https, exact hosts, no credentials, port 443 only', () => {
  for (const u of ['https://gitlab.com/api/v4/projects', 'https://api.box.com/2.0/folders/0/items', 'https://dl.boxcloud.com/d/1/x/download', 'https://public.boxcloud.com/api/2.0/x'])
    assert.equal(isAllowedUrl(u), true, u);
  for (const u of ['http://gitlab.com/', 'https://gitlab.com.evil.example/', 'https://evil.boxcloud.com/', 'https://u:p@gitlab.com/', 'https://gitlab.com:8443/', 'https://account.box.com/', 'notaurl'])
    assert.equal(isAllowedUrl(u), false, u);
});

test('pacer spaces request starts by 60000/perMinute ms', async () => {
  const slept = [];
  const p = createPacer(60, { now: () => 0, sleep: async (ms) => { slept.push(ms); } });
  await p.wait(); await p.wait(); await p.wait();
  assert.deepEqual(slept, [1000, 2000]);
});

test('readCapped: exact cap is whole, one byte over is truncated', async () => {
  assert.deepEqual(await readCapped(res(new Uint8Array(4)), 4), { bytes: new Uint8Array(4), truncated: false });
  const r = await readCapped(res(new Uint8Array(5).fill(1)), 4);
  assert.equal(r.truncated, true); assert.equal(r.bytes.length, 4);
});

test('guardedGet: bearer token, no cookies; 401 refreshes once then retries; second 401 is signed_out', async () => {
  const seen = []; const a = auth();
  let n = 0;
  const g = await guardedGet('https://gitlab.com/api/v4/x', a, free, 100, { fetchImpl: async (u, init) => { seen.push(init); return n++ === 0 ? res('', 401) : res('{"ok":1}'); } });
  assert.equal(seen[0].headers.Authorization, 'Bearer t1');
  assert.equal(seen[1].headers.Authorization, 'Bearer t2');
  assert.equal(seen[0].credentials, 'omit');
  assert.equal(a.refreshes, 1);
  assert.deepEqual(parseJson(g), { ok: 1 });
  await assert.rejects(guardedGet('https://gitlab.com/x', auth(), free, 100, { fetchImpl: async () => res('', 401) }), err('signed_out'));
});

test('guardedGet: 429 waits Retry-After (capped 60 s) at most twice, then rate_limited; 202 is not_ready', async () => {
  const slept = [];
  let n = 0;
  const ok = await guardedGet('https://api.box.com/2.0/x', auth(), free, 100, { sleep: async (ms) => { slept.push(ms); }, fetchImpl: async () => (n++ < 2 ? res('', 429, { 'retry-after': n === 1 ? '3' : '999' }) : res('x')) });
  assert.equal(ok.status, 200);
  assert.deepEqual(slept, [3000, 60000]);
  await assert.rejects(guardedGet('https://api.box.com/2.0/x', auth(), free, 100, { sleep: async () => {}, fetchImpl: async () => res('', 429, { 'retry-after': '5' }) }), (e) => e.code === 'rate_limited' && e.retryAfterSec === 5);
  await assert.rejects(guardedGet('https://api.box.com/2.0/x', auth(), free, 100, { sleep: async () => {}, fetchImpl: async () => res('', 202, { 'retry-after': '1' }) }), err('not_ready'));
});

test('guardedGet: offline, network failure, refused host, redirect landing, status codes', async () => {
  let called = false;
  await assert.rejects(guardedGet('https://gitlab.com/x', auth(), free, 100, { online: () => false, fetchImpl: async () => { called = true; return res(''); } }), err('offline'));
  assert.equal(called, false);
  await assert.rejects(guardedGet('https://gitlab.com/x', auth(), free, 100, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), err('unreachable'));
  await assert.rejects(guardedGet('https://evil.example/x', auth(), free, 100, { fetchImpl: async () => res('') }), err('refused_host'));
  const landed = res('x'); Object.defineProperty(landed, 'url', { value: 'https://evil.example/' });
  await assert.rejects(guardedGet('https://api.box.com/2.0/files/1/content', auth(), free, 100, { fetchImpl: async () => landed }), err('refused_host'));
  await assert.rejects(guardedGet('https://api.box.com/x', auth(), free, 100, { fetchImpl: async () => res('{"code":"cors_origin_not_whitelisted"}', 403) }), err('cors_origin'));
  await assert.rejects(guardedGet('https://api.box.com/x', auth(), free, 100, { fetchImpl: async () => res('{}', 403) }), err('forbidden'));
  await assert.rejects(guardedGet('https://api.box.com/x', auth(), free, 100, { fetchImpl: async () => res('', 404) }), err('not_found'));
  await assert.rejects(guardedGet('https://api.box.com/x', auth(), free, 100, { fetchImpl: async () => res('', 500) }), err('provider_error'));
  assert.throws(() => parseJson({ bytes: new Uint8Array([123]), truncated: true }), err('too_large'));
  assert.throws(() => parseJson({ bytes: new TextEncoder().encode('{'), truncated: false }), err('bad_response'));
  assert.equal(checkQuery('  hi  '), 'hi');
  assert.throws(() => checkQuery('   '), err('bad_query'));
  assert.throws(() => checkQuery('x'.repeat(201)), err('bad_query'));
});

test('preview rules: code, markdown, text, pdf, extracted (Box only), unsupported; HTML and SVG are source text', () => {
  const k = (n, p = 'gitlab') => previewKind(n, p).kind;
  assert.equal(k('src/app.ts'), 'code'); assert.equal(previewKind('a.py', 'gitlab').language, 'python');
  assert.equal(k('index.html'), 'code'); assert.equal(k('logo.svg'), 'code');
  assert.equal(k('README.md'), 'markdown');
  assert.equal(k('notes.txt'), 'text'); assert.equal(k('LICENSE'), 'text');
  assert.equal(k('deck.PDF'), 'pdf');
  assert.equal(k('plan.docx', 'box'), 'extracted'); assert.equal(k('plan.docx', 'gitlab'), 'unsupported');
  for (const n of ['logo.png', 'a.zip', 'movie.mp4', 'font.woff2', 'app.exe', 'db.sqlite']) assert.equal(k(n), 'unsupported', n);
  assert.equal(decodeText(new Uint8Array([104, 105])), 'hi');
  assert.equal(decodeText(new Uint8Array([104, 0, 105])), null);
  assert.equal(CAPS.text, 1_048_576); assert.equal(CAPS.pdf, 20_971_520);
});

test('loadPreview: text with truncation flag, binary demoted, pdf over cap refused, unsupported never fetched', async () => {
  const e = { id: '1', name: 'a.txt', kind: 'file', path: 'a.txt', size: null, detail: null, project: null };
  const got = (bytes, truncated = false) => async () => ({ status: 200, headers: new Headers(), bytes, truncated });
  const t = await loadPreview(e, previewKind('a.txt', 'box'), null, got(new TextEncoder().encode('hello'), true));
  assert.equal(t.text, 'hello'); assert.equal(t.truncated, true);
  const b = await loadPreview(e, previewKind('a.txt', 'box'), null, got(new Uint8Array([0, 1])));
  assert.equal(b.kind, 'unsupported'); assert.equal(b.reason, 'binary');
  const p = await loadPreview(e, previewKind('a.pdf', 'box'), null, got(new Uint8Array(3), true));
  assert.equal(p.reason, 'too_large'); assert.equal(p.bytes, null);
  let fetched = false;
  const u = await loadPreview(e, previewKind('a.png', 'box'), 'https://app.box.com/file/1', async () => { fetched = true; });
  assert.equal(u.reason, 'type'); assert.equal(fetched, false); assert.equal(u.webUrl, 'https://app.box.com/file/1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/sources-http.test.mjs`
Expected: FAIL (`Cannot find module '../src/sources/http.ts'`).

- [ ] **Step 3: Implement**

`web/src/sources/model.ts`:

```ts
// The shared shapes of direct reads: one entry list and one opened-file record for both providers.
import type { Provider } from "./oauth.ts";
import type { PreviewKind } from "./preview.ts";

export interface ProjectRef { id: number; ref: string; webUrl: string }
export interface Entry {
  id: string; name: string; kind: "project" | "dir" | "file"; path: string;
  size: number | null; detail: string | null; project: ProjectRef | null;
}
export interface Page { entries: Entry[]; next: string | null }
export type Reason = "binary" | "type" | "too_large" | "no_text";
export interface Opened {
  entry: Entry; kind: PreviewKind; language: string; text: string | null; bytes: Uint8Array | null;
  truncated: boolean; webUrl: string | null; reason: Reason | null;
}
export interface SourceClient {
  readonly provider: Provider;
  list(dir: Entry | null, cursor: string | null): Promise<Page>;
  open(file: Entry): Promise<Opened>;
  search(q: string, within: Entry | null): Promise<Page>;
  webUrl(e: Entry): string | null;
}
/** Search can return one path several times (one hit per match); keep the first. */
export const dedupe = (es: Entry[]): Entry[] => { const seen = new Set<string>(); return es.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))); };
```

`web/src/sources/http.ts`:

```ts
// One guarded GET for direct reads (design 9, 10): https to the four allowed hosts only, a per-provider pace, a byte cap,
// 401 -> one token refresh, 429/202 -> Retry-After (at most 2 waits, each at most 60 s). Callers get codes, not text.
export type SourceErrorCode = "offline" | "unreachable" | "timeout" | "signed_out" | "forbidden" | "not_found" | "rate_limited"
  | "too_large" | "cors_origin" | "not_ready" | "refused_host" | "bad_response" | "provider_error" | "bad_query";
export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly retryAfterSec: number | null;
  constructor(code: SourceErrorCode, retryAfterSec: number | null = null) { super(code); this.code = code; this.retryAfterSec = retryAfterSec; this.name = "SourceError"; }
}

/** Exact hosts. The CSP connect-src lists the same four (scaffold test). */
export const ALLOWED_HOSTS: readonly string[] = ["gitlab.com", "api.box.com", "dl.boxcloud.com", "public.boxcloud.com"];
export function isAllowedUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password && (x.port === "" || x.port === "443") && ALLOWED_HOSTS.includes(x.hostname);
  } catch { return false; }
}

export interface Auth { token(): Promise<string>; refresh(): Promise<string | null> }
export interface Pacer { wait(): Promise<void> }
export interface HttpDeps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; online?: () => boolean; now?: () => number }
export interface Got { status: number; headers: Headers; bytes: Uint8Array; truncated: boolean }

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function createPacer(perMinute: number, d: HttpDeps = {}): Pacer {
  const gap = 60_000 / perMinute; const now = d.now ?? Date.now; const sleep = d.sleep ?? realSleep;
  let nextAt = 0;
  return { async wait() { const t = now(); const at = Math.max(t, nextAt); nextAt = at + gap; if (at > t) await sleep(at - t); } };
}

const concat = (parts: Uint8Array[], n: number) => { const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: concat(parts, n), truncated: false };
    if (n + value.length > cap) {
      parts.push(value.subarray(0, cap - n));
      await reader.cancel().catch(() => {});
      return { bytes: concat(parts, cap), truncated: true };
    }
    parts.push(value); n += value.length;
  }
}

async function statusCode(res: Response): Promise<SourceErrorCode> {
  if (res.status === 401) return "signed_out";
  if (res.status === 403) return ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code === "cors_origin_not_whitelisted" ? "cors_origin" : "forbidden";
  if (res.status === 404) return "not_found";
  if (res.status >= 300 && res.status < 400) return "refused_host";
  return "provider_error";
}

export async function guardedGet(url: string, auth: Auth, pacer: Pacer, cap: number, d: HttpDeps = {}, headers: Record<string, string> = {}): Promise<Got> {
  if (!isAllowedUrl(url)) throw new SourceError("refused_host");
  if (d.online && !d.online()) throw new SourceError("offline");
  const f = d.fetchImpl ?? fetch; const sleep = d.sleep ?? realSleep;
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    await pacer.wait();
    const token = await auth.token();
    let res: Response;
    try {
      // The browser drops Authorization on the cross-origin hop to Box's pre-signed download host.
      res = await f(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(20_000) });
    } catch (e) { throw new SourceError((e as Error | undefined)?.name === "TimeoutError" ? "timeout" : "unreachable"); }
    if (res.url && !isAllowedUrl(res.url)) throw new SourceError("refused_host");
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      if (!(await auth.refresh())) throw new SourceError("signed_out");
      continue;
    }
    if (res.status === 429 || res.status === 202) {
      const sec = Math.min(Math.max(Number(res.headers.get("retry-after")) || 2, 1), 60);
      if (attempt < 2) { await sleep(sec * 1000); continue; }
      throw new SourceError(res.status === 202 ? "not_ready" : "rate_limited", sec);
    }
    if (!res.ok) throw new SourceError(await statusCode(res));
    const { bytes, truncated } = await readCapped(res, cap);
    return { status: res.status, headers: res.headers, bytes, truncated };
  }
}

export function parseJson(g: Pick<Got, "bytes" | "truncated">): unknown {
  if (g.truncated) throw new SourceError("too_large");
  try { return JSON.parse(new TextDecoder().decode(g.bytes)); } catch { throw new SourceError("bad_response"); }
}

export const MAX_QUERY = 200;
export function checkQuery(q: string): string {
  const t = q.trim();
  if (t.length < 1 || t.length > MAX_QUERY) throw new SourceError("bad_query");
  return t;
}
```

`web/src/sources/preview.ts`:

```ts
// How a file is shown (decision D2): code/text as plain text, Markdown through the no-HTML Markdown view, PDF as a
// download, Office files via Box's extracted text, everything else "not shown". HTML and SVG are code: source text.
import { languageFor } from "../../../ui/screens/explorer/lang.ts";
import type { Got } from "./http.ts";
import type { Entry, Opened } from "./model.ts";
import type { Provider } from "./oauth.ts";

export type PreviewKind = "code" | "markdown" | "text" | "pdf" | "extracted" | "unsupported";
export const CAPS = { text: 1_048_576, extracted: 2_097_152, pdf: 20_971_520, json: 2_097_152 } as const;
const EXTRACT = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key"]);
const BINARY = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "ico", "zip", "gz", "tgz", "tar", "7z", "rar", "jar", "war",
  "mp3", "mp4", "mov", "wav", "m4a", "avi", "mkv", "woff", "woff2", "ttf", "otf", "eot", "exe", "dll", "so", "dylib", "bin", "dmg", "iso",
  "class", "o", "a", "wasm", "pyc", "sqlite", "db"]);

export function previewKind(name: string, provider: Provider): { kind: PreviewKind; language: string } {
  const lower = name.toLowerCase(); const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  if (ext === "pdf") return { kind: "pdf", language: "PDF" };
  if (EXTRACT.has(ext)) return { kind: provider === "box" ? "extracted" : "unsupported", language: ext.toUpperCase() };
  if (BINARY.has(ext)) return { kind: "unsupported", language: ext.toUpperCase() };
  const lang = languageFor(name);
  if (lang === "markdown") return { kind: "markdown", language: "Markdown" };
  return lang === "plaintext" ? { kind: "text", language: "Text" } : { kind: "code", language: lang };
}

/** null when the first 8 KiB hold a NUL byte (binary). */
export function decodeText(b: Uint8Array): string | null {
  if (b.subarray(0, 8192).includes(0)) return null;
  return new TextDecoder("utf-8").decode(b);
}

export async function loadPreview(entry: Entry, p: { kind: PreviewKind; language: string }, webUrl: string | null, get: (cap: number) => Promise<Got>): Promise<Opened> {
  const o: Opened = { entry, kind: p.kind, language: p.language, text: null, bytes: null, truncated: false, webUrl, reason: null };
  if (p.kind === "unsupported") return { ...o, reason: "type" };
  if (p.kind === "pdf") { const g = await get(CAPS.pdf); return g.truncated ? { ...o, reason: "too_large" } : { ...o, bytes: g.bytes }; }
  const g = await get(p.kind === "extracted" ? CAPS.extracted : CAPS.text);
  const text = decodeText(g.bytes);
  return text === null ? { ...o, kind: "unsupported", reason: "binary" } : { ...o, text, truncated: g.truncated };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && node --test --experimental-strip-types tests/sources-http.test.mjs && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/sources/http.ts web/src/sources/preview.ts web/src/sources/model.ts web/tests/sources-http.test.mjs
git commit -m "feat(web): guarded GET and preview rules for direct reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Web GitLab client (and the fake APIs)

**Files:**
- Create: `web/src/sources/gitlab.ts`, `web/tests/helpers/fake-sources.mjs`
- Test: `web/tests/sources-gitlab.test.mjs`

**Interfaces:**
- Consumes: `guardedGet`, `createPacer`, `parseJson`, `checkQuery`, `SourceError`, `Auth`, `HttpDeps` (Task 2); `CAPS`, `loadPreview`, `previewKind`; `dedupe`, `Entry`, `Page`, `ProjectRef`, `SourceClient`.
- Produces: `GITLAB_API`, `parseProject(o): Entry | null`, `nextPage(h: Headers): string | null`, `createGitLabClient(auth: Auth, d?: HttpDeps): SourceClient`. Fake: `createFakeSources(): { fetchImpl, calls, tokens, queue(prefix, ...responses), json }`, `BOX_SECRET`.

- [ ] **Step 1: Write the fake** `web/tests/helpers/fake-sources.mjs`

```js
// Fake gitlab.com and Box APIs behind one fetch (no network). Every call is recorded. `queue(prefix, ...fns)` answers
// the next calls whose URL starts with `prefix` with `fn()` first (429, 401, 202...). Tokens rotate like the real ones:
// each exchange or refresh issues `<p>-access-<n>` / `<p>-refresh-<n>` and the old refresh token stops working.
const te = (s) => new TextEncoder().encode(s);
export const BOX_SECRET = 'boxsecret0123456789abcdef';

export function createFakeSources() {
  const gen = { gitlab: 1, box: 1 };
  const tokens = { gitlab: 'gitlab-access-1', box: 'box-access-1' };
  const calls = []; const canned = [];
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const bytes = (b) => new Response(b, { status: 200 });

  function oauth(p, init) {
    const f = new URLSearchParams(init.body); calls.at(-1).form = Object.fromEntries(f);
    if (f.get('grant_type') === 'authorization_code') {
      if (f.get('code') !== 'good-code-123' || !f.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
      if (p === 'box' && f.get('client_secret') !== BOX_SECRET) return json({ error: 'invalid_client' }, 400);
    } else if (f.get('grant_type') === 'refresh_token') {
      if (f.get('refresh_token') !== `${p}-refresh-${gen[p]}`) return json({ error: 'invalid_grant' }, 400);
    } else return json({ error: 'unsupported_grant_type' }, 400);
    gen[p] += 1; tokens[p] = `${p}-access-${gen[p]}`;
    return json({ access_token: tokens[p], refresh_token: `${p}-refresh-${gen[p]}`, expires_in: p === 'gitlab' ? 7200 : 3600, token_type: 'bearer', ...(p === 'gitlab' ? { scope: 'read_api read_repository' } : {}) });
  }

  const gitFiles = new Map([
    ['README.md', te('# Demo\n\n<script>alert(1)</script>\n')], ['src/app.ts', te('export const x = 1;\n')],
    ['logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0])], ['big.txt', new Uint8Array(1_048_576 + 10).fill(97)], ['doc.pdf', te('%PDF-1.4\n')],
  ]);
  const project = { id: 7, name: 'demo', path_with_namespace: 'dee/demo', default_branch: 'main', web_url: 'https://gitlab.com/dee/demo' };
  function gitlab(u, init) {
    if (u.pathname === '/oauth/token') return oauth('gitlab', init);
    if (u.pathname === '/oauth/revoke') { calls.at(-1).form = Object.fromEntries(new URLSearchParams(init.body)); return json({}); }
    if (init?.headers?.Authorization !== `Bearer ${tokens.gitlab}`) return json({ message: '401 Unauthorized' }, 401);
    const p = u.pathname;
    if (p === '/api/v4/projects') {
      const all = [project, { id: 8, name: 'empty', path_with_namespace: 'dee/empty', default_branch: null, web_url: 'https://gitlab.com/dee/empty' }, { id: 'bad' }, { ...project, web_url: 'https://evil.example/x' }];
      const q = u.searchParams.get('search');
      return json(q ? all.filter((x) => typeof x.name === 'string' && x.name.includes(q)) : all, 200, { 'x-next-page': '' });
    }
    if (p === '/api/v4/projects/7/repository/tree') {
      if (u.searchParams.get('path') === 'src') return json([{ id: 's1', name: 'app.ts', type: 'blob', path: 'src/app.ts' }], 200, { 'x-next-page': '' });
      if (u.searchParams.get('page') === '2') return json([{ id: 'b3', name: 'logo.png', type: 'blob', path: 'logo.png' }, { id: 'b4', name: 'big.txt', type: 'blob', path: 'big.txt' }, { id: 'b5', name: 'doc.pdf', type: 'blob', path: 'doc.pdf' }], 200, { 'x-next-page': '' });
      return json([{ id: 't1', name: 'src', type: 'tree', path: 'src' }, { id: 'b1', name: 'README.md', type: 'blob', path: 'README.md' }, { id: 'c1', name: 'vendor', type: 'commit', path: 'vendor' }], 200, { 'x-next-page': '2' });
    }
    const raw = /^\/api\/v4\/projects\/7\/repository\/files\/([^/]+)\/raw$/.exec(p); // pathname keeps %2F encoded
    if (raw) { const f = gitFiles.get(decodeURIComponent(raw[1])); return f ? bytes(f) : json({ message: '404 File Not Found' }, 404); }
    if (p === '/api/v4/projects/7/search') return json([{ basename: 'app', data: 'export const x = 1;', path: 'src/app.ts', filename: 'src/app.ts', ref: 'main', startline: 1 }, { basename: 'app', data: 'again', path: 'src/app.ts', filename: 'src/app.ts', ref: 'main', startline: 9 }]);
    return json({ message: '404 Not Found' }, 404);
  }

  const boxFiles = new Map([['21', te('# Notes\n')], ['23', te('%PDF-1.4\n')], ['24', new Uint8Array([0, 1, 2])]]);
  const REP = 'https://dl.boxcloud.com/api/2.0/internal_files/22/versions/1/representations/extracted_text/content/{+asset_path}';
  function box(u, init) {
    if (u.hostname === 'api.box.com' && u.pathname === '/oauth2/token') return oauth('box', init);
    if (u.pathname === '/oauth2/revoke') { calls.at(-1).form = Object.fromEntries(new URLSearchParams(init.body)); return json({}); }
    if (init?.headers?.Authorization !== `Bearer ${tokens.box}`) return json({ type: 'error', status: 401, code: 'unauthorized' }, 401);
    const p = u.pathname;
    if (p === '/2.0/folders/0/items') return json({ total_count: 3, entries: [{ type: 'folder', id: '11', name: 'Specs' }, { type: 'file', id: '21', name: 'notes.md', size: 8 }, { type: 'web_link', id: '31', name: 'Link' }] });
    if (p === '/2.0/folders/11/items') return json({ entries: [{ type: 'file', id: '22', name: 'plan.docx', size: 5000 }, { type: 'file', id: '23', name: 'deck.pdf', size: 9 }, { type: 'file', id: '25', name: 'scan.docx', size: 10 }, { type: 'file', id: '24', name: 'raw.txt', size: 3 }] });
    if (p === '/2.0/folders/12/items') { const off = Number(u.searchParams.get('offset')); return json({ entries: Array.from({ length: off === 0 ? 100 : 3 }, (_, i) => ({ type: 'file', id: String(1000 + off + i), name: `f${off + i}.txt`, size: 1 })) }); }
    const content = /^\/2\.0\/files\/(\d+)\/content$/.exec(p);
    if (content) { const f = boxFiles.get(content[1]); return f ? bytes(f) : json({ code: 'not_found' }, 404); }
    if (p === '/2.0/files/22') return json({ representations: { entries: [{ representation: 'extracted_text', status: { state: 'pending' }, info: { url: 'https://api.box.com/2.0/internal_files/22/versions/1/representations/extracted_text' }, content: { url_template: REP } }] } });
    if (p === '/2.0/internal_files/22/versions/1/representations/extracted_text') return json({ status: { state: 'success' }, content: { url_template: REP } });
    if (p === '/2.0/files/25') return json({ representations: { entries: [] } });
    if (u.hostname === 'dl.boxcloud.com' && p === '/api/2.0/internal_files/22/versions/1/representations/extracted_text/content/') return bytes(te('Plan text from Box'));
    if (p === '/2.0/search') return json({ entries: [{ type: 'file', id: '22', name: 'plan.docx', size: 5000, path_collection: { entries: [{ id: '0', name: 'All Files' }, { id: '11', name: 'Specs' }] } }] });
    return json({ code: 'not_found' }, 404);
  }

  async function fetchImpl(input, init = {}) {
    const url = String(input); const u = new URL(url);
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {} });
    const i = canned.findIndex((c) => url.startsWith(c.prefix));
    if (i >= 0) { const c = canned[i]; const fn = c.responses.shift(); if (!c.responses.length) canned.splice(i, 1); return fn(); }
    if (u.hostname === 'gitlab.com') return gitlab(u, init);
    if (u.hostname === 'api.box.com' || u.hostname === 'dl.boxcloud.com') return box(u, init);
    throw new TypeError('fetch failed');
  }
  return { fetchImpl, calls, tokens, json, queue(prefix, ...responses) { canned.push({ prefix, responses }); } };
}
```

- [ ] **Step 2: Write the failing test** `web/tests/sources-gitlab.test.mjs`

```js
// GitLab client on the fake gitlab.com: projects (bad rows dropped), tree paging, submodules skipped, raw files by
// preview kind, blob search, web URLs, and the token in every request. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSources } from './helpers/fake-sources.mjs';
import { createGitLabClient, parseProject } from '../src/sources/gitlab.ts';

const setup = () => { const fake = createFakeSources(); const auth = { token: async () => fake.tokens.gitlab, refresh: async () => null };
  return { fake, c: createGitLabClient(auth, { fetchImpl: fake.fetchImpl, sleep: async () => {} }) }; };

test('projects: membership list, invalid or foreign rows dropped, empty project marked', async () => {
  const { fake, c } = setup();
  const page = await c.list(null, null);
  assert.deepEqual(page.entries.map((e) => e.path), ['dee/demo', 'dee/empty']);
  assert.equal(page.entries[1].detail, 'Empty project');
  assert.equal(page.next, null);
  const u = new URL(fake.calls[0].url);
  assert.equal(u.searchParams.get('membership'), 'true');
  assert.equal(fake.calls[0].headers.Authorization, 'Bearer gitlab-access-1');
  assert.equal(parseProject({ id: 1, name: 'x', path_with_namespace: 'a/x', web_url: 'http://gitlab.com/a/x' }), null);
  assert.deepEqual((await c.list(page.entries[1], null)).entries, [], 'no default branch: nothing to list, no request');
});

test('tree: pages through X-Next-Page, skips submodules, descends into folders', async () => {
  const { c } = setup();
  const [demo] = (await c.list(null, null)).entries;
  const p1 = await c.list(demo, null);
  assert.deepEqual(p1.entries.map((e) => [e.name, e.kind]), [['src', 'dir'], ['README.md', 'file']]);
  assert.equal(p1.next, '2');
  const p2 = await c.list(demo, p1.next);
  assert.deepEqual(p2.entries.map((e) => e.name), ['logo.png', 'big.txt', 'doc.pdf']);
  const src = await c.list(p1.entries[0], null);
  assert.deepEqual(src.entries.map((e) => e.path), ['src/app.ts']);
  assert.equal(src.entries[0].id, '7:src/app.ts');
});

test('open: code and markdown as text, binary refused, over-cap text truncated, pdf bytes; raw path is encoded', async () => {
  const { fake, c } = setup();
  const [demo] = (await c.list(null, null)).entries;
  const root = [...(await c.list(demo, null)).entries, ...(await c.list(demo, '2')).entries];
  const src = (await c.list(root[0], null)).entries[0];
  const app = await c.open(src);
  assert.equal(app.kind, 'code'); assert.equal(app.language, 'typescript'); assert.equal(app.text, 'export const x = 1;\n');
  assert.match(fake.calls.at(-1).url, /\/repository\/files\/src%2Fapp\.ts\/raw\?ref=main$/);
  const readme = await c.open(root.find((e) => e.name === 'README.md'));
  assert.equal(readme.kind, 'markdown'); assert.match(readme.text, /<script>/, 'kept as text; the screen renders it as text');
  assert.equal((await c.open(root.find((e) => e.name === 'logo.png'))).reason, 'type');
  const big = await c.open(root.find((e) => e.name === 'big.txt'));
  assert.equal(big.truncated, true); assert.equal(big.text.length, 1_048_576);
  const pdf = await c.open(root.find((e) => e.name === 'doc.pdf'));
  assert.equal(pdf.kind, 'pdf'); assert.ok(pdf.bytes instanceof Uint8Array);
  assert.equal(c.webUrl(src), 'https://gitlab.com/dee/demo/-/blob/main/src/app.ts');
  assert.equal(c.webUrl(root[0]), 'https://gitlab.com/dee/demo/-/tree/main/src');
});

test('search: projects at the root, blobs inside a project (deduplicated, snippet kept as text)', async () => {
  const { fake, c } = setup();
  assert.deepEqual((await c.search('dem', null)).entries.map((e) => e.path), ['dee/demo']);
  const [demo] = (await c.list(null, null)).entries;
  const hits = await c.search(' x ', demo);
  assert.deepEqual(hits.entries.map((e) => [e.path, e.detail]), [['src/app.ts', 'export const x = 1;']]);
  const u = new URL(fake.calls.at(-1).url);
  assert.equal(u.searchParams.get('scope'), 'blobs'); assert.equal(u.searchParams.get('search'), 'x');
  await assert.rejects(c.search('', demo), (e) => e.code === 'bad_query');
});

test('only GET requests reach the API', async () => {
  const { fake, c } = setup();
  const [demo] = (await c.list(null, null)).entries;
  await c.list(demo, null); await c.search('x', demo);
  assert.ok(fake.calls.every((k) => k.method === 'GET'));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/sources-gitlab.test.mjs`
Expected: FAIL (`Cannot find module '../src/sources/gitlab.ts'`).

- [ ] **Step 4: Implement** `web/src/sources/gitlab.ts`

```ts
// GitLab code at the source (design 9, Q12): projects the user is a member of, the repository tree, one raw file, blob
// search. gitlab.com only (decision D1); it answers CORS with `*` for these GETs (checked 2026-11-06). Paced at 60/min:
// the Free plan's authenticated burst is 100/min.
import { checkQuery, createPacer, guardedGet, parseJson, SourceError, type Auth, type HttpDeps } from "./http.ts";
import { CAPS, loadPreview, previewKind } from "./preview.ts";
import { dedupe, type Entry, type Page, type ProjectRef, type SourceClient } from "./model.ts";

export const GITLAB_API = "https://gitlab.com/api/v4";
const enc = encodeURIComponent;
const str = (v: unknown, max = 1024): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

export function parseProject(o: any): Entry | null {
  const id = o?.id, path = str(o?.path_with_namespace), name = str(o?.name, 255), web = str(o?.web_url);
  if (!Number.isInteger(id) || id <= 0 || !path || !name || !web || !web.startsWith("https://gitlab.com/")) return null;
  const ref = str(o?.default_branch, 255) ?? "";
  return { id: `p${id}`, name, kind: "project", path, size: null, detail: ref ? null : "Empty project", project: { id, ref, webUrl: web } };
}
export function nextPage(h: Headers): string | null { const n = h.get("x-next-page"); return n && /^\d{1,6}$/.test(n) ? n : null; }

export function createGitLabClient(auth: Auth, d: HttpDeps = {}): SourceClient {
  const pacer = createPacer(60, d);
  const get = (url: string, cap: number = CAPS.json) => guardedGet(url, auth, pacer, cap, d);
  async function array(url: string): Promise<{ items: any[]; next: string | null }> {
    const g = await get(url); const j = parseJson(g);
    if (!Array.isArray(j)) throw new SourceError("bad_response");
    return { items: j, next: nextPage(g.headers) };
  }
  async function projects(q: string | null, page: string): Promise<Page> {
    const { items, next } = await array(`${GITLAB_API}/projects?membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=50&page=${page}${q ? `&search=${enc(q)}` : ""}`);
    return { entries: dedupe(items.map(parseProject).filter((e): e is Entry => e !== null)), next };
  }
  const fileEntry = (p: ProjectRef, path: string, name: string, kind: "dir" | "file", detail: string | null = null): Entry =>
    ({ id: `${p.id}:${path}`, name, kind, path, size: null, detail, project: p });
  const webUrl = (e: Entry): string | null => {
    const p = e.project; if (!p) return null;
    if (e.kind === "project") return p.webUrl;
    return `${p.webUrl}/-/${e.kind === "dir" ? "tree" : "blob"}/${enc(p.ref)}/${e.path.split("/").map(enc).join("/")}`;
  };
  return {
    provider: "gitlab",
    async list(dir, cursor) {
      const page = cursor && /^\d{1,6}$/.test(cursor) ? cursor : "1";
      if (!dir) return projects(null, page);
      const p = dir.project; if (!p) throw new SourceError("bad_response");
      if (!p.ref) return { entries: [], next: null };
      const { items, next } = await array(`${GITLAB_API}/projects/${p.id}/repository/tree?ref=${enc(p.ref)}&per_page=100&page=${page}${dir.kind === "dir" ? `&path=${enc(dir.path)}` : ""}`);
      // "commit" rows are submodules: another repository, not shown.
      const entries = items.flatMap((o) => { const name = str(o?.name, 255), path = str(o?.path); return name && path && (o.type === "tree" || o.type === "blob") ? [fileEntry(p, path, name, o.type === "tree" ? "dir" : "file")] : []; });
      return { entries, next };
    },
    async open(file) {
      const p = file.project; if (!p) throw new SourceError("bad_response");
      return loadPreview(file, previewKind(file.name, "gitlab"), webUrl(file), (cap) => get(`${GITLAB_API}/projects/${p.id}/repository/files/${enc(file.path)}/raw?ref=${enc(p.ref)}`, cap));
    },
    async search(q, within) {
      const t = checkQuery(q); const p = within?.project;
      if (!p) return projects(t, "1");
      if (!p.ref) return { entries: [], next: null };
      const { items } = await array(`${GITLAB_API}/projects/${p.id}/search?scope=blobs&search=${enc(t)}&ref=${enc(p.ref)}&per_page=20`);
      const entries = items.flatMap((o) => {
        const path = str(o?.path) ?? str(o?.filename); if (!path) return [];
        return [fileEntry(p, path, path.slice(path.lastIndexOf("/") + 1), "file", typeof o?.data === "string" ? o.data.slice(0, 300) : null)];
      });
      return { entries: dedupe(entries), next: null };
    },
    webUrl,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd web && node --test --experimental-strip-types tests/sources-gitlab.test.mjs && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/sources/gitlab.ts web/tests/helpers/fake-sources.mjs web/tests/sources-gitlab.test.mjs
git commit -m "feat(web): GitLab read client for direct reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web Box client

**Files:**
- Create: `web/src/sources/box.ts`
- Test: `web/tests/sources-box.test.mjs`

**Interfaces:**
- Consumes: Task 2 exports; `createFakeSources` (Task 3).
- Produces: `BOX_API`, `parseBoxEntry(o, parentPath): Entry | null`, `createBoxClient(auth: Auth, d?: HttpDeps): SourceClient`.

- [ ] **Step 1: Write the failing test** `web/tests/sources-box.test.mjs`

```js
// Box client on the fake Box API: folders (web links dropped), page-length paging, content by preview kind, extracted
// text with one pending poll, missing text, search paths, web URLs. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSources } from './helpers/fake-sources.mjs';
import { createBoxClient, parseBoxEntry } from '../src/sources/box.ts';

const setup = () => { const fake = createFakeSources(); const slept = [];
  const auth = { token: async () => fake.tokens.box, refresh: async () => null };
  return { fake, slept, c: createBoxClient(auth, { fetchImpl: fake.fetchImpl, sleep: async (ms) => { slept.push(ms); } }) }; };
const dir = (id, name = 'Folder', path = name) => ({ id, name, kind: 'dir', path, size: null, detail: null, project: null });
const file = (id, name, path = name) => ({ id, name, kind: 'file', path, size: null, detail: null, project: null });

test('folders: root is 0, web links and bad ids dropped, paths built from the trail', async () => {
  const { fake, c } = setup();
  const root = await c.list(null, null);
  assert.deepEqual(root.entries.map((e) => [e.name, e.kind, e.size]), [['Specs', 'dir', null], ['notes.md', 'file', 8]]);
  assert.equal(root.next, null);
  assert.match(fake.calls[0].url, /\/2\.0\/folders\/0\/items\?fields=id,type,name,size,modified_at,extension&limit=100&offset=0$/);
  const specs = await c.list(root.entries[0], null);
  assert.equal(specs.entries[0].path, 'Specs/plan.docx');
  assert.equal(parseBoxEntry({ type: 'file', id: '../1', name: 'x' }, ''), null);
  await assert.rejects(c.list(dir('1/../2'), null), (e) => e.code === 'bad_response');
});

test('paging: a full page of 100 means more; the next page continues the offset', async () => {
  const { c } = setup();
  const p1 = await c.list(dir('12'), null);
  assert.equal(p1.entries.length, 100); assert.equal(p1.next, '100');
  const p2 = await c.list(dir('12'), p1.next);
  assert.equal(p2.entries.length, 3); assert.equal(p2.next, null);
});

test('open: markdown content, pdf bytes, binary refused, Office via extracted text after one poll, missing text', async () => {
  const { fake, slept, c } = setup();
  const md = await c.open(file('21', 'notes.md'));
  assert.equal(md.kind, 'markdown'); assert.equal(md.text, '# Notes\n');
  assert.equal((await c.open(file('23', 'deck.pdf'))).bytes.length, 9);
  assert.equal((await c.open(file('24', 'raw.txt'))).reason, 'binary');
  const plan = await c.open(file('22', 'plan.docx', 'Specs/plan.docx'));
  assert.equal(plan.kind, 'extracted'); assert.equal(plan.text, 'Plan text from Box');
  assert.ok(slept.includes(1500), 'waited once for the pending representation');
  const info = fake.calls.find((k) => k.url.includes('/2.0/files/22?fields=representations'));
  assert.equal(info.headers['X-Rep-Hints'], '[extracted_text]');
  assert.ok(fake.calls.some((k) => k.url.startsWith('https://dl.boxcloud.com/')));
  const scan = await c.open(file('25', 'scan.docx'));
  assert.equal(scan.reason, 'no_text'); assert.equal(scan.kind, 'unsupported');
  assert.equal(c.webUrl(file('22', 'plan.docx')), 'https://app.box.com/file/22');
  assert.equal(c.webUrl(dir('11')), 'https://app.box.com/folder/11');
});

test('search: files only, path from path_collection without "All Files", scoped to the open folder', async () => {
  const { fake, c } = setup();
  const r = await c.search('plan', dir('11', 'Specs'));
  assert.deepEqual(r.entries.map((e) => e.path), ['Specs/plan.docx']);
  const u = new URL(fake.calls.at(-1).url);
  assert.equal(u.searchParams.get('type'), 'file');
  assert.equal(u.searchParams.get('ancestor_folder_ids'), '11');
  await c.search('plan', null);
  assert.equal(new URL(fake.calls.at(-1).url).searchParams.has('ancestor_folder_ids'), false);
});

test('a 202 "not ready" answer is retried with Retry-After, then reported', async () => {
  const { fake, c } = setup();
  const notReady = () => new Response('', { status: 202, headers: { 'retry-after': '2' } });
  fake.queue('https://api.box.com/2.0/files/21/content', notReady, notReady, notReady);
  await assert.rejects(c.open(file('21', 'notes.md')), (e) => e.code === 'not_ready');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/sources-box.test.mjs`
Expected: FAIL (`Cannot find module '../src/sources/box.ts'`).

- [ ] **Step 3: Implement** `web/src/sources/box.ts`

```ts
// Box documents at the source (design 9, Q11): folder listing, one file's content or Box's extracted text, search.
// Scope root_readonly only. Paced at 240/min, well under Box's 1000/min per user. Shapes follow
// extension/connectors/box.mjs (parseFolderItems, fetchExtractedText, page length as the end signal).
import { checkQuery, createPacer, guardedGet, parseJson, SourceError, type Auth, type HttpDeps } from "./http.ts";
import { CAPS, loadPreview, previewKind } from "./preview.ts";
import { dedupe, type Entry, type SourceClient } from "./model.ts";

export const BOX_API = "https://api.box.com/2.0";
const FIELDS = "id,type,name,size,modified_at,extension";
const ID = /^\d{1,20}$/;
const PAGE = 100;

export function parseBoxEntry(o: any, parentPath: string): Entry | null {
  const id = typeof o?.id === "string" ? o.id : "", name = typeof o?.name === "string" ? o.name : "";
  if ((o?.type !== "file" && o?.type !== "folder") || !ID.test(id) || !name || name.length > 255) return null;
  return { id, name, kind: o.type === "folder" ? "dir" : "file", path: parentPath ? `${parentPath}/${name}` : name,
    size: Number.isSafeInteger(o?.size) && o.size >= 0 ? o.size : null, detail: null, project: null };
}

export function createBoxClient(auth: Auth, d: HttpDeps = {}): SourceClient {
  const pacer = createPacer(240, d);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const get = (url: string, cap: number = CAPS.json, headers: Record<string, string> = {}) => guardedGet(url, auth, pacer, cap, d, headers);
  async function obj(url: string, headers: Record<string, string> = {}): Promise<any> {
    const j = parseJson(await get(url, CAPS.json, headers));
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new SourceError("bad_response");
    return j;
  }
  const checkId = (id: string) => { if (!ID.test(id)) throw new SourceError("bad_response"); return id; };
  async function extractedTextUrl(id: string): Promise<string | null> {
    const info = await obj(`${BOX_API}/files/${id}?fields=representations`, { "X-Rep-Hints": "[extracted_text]" });
    const reps: any[] = Array.isArray(info?.representations?.entries) ? info.representations.entries : [];
    const rep = reps.find((r) => r?.representation === "extracted_text");
    if (!rep) return null;
    let state = rep.status?.state; let template = rep.content?.url_template; const infoUrl = rep.info?.url;
    for (let i = 0; (state === "pending" || state === "none") && typeof infoUrl === "string" && i < 3; i++) {
      await sleep(1500);
      const p = await obj(infoUrl);
      state = p?.status?.state; template = p?.content?.url_template ?? template;
    }
    return state === "success" && typeof template === "string" ? template.replace("{+asset_path}", "") : null;
  }
  const webUrl = (e: Entry) => `https://app.box.com/${e.kind === "dir" ? "folder" : "file"}/${e.id}`;
  const parents = (o: any): string => (Array.isArray(o?.path_collection?.entries) ? o.path_collection.entries : [])
    .map((p: any) => (typeof p?.name === "string" ? p.name : "")).filter((n: string) => n && n !== "All Files").join("/");
  return {
    provider: "box",
    async list(dir, cursor) {
      const offset = cursor && /^\d{1,7}$/.test(cursor) ? Number(cursor) : 0;
      const id = checkId(dir?.id ?? "0");
      const j = await obj(`${BOX_API}/folders/${id}/items?fields=${FIELDS}&limit=${PAGE}&offset=${offset}`);
      const raw: any[] = Array.isArray(j.entries) ? j.entries : [];
      // Page length is the end signal (box.mjs B4): total_count can be missing.
      return { entries: raw.map((o) => parseBoxEntry(o, dir?.path ?? "")).filter((e): e is Entry => e !== null), next: raw.length === PAGE ? String(offset + PAGE) : null };
    },
    async open(file) {
      const id = checkId(file.id); const kind = previewKind(file.name, "box");
      if (kind.kind === "extracted") {
        const url = await extractedTextUrl(id);
        if (!url) return { entry: file, kind: "unsupported", language: kind.language, text: null, bytes: null, truncated: false, webUrl: webUrl(file), reason: "no_text" };
        return loadPreview(file, kind, webUrl(file), (cap) => get(url, cap));
      }
      return loadPreview(file, kind, webUrl(file), (cap) => get(`${BOX_API}/files/${id}/content`, cap));
    },
    async search(q, within) {
      const t = checkQuery(q);
      const scope = within?.kind === "dir" ? `&ancestor_folder_ids=${checkId(within.id)}` : "";
      const j = await obj(`${BOX_API}/search?query=${encodeURIComponent(t)}&type=file&limit=20&fields=${FIELDS},path_collection${scope}`);
      const raw: any[] = Array.isArray(j.entries) ? j.entries : [];
      return { entries: dedupe(raw.map((o) => parseBoxEntry(o, parents(o))).filter((e): e is Entry => e !== null)), next: null };
    },
    webUrl,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && node --test --experimental-strip-types tests/sources-box.test.mjs && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/sources/box.ts web/tests/sources-box.test.mjs
git commit -m "feat(web): Box read client for direct reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web app settings store and sources controller

**Files:**
- Create: `web/src/sources/config.ts`, `web/src/sources/controller.ts`, `web/tests/helpers/fake-idb.mjs`
- Modify: `web/tests/sync-keystore.test.mjs` (import `fakeIdb` from the helper instead of its local copy)
- Test: `web/tests/sources-controller.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`authorizeUrl`, `callbackUrl`, `challengeFor`, `checkConfig`, `exchangeCode`, `OAuthError`, `randomString`, `refreshTokens`, `revokeToken`, `waitForCode`, `CHANNEL`, `ChannelLike`, `Every`, `Provider`, `ProviderConfig`, `Tokens`); Task 2 (`SourceError`, `Auth`, `MAX_QUERY`); Tasks 3–4 clients.
- Produces:
  - `config.ts`: `interface SourcesConfig { v: 1; gitlab: ProviderConfig | null; box: ProviderConfig | null }`, `interface SourcesConfigStore { load(): Promise<SourcesConfig | null>; save(c: SourcesConfig): Promise<void> }`, `memorySourcesConfig()`, `indexedDbSourcesConfig(idb?): SourcesConfigStore | null`
  - `controller.ts`: `TEXT: Record<string, string>`, `interface PopupLike`, `interface SourcesDeps`, `interface SourcesState`, `interface SourcesController` (methods listed in the code), `createSourcesController(given?: Partial<SourcesDeps>): SourcesController`

- [ ] **Step 1: Move the fake IndexedDB into a helper**

Create `web/tests/helpers/fake-idb.mjs` with the body of the `fakeIdb()` function that is in `web/tests/sync-keystore.test.mjs` today (lines 24–41), exported:

```js
// A small in-memory IndexedDB factory for the keystore and sources-config tests (open, one store, get/put/delete).
export function fakeIdb() {
  const data = new Map(); let created = false;
  const request = (fn, after) => {
    const r = { onsuccess: null, onerror: null, result: undefined, error: null };
    queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); after?.(); } catch (e) { r.error = e; r.onerror?.(); } });
    return r;
  };
  const db = {
    createObjectStore: () => { created = true; },
    transaction: () => {
      const t = { oncomplete: null, onerror: null, onabort: null, error: null };
      const done = () => queueMicrotask(() => t.oncomplete?.());
      t.objectStore = () => ({ get: (k) => request(() => data.get(k)), put: (v, k) => request(() => { data.set(k, v); }, done), delete: (k) => request(() => { data.delete(k); }, done) });
      return t;
    },
  };
  return { data, open: () => { const r = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db }; queueMicrotask(() => { if (!created) r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
}
```

In `web/tests/sync-keystore.test.mjs`, delete the local `function fakeIdb() { … }` and add `import { fakeIdb } from './helpers/fake-idb.mjs';` after the other imports. Run `cd web && node --test --experimental-strip-types tests/sync-keystore.test.mjs`. Expected: PASS (unchanged behaviour).

- [ ] **Step 2: Write the failing test** `web/tests/sources-controller.test.mjs`

```js
// The sources controller on the fake APIs: pop-up sign-in with PKCE (state checked, popup blocked/closed), tokens in
// memory only, one refresh in flight (Box refresh tokens are single use), browse/search/open, sign-out revokes,
// offline refusals, and app settings persisted without tokens. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSources, BOX_SECRET } from './helpers/fake-sources.mjs';
import { fakeIdb } from './helpers/fake-idb.mjs';
import { createSourcesController, TEXT } from '../src/sources/controller.ts';
import { indexedDbSourcesConfig, memorySourcesConfig } from '../src/sources/config.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const GL = { clientId: 'a'.repeat(64) };
const BOX = { clientId: 'b'.repeat(32), clientSecret: BOX_SECRET };

function harness(over = {}) {
  const fake = createFakeSources();
  const h = { fake, popups: [], channel: null, ticker: null, clock: 1_000_000, online: true };
  h.deps = {
    config: memorySourcesConfig(), fetchImpl: fake.fetchImpl, now: () => h.clock, sleep: async () => {},
    online: () => h.online, onNetwork: () => () => {},
    openPopup: () => { const w = { location: { href: '' }, closed: false, close() { this.closed = true; } }; h.popups.push(w); return w; },
    channel: () => (h.channel = { onmessage: null, close() {} }),
    every: (fn) => { h.ticker = fn; return () => { h.ticker = null; }; },
    baseURI: () => 'https://llm-ide.com/app/', random: (n) => new Uint8Array(n).fill(7),
    ...over,
  };
  h.c = createSourcesController(h.deps);
  return h;
}
async function signIn(h, p) {
  const done = h.c.signIn(p);
  for (let i = 0; i < 20 && !h.popups.at(-1)?.location.href; i++) await tick();
  const url = new URL(h.popups.at(-1).location.href);
  h.channel.onmessage({ data: { state: 'forged', code: 'evil-code-123' } });
  h.channel.onmessage({ data: { state: url.searchParams.get('state'), code: 'good-code-123' } });
  await done;
  return url;
}

test('GitLab: configure, sign in with PKCE in a pop-up, browse, page, open, search', async () => {
  const h = harness(); await h.c.start();
  assert.equal(await h.c.configure('gitlab', GL), true);
  const url = await signIn(h, 'gitlab');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://llm-ide.com/app/oauth-callback.html');
  assert.equal(url.searchParams.get('scope'), 'read_api read_repository');
  assert.equal(h.popups[0].closed, true);
  const tok = h.fake.calls.find((k) => k.url === 'https://gitlab.com/oauth/token');
  assert.equal(tok.form.code, 'good-code-123'); assert.match(tok.form.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(h.c.getState().signedIn.gitlab, true);
  await h.c.choose('gitlab');
  assert.deepEqual(h.c.getState().entries.map((e) => e.name), ['demo', 'empty']);
  await h.c.openEntry(h.c.getState().entries[0]);
  assert.deepEqual(h.c.getState().trail.map((e) => e.name), ['demo']);
  assert.equal(h.c.getState().next, '2');
  await h.c.more();
  assert.equal(h.c.getState().entries.length, 5);
  await h.c.openEntry(h.c.getState().entries.find((e) => e.name === 'README.md'));
  assert.equal(h.c.getState().opened.kind, 'markdown');
  h.c.closeFile();
  await h.c.search('x');
  assert.equal(h.c.getState().query, 'x');
  assert.deepEqual(h.c.getState().entries.map((e) => e.path), ['src/app.ts']);
  await h.c.clearSearch();
  await h.c.toCrumb(-1);
  assert.deepEqual(h.c.getState().trail, []);
  assert.equal(h.c.getState().entries[0].kind, 'project');
});

test('pop-up blocked, closed pop-up, offline, and an unconfigured provider are refused with sentences', async () => {
  const blocked = harness({ openPopup: () => null }); await blocked.c.start(); await blocked.c.configure('gitlab', GL);
  await blocked.c.signIn('gitlab');
  assert.equal(blocked.c.getState().error, TEXT.popup_blocked);
  const h = harness(); await h.c.start(); await h.c.configure('gitlab', GL);
  const p = h.c.signIn('gitlab');
  for (let i = 0; i < 20 && !h.popups[0].location.href; i++) await tick();
  h.popups[0].closed = true; h.ticker();
  await p;
  assert.equal(h.c.getState().error, TEXT.sign_in_cancelled);
  assert.equal(h.c.getState().signedIn.gitlab, false);
  h.online = false;
  await h.c.signIn('gitlab');
  assert.equal(h.c.getState().error, TEXT.offline);
  await h.c.signIn('box');
  assert.equal(h.c.getState().error, TEXT.not_configured);
});

test('a token response with a write scope is refused and nothing is kept', async () => {
  const h = harness(); await h.c.start(); await h.c.configure('gitlab', GL);
  h.fake.queue('https://gitlab.com/oauth/token', () => h.fake.json({ access_token: 'acc-12345678', refresh_token: 'r', expires_in: 7200, scope: 'api' }));
  await signIn(h, 'gitlab');
  assert.equal(h.c.getState().error, TEXT.scope_too_wide);
  assert.equal(h.c.getState().signedIn.gitlab, false);
});

test('Box: expired token refreshes once for parallel calls (single-use refresh), a refused refresh signs out', async () => {
  const h = harness(); await h.c.start(); await h.c.configure('box', BOX);
  await signIn(h, 'box');
  assert.equal(h.fake.calls.find((k) => k.url === 'https://api.box.com/oauth2/token').form.client_secret, BOX_SECRET);
  await h.c.choose('box');
  h.clock += 2 * 3600_000; // past expiry
  await Promise.all([h.c.choose('box'), h.c.openEntry({ id: '11', name: 'Specs', kind: 'dir', path: 'Specs', size: null, detail: null, project: null })]);
  const refreshes = h.fake.calls.filter((k) => k.url === 'https://api.box.com/oauth2/token' && k.form?.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(h.c.getState().signedIn.box, true);
  h.clock += 2 * 3600_000;
  h.fake.queue('https://api.box.com/oauth2/token', () => h.fake.json({ error: 'invalid_grant' }, 400));
  await h.c.choose('box');
  assert.equal(h.c.getState().error, TEXT.signed_out);
  assert.equal(h.c.getState().signedIn.box, false);
});

test('sign out revokes the token, forgets it in memory, and leaves the browser view', async () => {
  const h = harness(); await h.c.start(); await h.c.configure('gitlab', GL);
  await signIn(h, 'gitlab'); await h.c.choose('gitlab');
  await h.c.signOut('gitlab');
  const rv = h.fake.calls.find((k) => k.url === 'https://gitlab.com/oauth/revoke');
  assert.equal(rv.form.token, 'gitlab-access-2');
  assert.equal(h.c.getState().signedIn.gitlab, false);
  assert.equal(h.c.getState().provider, null);
});

test('app settings persist in IndexedDB without tokens; bad stored rows are ignored', async () => {
  const idb = fakeIdb();
  const h = harness({ config: indexedDbSourcesConfig(idb) }); await h.c.start();
  await h.c.configure('gitlab', GL); await h.c.configure('box', BOX);
  await signIn(h, 'gitlab');
  const stored = JSON.stringify([...idb.data.values()]);
  assert.match(stored, new RegExp(GL.clientId));
  assert.doesNotMatch(stored, /access|refresh|verifier/);
  idb.data.set('config', { v: 1, gitlab: { clientId: 'x' }, box: BOX });
  const again = harness({ config: indexedDbSourcesConfig(idb) }); await again.c.start();
  assert.deepEqual(again.c.getState().configured, { gitlab: false, box: true });
  assert.equal(again.c.getState().signedIn.gitlab, false, 'a reload means signing in again (decision D4)');
});

test('bad search input and offline browsing are explained', async () => {
  const h = harness(); await h.c.start(); await h.c.configure('gitlab', GL); await signIn(h, 'gitlab');
  await h.c.choose('gitlab');
  await h.c.search('   ');
  assert.equal(h.c.getState().error, TEXT.bad_query);
  h.online = false;
  await h.c.toCrumb(-1);
  assert.equal(h.c.getState().error, TEXT.offline);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/sources-controller.test.mjs`
Expected: FAIL (`Cannot find module '../src/sources/controller.ts'`).

- [ ] **Step 4: Implement**

`web/src/sources/config.ts`:

```ts
// App settings for direct reads (decisions D5, D6): the GitLab application ID and the Box app's client ID and secret,
// in IndexedDB `llmide-sources`. Never tokens. Known risk: script running on this origin could read the Box secret; the
// CSP allows no inline or third-party script, and the secret works only with the user's own Box login and redirect URI.
import type { ProviderConfig } from "./oauth.ts";

export interface SourcesConfig { v: 1; gitlab: ProviderConfig | null; box: ProviderConfig | null }
export interface SourcesConfigStore { load(): Promise<SourcesConfig | null>; save(c: SourcesConfig): Promise<void> }

export function memorySourcesConfig(): SourcesConfigStore {
  let c: SourcesConfig | null = null;
  return { load: async () => c, save: async (x) => { c = x; } };
}

const DB = "llmide-sources"; const STORE = "config"; const KEY = "config";
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export function indexedDbSourcesConfig(idb: IDBFactory | undefined = globalThis.indexedDB): SourcesConfigStore | null {
  if (!idb) return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= new Promise<IDBDatabase>((res, rej) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
  return {
    async load() { return ((await req((await db()).transaction(STORE, "readonly").objectStore(STORE).get(KEY))) as SourcesConfig | undefined) ?? null; },
    async save(c) { const t = (await db()).transaction(STORE, "readwrite"); const end = done(t); t.objectStore(STORE).put(c, KEY); await end; },
  };
}
```

`web/src/sources/controller.ts`:

```ts
// Direct reads at the source (design 9; no React): sign in to GitLab or Box with read-only OAuth in a pop-up, then
// browse, search and open one file read-only. Tokens live in this controller's memory only (decision D4); app settings
// come from config.ts (D5). Nothing read from a provider is stored.
import { authorizeUrl, callbackUrl, challengeFor, checkConfig, CHANNEL, exchangeCode, OAuthError, randomString, refreshTokens, revokeToken, waitForCode,
  type ChannelLike, type Every, type Provider, type ProviderConfig, type Tokens } from "./oauth.ts";
import { MAX_QUERY, SourceError, type Auth } from "./http.ts";
import { createGitLabClient } from "./gitlab.ts";
import { createBoxClient } from "./box.ts";
import { indexedDbSourcesConfig, memorySourcesConfig, type SourcesConfig, type SourcesConfigStore } from "./config.ts";
import type { Entry, Opened, SourceClient } from "./model.ts";

export const TEXT: Record<string, string> = {
  offline: "You are offline. Documents and code are read live from Box and GitLab and are not kept on this device.",
  unreachable: "The provider is not reachable. Check the network. For Box, also check that this site is in your Box app's CORS domains.",
  timeout: "The provider took too long to answer.",
  signed_out: "Your sign-in ended. Sign in again.",
  forbidden: "The provider refused access to this item.",
  not_found: "Not found. It may have moved or been deleted.",
  rate_limited: "The provider asked us to slow down. Wait a minute and try again.",
  too_large: "Too large to show here. Open it on the provider's site.",
  cors_origin: "Box refused this site. Add this site's address to your Box app's CORS domains.",
  not_ready: "Box is still preparing this file. Try again in a moment.",
  refused_host: "The provider sent us to an address this app does not trust.",
  bad_response: "The provider sent an answer this app cannot read.",
  provider_error: "The provider had an error. Try again later.",
  bad_query: `Enter 1 to ${MAX_QUERY} characters to search.`,
  popup_blocked: "Allow pop-ups for this site to sign in.",
  sign_in_timeout: "Sign-in took too long. Try again.",
  sign_in_cancelled: "Sign-in was cancelled.",
  sign_in_failed: "Sign-in failed.",
  grant_expired: "The sign-in code expired. Try again.",
  client_refused: "The provider refused this app's ID or secret. Check the app settings.",
  bad_client_id: "Enter the application (client) ID from the provider's developer settings.",
  bad_client_secret: "Enter the Box app's client secret.",
  bad_token_response: "The provider sent a sign-in answer this app cannot read.",
  scope_too_wide: "The provider granted more than read access. Use an app limited to read scopes.",
  not_configured: "Set up the app first.",
  not_saved: "This browser cannot keep the app settings (private window or blocked site data). They last for this page only.",
};

export interface PopupLike { location: { href: string }; close(): void; readonly closed: boolean }
export interface SourcesDeps {
  config: SourcesConfigStore; fetchImpl: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void>;
  online: () => boolean; onNetwork: (fn: (online: boolean) => void) => () => void;
  openPopup: () => PopupLike | null; channel: () => ChannelLike; every?: Every; baseURI: () => string; random: (n: number) => Uint8Array;
}
export interface SourcesState {
  loaded: boolean; configured: Record<Provider, boolean>; signedIn: Record<Provider, boolean>;
  provider: Provider | null; online: boolean; busy: boolean; status: string; error: string | null;
  trail: Entry[]; entries: Entry[]; next: string | null; query: string | null; opened: Opened | null;
}
export interface SourcesController {
  subscribe(fn: () => void): () => void; getState(): SourcesState; start(): Promise<void>; dispose(): void;
  configure(p: Provider, c: ProviderConfig): Promise<boolean>; forgetConfig(p: Provider): Promise<void>;
  signIn(p: Provider): Promise<void>; signOut(p: Provider): Promise<void>; choose(p: Provider | null): Promise<void>;
  openEntry(e: Entry): Promise<void>; toCrumb(i: number): Promise<void>; more(): Promise<void>;
  search(q: string): Promise<void>; clearSearch(): Promise<void>; closeFile(): void; redirectUri(): string;
}

const both = <T>(v: T): Record<Provider, T> => ({ gitlab: v, box: v });
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function onNetworkEvents(fn: (online: boolean) => void): () => void {
  if (typeof addEventListener !== "function") return () => {};
  const on = () => fn(true), off = () => fn(false);
  addEventListener("online", on); addEventListener("offline", off);
  return () => { removeEventListener("online", on); removeEventListener("offline", off); };
}

export function createSourcesController(given: Partial<SourcesDeps> = {}): SourcesController {
  // Defaults are built lazily per key, so the server-side render in tests never touches `document` or `window`.
  const d: SourcesDeps = {
    config: given.config ?? indexedDbSourcesConfig() ?? memorySourcesConfig(),
    fetchImpl: given.fetchImpl ?? ((i, init) => fetch(i, init)),
    now: given.now ?? Date.now, sleep: given.sleep ?? realSleep,
    online: given.online ?? (() => globalThis.navigator?.onLine !== false),
    onNetwork: given.onNetwork ?? onNetworkEvents,
    openPopup: given.openPopup ?? (() => window.open("about:blank", "llmide-oauth", "popup,width=520,height=720")),
    channel: given.channel ?? (() => new BroadcastChannel(CHANNEL)),
    every: given.every,
    baseURI: given.baseURI ?? (() => document.baseURI),
    random: given.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))),
  };
  let s: SourcesState = { loaded: false, configured: both(false), signedIn: both(false), provider: null, online: d.online(), busy: false,
    status: "", error: null, trail: [], entries: [], next: null, query: null, opened: null };
  const subs = new Set<() => void>();
  const set = (p: Partial<SourcesState>) => { s = { ...s, ...p }; for (const f of subs) f(); };
  let cfg: SourcesConfig = { v: 1, gitlab: null, box: null };
  const tokens: Record<Provider, Tokens | null> = both(null);
  const refreshing: Partial<Record<Provider, Promise<string | null>>> = {};
  const clients: Partial<Record<Provider, SourceClient>> = {};
  let gen = 0;
  let off: (() => void) | null = null;
  const redirect = () => callbackUrl(d.baseURI());
  const markSigned = () => set({ signedIn: { gitlab: !!tokens.gitlab, box: !!tokens.box } });
  const fail = (e: unknown) => { set({ busy: false, status: "", error: TEXT[(e as { code?: string } | null)?.code ?? ""] ?? TEXT.provider_error }); markSigned(); };

  function refresh(p: Provider): Promise<string | null> {
    return (refreshing[p] ??= (async () => {
      await Promise.resolve(); // runs after `refreshing[p]` is assigned, so `finally` always clears it
      try {
        const t = tokens[p], c = cfg[p];
        if (!t?.refresh || !c) { tokens[p] = null; return null; }
        // Box refresh tokens are single use: one refresh in flight per provider, and any failure ends the sign-in.
        const n = await refreshTokens(p, c, t.refresh, redirect(), d.fetchImpl, d.now);
        tokens[p] = n;
        return n.access;
      } catch { tokens[p] = null; return null; }
      finally { delete refreshing[p]; markSigned(); }
    })());
  }
  const auth = (p: Provider): Auth => ({
    async token() {
      const t = tokens[p]; if (!t) throw new SourceError("signed_out");
      if (t.expiresAt > d.now()) return t.access;
      const n = await refresh(p); if (!n) throw new SourceError("signed_out");
      return n;
    },
    refresh: () => refresh(p),
  });
  const http = () => ({ fetchImpl: d.fetchImpl, sleep: d.sleep, online: d.online, now: d.now });
  const client = (p: Provider): SourceClient => (clients[p] ??= p === "gitlab" ? createGitLabClient(auth(p), http()) : createBoxClient(auth(p), http()));

  async function load(dir: Entry | null, cursor: string | null) {
    const p = s.provider; if (!p) return;
    const g = ++gen;
    set({ busy: true, status: "Loading…", error: null });
    try {
      const page = await client(p).list(dir, cursor);
      if (g === gen) set({ busy: false, status: "", entries: cursor ? [...s.entries, ...page.entries] : page.entries, next: page.next });
    } catch (e) { if (g === gen) fail(e); }
  }
  async function save() { try { await d.config.save(cfg); } catch { set({ error: TEXT.not_saved }); } }
  const valid = (p: Provider, c: unknown): ProviderConfig | null => { try { return c ? checkConfig(p, c as ProviderConfig) : null; } catch { return null; } };

  const api: SourcesController = {
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    getState: () => s,
    async start() {
      off ??= d.onNetwork((online) => set({ online }));
      let raw: SourcesConfig | null = null;
      try { raw = await d.config.load(); } catch { /* unreadable storage: start empty */ }
      cfg = { v: 1, gitlab: valid("gitlab", raw?.gitlab), box: valid("box", raw?.box) };
      set({ loaded: true, configured: { gitlab: !!cfg.gitlab, box: !!cfg.box } });
    },
    dispose() { off?.(); off = null; },
    async configure(p, c) {
      try { cfg = { ...cfg, [p]: checkConfig(p, c) }; } catch (e) { fail(e); return false; }
      delete clients[p];
      set({ configured: { ...s.configured, [p]: true }, error: null });
      await save();
      return true;
    },
    async forgetConfig(p) {
      await api.signOut(p);
      cfg = { ...cfg, [p]: null }; delete clients[p];
      set({ configured: { ...s.configured, [p]: false } });
      await save();
    },
    signIn(p) {
      const popup = d.openPopup(); // synchronously, inside the click, or the browser blocks it
      if (!popup) { set({ error: TEXT.popup_blocked }); return Promise.resolve(); }
      return (async () => {
        try {
          const c = cfg[p]; if (!c) throw new OAuthError("not_configured");
          if (!d.online()) throw new SourceError("offline");
          set({ busy: true, error: null, status: "Waiting for you to sign in in the pop-up window…" });
          const verifier = randomString(32, d.random), state = randomString(16, d.random);
          const code = waitForCode(state, d.channel(), { isClosed: () => popup.closed, every: d.every });
          code.catch(() => {}); // awaited below; this only stops an early rejection being reported as unhandled
          popup.location.href = authorizeUrl(p, c, redirect(), state, await challengeFor(verifier));
          tokens[p] = await exchangeCode(p, c, await code, verifier, redirect(), d.fetchImpl, d.now);
          delete refreshing[p];
          set({ busy: false, status: "" }); markSigned();
        } catch (e) { fail(e); }
        finally { try { popup.close(); } catch { /* already closed */ } }
      })();
    },
    async signOut(p) {
      const t = tokens[p]; tokens[p] = null; delete refreshing[p]; markSigned();
      if (s.provider === p) { gen++; set({ provider: null, trail: [], entries: [], next: null, query: null, opened: null, busy: false, status: "" }); }
      const c = cfg[p];
      if (t && c) await revokeToken(p, c, t.access, d.fetchImpl);
    },
    async choose(p) {
      gen++;
      set({ provider: p, trail: [], entries: [], next: null, query: null, opened: null, error: null, busy: false, status: "" });
      if (p) await load(null, null);
    },
    async openEntry(e) {
      const p = s.provider; if (!p) return;
      if (e.kind !== "file") { set({ trail: [...s.trail, e], query: null, opened: null }); return load(e, null); }
      const g = ++gen;
      set({ busy: true, status: `Opening ${e.name}…`, error: null });
      try { const o = await client(p).open(e); if (g === gen) set({ busy: false, status: "", opened: o }); } catch (err) { if (g === gen) fail(err); }
    },
    async toCrumb(i) { const trail = s.trail.slice(0, i + 1); set({ trail, query: null, opened: null }); await load(trail.at(-1) ?? null, null); },
    async more() { if (s.next && s.query === null) await load(s.trail.at(-1) ?? null, s.next); },
    async search(q) {
      const p = s.provider; if (!p) return;
      const g = ++gen;
      set({ busy: true, status: "Searching…", error: null, opened: null });
      try { const page = await client(p).search(q, s.trail.at(-1) ?? null); if (g === gen) set({ busy: false, status: "", query: q.trim(), entries: page.entries, next: null }); }
      catch (e) { if (g === gen) fail(e); }
    },
    async clearSearch() { set({ query: null }); await load(s.trail.at(-1) ?? null, null); },
    closeFile() { set({ opened: null }); },
    redirectUri: redirect,
  };
  return api;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd web && node --test --experimental-strip-types tests/sources-controller.test.mjs tests/sync-keystore.test.mjs && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/sources/config.ts web/src/sources/controller.ts web/tests/helpers/fake-idb.mjs web/tests/sync-keystore.test.mjs web/tests/sources-controller.test.mjs
git commit -m "feat(web): sources controller with in-memory tokens and app settings store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web screen and App wiring

**Files:**
- Create: `web/src/screens/SourcesScreen.tsx`
- Modify: `web/src/App.tsx`, `web/src/screens/SyncTier.tsx` (optional `onSources` prop), `web/src/web.css`, `web/tests/ui-entry.ts`
- Test: `web/tests/sources-screens.test.mjs`, `web/tests/app.test.mjs` (one new test)

**Interfaces:**
- Consumes: `SourcesController`, `SourcesState`, `TEXT` (Task 5); `Entry`, `Opened`, `Reason` (Task 2); `Provider`.
- Produces: `SourcesScreen({ state, sources, onBack })`, `SourcesEntry({ onOpen })`, `REASON: Record<Reason, string>`, `NAME: Record<Provider, string>`; `App` accepts `sources?: SourcesController`; `SyncTierProps.onSources?: () => void`.

- [ ] **Step 1: Write the failing tests**

Append to `web/tests/ui-entry.ts`:

```ts
export { SourcesScreen, SourcesEntry, REASON } from "../src/screens/SourcesScreen.tsx";
```

Create `web/tests/sources-screens.test.mjs`:

```js
// The sources screen renders: labelled setup fields with the redirect URI and read-only scopes, breadcrumbs with the
// current place, a labelled search, entries as buttons, and file bodies as text only (no HTML, no frames for PDFs).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadUi, h, html } from './helpers.mjs';

let UI;
before(async () => { UI = await loadUi(); });
const noop = async () => {};
const sources = { configure: async () => true, forgetConfig: noop, signIn: noop, signOut: noop, choose: noop, openEntry: noop, toCrumb: noop, more: noop,
  search: noop, clearSearch: noop, closeFile: () => {}, redirectUri: () => 'https://llm-ide.com/app/oauth-callback.html' };
const S = { loaded: true, configured: { gitlab: false, box: false }, signedIn: { gitlab: false, box: false }, provider: null, online: true, busy: false,
  status: '', error: null, trail: [], entries: [], next: null, query: null, opened: null };
const view = (state) => html(h(UI.SourcesScreen, { state: { ...S, ...state }, sources, onBack: () => {} }));
const proj = { id: 'p7', name: 'demo', kind: 'project', path: 'dee/demo', size: null, detail: null, project: { id: 7, ref: 'main', webUrl: 'https://gitlab.com/dee/demo' } };
const file = (name, extra = {}) => ({ entry: { id: `7:${name}`, name, kind: 'file', path: `src/${name}`, size: null, detail: null, project: proj.project },
  kind: 'code', language: 'typescript', text: null, bytes: null, truncated: false, webUrl: 'https://gitlab.com/dee/demo/-/blob/main/src/' + name, reason: null, ...extra });

test('setup cards: labelled fields, password-type Box secret, redirect URI and read-only scopes stated', () => {
  const out = view({});
  for (const l of ['Application ID', 'Client ID', 'Client secret']) assert.match(out, new RegExp(`<label[^>]*>${l}</label>`));
  assert.match(out, /type="password"/);
  assert.match(out, /https:\/\/llm-ide\.com\/app\/oauth-callback\.html/);
  assert.match(out, /read_api and read_repository/);
  assert.match(out, /Read all files and folders/);
  assert.match(out, /read-only/);
  assert.match(view({ configured: { gitlab: true, box: false } }), /Sign in to GitLab/);
  assert.match(view({ configured: { gitlab: true, box: false }, signedIn: { gitlab: true, box: false } }), /Browse/);
});

test('browser: breadcrumbs with aria-current, labelled search with role=search, entries as buttons, More', () => {
  const out = view({ provider: 'gitlab', signedIn: { gitlab: true, box: false }, trail: [proj], next: '2',
    entries: [{ id: '7:src', name: 'src', kind: 'dir', path: 'src', size: null, detail: null, project: proj.project }] });
  assert.match(out, /<nav aria-label="Location">/);
  assert.match(out, /aria-current="page"[^>]*>demo<\/button>/);
  assert.match(out, /role="search"/);
  assert.match(out, /<label[^>]*>Search code in this project<\/label>/);
  assert.match(out, /<button[^>]*class="web-entry"[^>]*>[^<]*<span class="chat-muted">Folder<\/span> src<\/button>/);
  assert.match(out, />More<\/button>/);
  assert.match(view({ provider: 'box', signedIn: { gitlab: false, box: true } }), /<label[^>]*>Search Box files<\/label>/);
});

test('file view: code is escaped text in a focusable labelled pre; markdown renders no raw HTML', () => {
  const code = view({ provider: 'gitlab', opened: file('app.ts', { text: '<script>alert(1)</script>' }) });
  assert.match(code, /<pre class="web-src" tabindex="0" aria-label="Contents of app\.ts"><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.match(code, /<h2 tabindex="-1">app\.ts<\/h2>/);
  assert.match(code, /Open on GitLab/);
  assert.match(code, /read-only/);
  const md = view({ provider: 'gitlab', opened: file('README.md', { kind: 'markdown', language: 'Markdown', text: '# Hi\n\n<img src=x onerror=alert(1)>' }) });
  assert.doesNotMatch(md, /<img|<script/);
  assert.match(md, /<h1>Hi<\/h1>/);
});

test('file view: PDF offered as a download only; truncated, binary and missing-text notices', () => {
  const pdf = view({ provider: 'box', opened: file('deck.pdf', { kind: 'pdf', language: 'PDF', bytes: new Uint8Array(2048) }) });
  assert.match(pdf, />Save PDF<\/button>/);
  assert.doesNotMatch(pdf, /<iframe|<embed|<object/);
  assert.match(view({ provider: 'gitlab', opened: file('big.txt', { kind: 'text', text: 'a', truncated: true }) }), /Only the first part is shown/);
  assert.match(view({ provider: 'gitlab', opened: file('logo.bin', { kind: 'unsupported', reason: 'binary' }) }), new RegExp(UI.REASON.binary));
  assert.match(view({ provider: 'box', opened: file('scan.docx', { kind: 'unsupported', reason: 'no_text' }) }), new RegExp(UI.REASON.no_text));
  const ex = view({ provider: 'box', opened: file('plan.docx', { kind: 'extracted', text: 'Plan' }) });
  assert.match(ex, /Text extracted by Box/);
});

test('offline banner, live status and error alert', () => {
  const out = view({ online: false, status: 'Loading…', error: 'The provider refused access to this item.' });
  assert.match(out, /You are offline/);
  assert.match(out, /role="status" aria-live="polite">Loading…/);
  assert.match(out, /role="alert"/);
});
```

Append to `web/tests/app.test.mjs`:

```js
test("sources: Pairing and the sync tier both offer documents and code", () => {
  const m = desk().model();
  assert.match(html(h(UI.App, { model: m, sync: fakeSync("none") })), /Open documents and code/);
  const down = desk({ up: false }).model();
  assert.match(html(h(UI.App, { model: down, sync: fakeSync("locked") })), />Documents and code<\/button>/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/sources-screens.test.mjs tests/app.test.mjs`
Expected: FAIL (build error: `SourcesScreen.tsx` not found).

- [ ] **Step 3: Implement**

`web/src/screens/SourcesScreen.tsx`:

```tsx
// Documents and code at the source (design 9): GitLab projects and Box folders, read-only. Every name, path, snippet and
// body renders as React text, or through the shared Markdown view (no HTML strings, no images). A PDF is offered as a
// download only (decision D2); nothing from a provider is rendered as HTML or executed.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Markdown } from "@llmide/screens/chat/MarkdownView.tsx";
import { TEXT, type SourcesController, type SourcesState } from "../sources/controller.ts";
import type { Entry, Opened, Reason } from "../sources/model.ts";
import type { Provider } from "../sources/oauth.ts";

type Actions = Omit<SourcesController, "subscribe" | "getState" | "start" | "dispose">;
export interface SourcesScreenProps { state: SourcesState; sources: Actions; onBack: () => void }

export const NAME: Record<Provider, string> = { gitlab: "GitLab", box: "Box" };
export const REASON: Record<Reason, string> = {
  binary: "This file is binary and is not shown.",
  type: "This file type is not shown here.",
  too_large: "Too large to show here. Open it on the provider's site.",
  no_text: "Box has no text for this file yet.",
};
const KIND: Record<Entry["kind"], string> = { project: "Project", dir: "Folder", file: "File" };
const HELP: Record<Provider, string> = {
  gitlab: "On gitlab.com: Preferences → Applications → Add new application. Untick Confidential, tick only read_api and read_repository, and add the redirect URI below. Paste the Application ID here. A sign-in lasts for this browser session.",
  box: "In the Box developer console: create a Custom App with User Authentication (OAuth 2.0), tick only “Read all files and folders stored in Box”, add this site's address to CORS Domains and the redirect URI below. The client secret stays in this browser's storage for this site; anything running on this site could read it.",
};
const openLink = (href: string) => { if (/^https:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer"); };
const size = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function ProviderCard({ p, state, sources }: { p: Provider; state: SourcesState; sources: Actions }) {
  const ids = [useId(), useId(), useId()];
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const configured = state.configured[p], signed = state.signedIn[p];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const sec = secret; setSecret("");
    if (await sources.configure(p, p === "box" ? { clientId: id.trim(), clientSecret: sec.trim() } : { clientId: id.trim() })) setId("");
  };
  return (
    <section className="web-form web-read" aria-labelledby={ids[2]}>
      <h2 id={ids[2]}>{p === "gitlab" ? "GitLab code" : "Box documents"}</h2>
      <p className="chat-muted">{signed ? "Signed in for this session." : configured ? "Set up. Sign in to browse." : "Not set up."}</p>
      <div className="web-actions">
        {configured && !signed && <button type="button" disabled={state.busy || !state.online} onClick={() => void sources.signIn(p)}>Sign in to {NAME[p]}</button>}
        {signed && <button type="button" onClick={() => void sources.choose(p)}>Browse</button>}
        {signed && <button type="button" onClick={() => void sources.signOut(p)}>Sign out</button>}
      </div>
      <details open={!configured}>
        <summary>App settings</summary>
        <p>{HELP[p]}</p>
        <p>Redirect URI to register: <code>{sources.redirectUri()}</code></p>
        <form className="web-form" onSubmit={(e) => void save(e)}>
          <label htmlFor={ids[0]}>{p === "gitlab" ? "Application ID" : "Client ID"}</label>
          <input id={ids[0]} value={id} autoComplete="off" spellCheck={false} maxLength={128} required onChange={(e) => setId(e.target.value)} />
          {p === "box" && (
            <>
              <label htmlFor={ids[1]}>Client secret</label>
              <input id={ids[1]} type="password" value={secret} autoComplete="off" maxLength={128} required onChange={(e) => setSecret(e.target.value)} />
            </>
          )}
          <div className="web-actions">
            <button type="submit">Save</button>
            {configured && <button type="button" onClick={() => void sources.forgetConfig(p)}>Forget app settings</button>}
          </div>
        </form>
      </details>
    </section>
  );
}

function Browser({ state, sources }: { state: SourcesState; sources: Actions }) {
  const p = state.provider as Provider;
  const searchId = useId();
  const [q, setQ] = useState("");
  const here = state.trail.at(-1) ?? null;
  const label = p === "gitlab" ? (here ? "Search code in this project" : "Search projects") : here ? "Search files in this folder" : "Search Box files";
  const atEnd = (i: number) => i === state.trail.length - 1 && state.query === null;
  return (
    <section className="web-read" aria-label={`${NAME[p]} browser`}>
      <nav aria-label="Location">
        <ol className="web-crumbs">
          <li><button type="button" onClick={() => void sources.toCrumb(-1)} aria-current={state.trail.length === 0 && state.query === null ? "page" : undefined}>{p === "gitlab" ? "Projects" : "All files"}</button></li>
          {state.trail.map((e, i) => <li key={e.id}><button type="button" onClick={() => void sources.toCrumb(i)} aria-current={atEnd(i) ? "page" : undefined}>{e.name}</button></li>)}
        </ol>
      </nav>
      <form className="web-search" role="search" onSubmit={(e) => { e.preventDefault(); void sources.search(q); }}>
        <label htmlFor={searchId}>{label}</label>
        <input id={searchId} type="search" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" disabled={!q.trim() || state.busy || !state.online}>Search</button>
        {state.query !== null && <button type="button" onClick={() => { setQ(""); void sources.clearSearch(); }}>Clear search</button>}
      </form>
      {state.query !== null && <p>Results for “{state.query}”</p>}
      <ul className="web-list" aria-label={state.query !== null ? "Search results" : "Items"}>
        {state.entries.map((e) => (
          <li key={e.id}>
            <button type="button" className="web-entry" onClick={() => void sources.openEntry(e)}><span className="chat-muted">{KIND[e.kind]}</span> {e.name}</button>
            {e.size !== null && <span className="chat-muted"> · {size(e.size)}</span>}
            {state.query !== null && e.path !== e.name && <span className="chat-muted"> · {e.path}</span>}
            {e.detail && <pre className="web-snippet">{e.detail}</pre>}
          </li>
        ))}
      </ul>
      {!state.busy && state.entries.length === 0 && <p className="chat-muted">{state.query !== null ? "No results." : "Nothing here."}</p>}
      {state.next && state.query === null && <button type="button" onClick={() => void sources.more()} disabled={state.busy}>More</button>}
    </section>
  );
}

function FileView({ o, provider, onClose }: { o: Opened; provider: Provider; onClose: () => void }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, [o]);
  const savePdf = () => {
    if (!o.bytes) return;
    const url = URL.createObjectURL(new Blob([o.bytes], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url; a.download = o.entry.name.replace(/[^\w.\- ]+/g, "_") || "document.pdf"; a.rel = "noopener";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const asText = o.text !== null && (o.kind === "code" || o.kind === "text" || o.kind === "extracted");
  return (
    <section className="web-read" aria-label={`File ${o.entry.name}`}>
      <div className="web-read-head">
        <button type="button" onClick={onClose}>Back to list</button>
        <h2 ref={head} tabIndex={-1}>{o.entry.name}</h2>
        {o.webUrl && <button type="button" onClick={() => openLink(o.webUrl as string)}>Open on {NAME[provider]}</button>}
      </div>
      <p className="chat-muted">{o.entry.path}{o.language ? ` · ${o.language}` : ""} · read-only</p>
      {o.truncated && <StatusBanner severity="warning" message="Only the first part is shown: the file is larger than this app shows." />}
      {o.reason && <p>{REASON[o.reason]}</p>}
      {o.kind === "markdown" && o.text !== null && <div className="web-doc"><Markdown text={o.text} onOpenLink={openLink} /></div>}
      {o.kind === "extracted" && <p className="chat-muted">Text extracted by Box. Layout and images are not shown.</p>}
      {asText && <pre className="web-src" tabIndex={0} aria-label={`Contents of ${o.entry.name}`}><code>{o.text}</code></pre>}
      {o.kind === "pdf" && o.bytes && (
        <>
          <p>PDF, {size(o.bytes.length)}. This app does not display PDFs. Save it and open it with your PDF viewer.</p>
          <button type="button" onClick={savePdf}>Save PDF</button>
        </>
      )}
    </section>
  );
}

export function SourcesScreen({ state, sources, onBack }: SourcesScreenProps) {
  return (
    <main className="web-app">
      <header className="web-header">
        <h1>LLM-IDE · documents and code</h1>
        <span className="chat-spacer" />
        <button type="button" onClick={state.provider ? () => void sources.choose(null) : onBack}>{state.provider ? "All sources" : "Back"}</button>
      </header>
      <p className="chat-muted">Read live from your own Box and GitLab accounts, read-only. Nothing is copied to this device or through sync.</p>
      {!state.online && <StatusBanner severity="info" message={TEXT.offline} />}
      <p className="web-status" role="status" aria-live="polite">{state.status}</p>
      {state.error && <StatusBanner severity="error" message={state.error} />}
      {!state.provider ? (
        <div className="web-shell">
          <ProviderCard p="gitlab" state={state} sources={sources} />
          <ProviderCard p="box" state={state} sources={sources} />
        </div>
      ) : state.opened ? <FileView o={state.opened} provider={state.provider} onClose={sources.closeFile} />
        : <Browser state={state} sources={sources} />}
    </main>
  );
}

/** On the Pairing screen: the way in when this browser is not linked to anything yet. */
export function SourcesEntry({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="web-form">
      <h2>Documents and code</h2>
      <p>Read your Box documents and GitLab code directly, read-only, even with the desktop off.</p>
      <button type="button" onClick={onOpen}>Open documents and code</button>
    </section>
  );
}
```

`web/src/screens/SyncTier.tsx`. Change `export interface SyncTierProps { state: SyncState; sync: Actions; hostPaired: boolean }` to:

```tsx
export interface SyncTierProps { state: SyncState; sync: Actions; hostPaired: boolean; onSources?: () => void }
```

Change `Frame` to take and render it:

```tsx
function Frame({ children, hostPaired, onSources }: { children: ReactNode; hostPaired: boolean; onSources?: () => void }) {
  return (
    <main className="web-app">
      <header className="web-header">
        <h1>LLM-IDE · offline sync</h1>
        <span className="chat-spacer" />
        {hostPaired && <span className="chat-muted">Desktop not reachable</span>}
        {onSources && <button type="button" onClick={onSources}>Documents and code</button>}
      </header>
      {children}
    </main>
  );
}
```

and in `SyncTier`, use `export function SyncTier({ state, sync, hostPaired, onSources }: SyncTierProps)` with `<Frame hostPaired={hostPaired} onSources={onSources}>`.

`web/src/App.tsx`. Add the imports:

```tsx
import { createSourcesController, type SourcesController } from "./sources/controller.ts";
import { SourcesEntry, SourcesScreen } from "./screens/SourcesScreen.tsx";
```

Replace the `App` function with:

```tsx
export function App({ model: given, sync: givenSync, sources: givenSources }: { model?: AppModel; sync?: SyncController; sources?: SourcesController }) {
  const [model] = useState(() => given ?? createAppModel(initialHostUrl(import.meta.env.VITE_HOST_API_URL, lastHostUrl().get())));
  const [sync] = useState(() => givenSync ?? createSyncController());
  const [sources] = useState(() => givenSources ?? createSourcesController());
  const [showSources, setShowSources] = useState(false);
  const s = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const sy = useSyncExternalStore(sync.subscribe, sync.getState, sync.getState);
  const so = useSyncExternalStore(sources.subscribe, sources.getState, sources.getState);
  const conn = useConnection(s.session);
  useEffect(() => { model.start(); return model.dispose; }, [model]);
  useEffect(() => { void sync.start(); return sync.dispose; }, [sync]);
  useEffect(() => { void sources.start(); return sources.dispose; }, [sources]);
  const live = conn?.kind === "ready";
  useEffect(() => { if (live) sync.pause(); else sync.resume(); }, [live, sync]);
  const openSources = () => setShowSources(true);
  if (showSources) return <SourcesScreen state={so} sources={sources} onBack={() => setShowSources(false)} />;
  // While the first connection attempt is still running the host is not "down" yet: no sync-tier flash before chat.
  const hostDown = (!s.session && !s.busy) || conn?.kind === "reconnecting" || conn?.kind === "failed";
  if (sy.phase === "pairing" || (sy.phase !== "none" && hostDown)) return <SyncTier state={sy} sync={sync} hostPaired={s.session !== null} onSources={openSources} />;
  if (s.session && conn) return <Chat session={s.session} conn={conn} onForget={model.forget} />;
  return <PairingScreen initialUrl={model.initialUrl} busy={s.busy} error={s.error} revokedNotice={s.notice} onSubmit={(u, p) => void model.attempt(u, p)}
    footer={<><SyncLinkEntry onLink={sync.acceptLink} error={sy.phase === "none" ? sy.error : null} /><SourcesEntry onOpen={openSources} /></>} />;
}
```

Append to `web/src/web.css`:

```css
/* Direct reads (Box documents, GitLab code): text-only file bodies, breadcrumbs, search. */
.web-src { margin: 0; max-width: 100%; max-height: 70vh; overflow: auto; box-sizing: border-box; white-space: pre; tab-size: 4; padding: 10px;
  font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b1119; border: 1px solid var(--tok-color-border, #263445); border-radius: 8px; }
.web-snippet { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.4 ui-monospace, Menlo, monospace; }
.web-crumbs { list-style: none; display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; padding: 0; }
.web-crumbs li + li::before { content: "/"; margin-right: 4px; color: var(--tok-color-text-muted, #9badc1); }
.web-crumbs button, .web-entry { all: unset; cursor: pointer; text-decoration: underline; overflow-wrap: anywhere; }
.web-crumbs button:focus-visible, .web-entry:focus-visible { outline: 2px solid currentColor; }
.web-search { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.web-search input { min-width: 0; flex: 1 1 160px; padding: 8px; font: inherit; }
.web-doc { overflow-wrap: anywhere; }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test && npx tsc --noEmit -p .`
Expected: PASS (all web tests, including `scaffold.test.mjs` "no source uses raw HTML or dynamic code").

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/SourcesScreen.tsx web/src/App.tsx web/src/screens/SyncTier.tsx web/src/web.css web/tests/ui-entry.ts web/tests/sources-screens.test.mjs web/tests/app.test.mjs
git commit -m "feat(web): documents and code screen for reads at the source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web CSP connect-src, opt-in live test, web docs

**Files:**
- Modify: `web/vite.config.ts`, `web/scripts/serve.mjs`, `deploy/vps/llm-ide.com.nginx`, `web/DEPLOY.md`, `web/tests/scaffold.test.mjs`, `web/package.json` (script only), `web/README.md`, `web/MANUAL-CHECK.md`
- Create: `web/tests/live/sources-live.test.mjs`

**Interfaces:**
- Consumes: `ALLOWED_HOSTS` (Task 2); clients (Tasks 3–4).
- Produces: npm script `test:live`.

- [ ] **Step 1: Write the failing test.** In `web/tests/scaffold.test.mjs`, replace the first test with:

```js
const MEGA_CONNECT = ["https://g.api.mega.co.nz", "https://*.userstorage.mega.co.nz"];
// Direct reads (SP7): exactly the hosts the sources clients may call (web/src/sources/http.ts ALLOWED_HOSTS).
const SOURCE_CONNECT = ["https://gitlab.com", "https://api.box.com", "https://dl.boxcloud.com", "https://public.boxcloud.com"];

test("the CSP allows no inline or remote script; remote connects go only to MEGA and the Box/GitLab read hosts", async () => {
  const { CSP, WEB_PORT } = await import("../vite.config.ts");
  const { CSP: SERVED } = await import("../scripts/serve.mjs");
  const { ALLOWED_HOSTS } = await import("../src/sources/http.ts");
  assert.equal(WEB_PORT, 5180);
  assert.equal(SERVED, CSP, "the static server sends the same policy as the built page");
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /unsafe-eval|wasm-unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.match(CSP, /object-src 'none'/);
  const dirs = Object.fromEntries(CSP.split("; ").map((d) => { const [k, ...v] = d.split(" "); return [k, v]; }));
  const remote = [...MEGA_CONNECT, ...SOURCE_CONNECT];
  for (const [k, v] of Object.entries(dirs)) {
    for (const src of v) if (/^https?:/.test(src) || src.includes("*.")) assert.ok(k === "connect-src" && remote.includes(src), `${k} ${src}`);
  }
  assert.deepEqual(dirs["connect-src"].filter((s) => s.startsWith("https:")), remote);
  assert.deepEqual(SOURCE_CONNECT, ALLOWED_HOSTS.map((h) => `https://${h}`), "code allow-list and CSP agree");
  for (const ws of CSP.match(/ws:\/\/[^ ;]+/g)) assert.match(ws, /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\*$/);
  const nginx = readFileSync(join(WEB, "../deploy/vps/llm-ide.com.nginx"), "utf8");
  assert.ok(nginx.includes(`connect-src ${dirs["connect-src"].join(" ")};`), "the VPS vhost sends the same connect-src");
  const caddy = readFileSync(join(WEB, "DEPLOY.md"), "utf8");
  assert.ok(caddy.includes(SOURCE_CONNECT.join(" ")), "the Caddy example lists the same read hosts");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/scaffold.test.mjs`
Expected: FAIL (the `connect-src` https list lacks the four hosts).

- [ ] **Step 3: Implement.** In each of these four places, append ` https://gitlab.com https://api.box.com https://dl.boxcloud.com https://public.boxcloud.com` directly after `https://*.userstorage.mega.co.nz` inside `connect-src`:
  - `web/vite.config.ts` (`CSP` array, the `connect-src` string; also extend the comment above it: `// Box and GitLab read hosts for direct reads (design 9): API, token, and Box's download/representation hosts.`)
  - `web/scripts/serve.mjs` (`CSP` array)
  - `deploy/vps/llm-ide.com.nginx` (the `add_header Content-Security-Policy` line)
  - `web/DEPLOY.md` (the Caddy `Content-Security-Policy` line; in the sentence that explains the MEGA hosts, add: "The four Box/GitLab hosts are for reading documents and code at the source.")

In `web/package.json` `scripts`, add after `"test:e2e"`:

```json
    "test:live": "node --test --experimental-strip-types tests/live/*.test.mjs",
```

Create `web/tests/live/sources-live.test.mjs`:

```js
// Opt-in live checks against the real APIs. Never run in CI; each test skips unless its variable is set.
//   LLMIDE_SP7_GITLAB_TOKEN  a gitlab.com OAuth or personal token with read_api + read_repository
//   LLMIDE_SP7_BOX_TOKEN     a Box access token (root_readonly), e.g. a developer token from the Box console
// Run: cd web && LLMIDE_SP7_GITLAB_TOKEN=... npm run test:live
// Node has no CORS, so this checks API shapes and limits only; web/MANUAL-CHECK.md step 5 checks CORS in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitLabClient } from '../../src/sources/gitlab.ts';
import { createBoxClient } from '../../src/sources/box.ts';

const auth = (t) => ({ token: async () => t, refresh: async () => null });
const GL = process.env.LLMIDE_SP7_GITLAB_TOKEN, BOX = process.env.LLMIDE_SP7_BOX_TOKEN;

test('gitlab.com: projects, tree, open one file, search', { skip: !GL && 'set LLMIDE_SP7_GITLAB_TOKEN' }, async () => {
  const c = createGitLabClient(auth(GL));
  const projects = await c.list(null, null);
  const p = projects.entries.find((e) => e.project?.ref);
  assert.ok(p, 'the token sees at least one non-empty project');
  const tree = await c.list(p, null);
  assert.ok(tree.entries.length > 0);
  const f = tree.entries.find((e) => e.kind === 'file');
  if (f) { const o = await c.open(f); assert.ok(o.text !== null || o.bytes !== null || o.reason !== null); }
  await c.search(f?.name.split('.')[0] || 'readme', p);
});

test('Box: root folder, open one file, search', { skip: !BOX && 'set LLMIDE_SP7_BOX_TOKEN' }, async () => {
  const c = createBoxClient(auth(BOX));
  const root = await c.list(null, null);
  const f = root.entries.find((e) => e.kind === 'file');
  if (f) { const o = await c.open(f); assert.ok(o.text !== null || o.bytes !== null || o.reason !== null); }
  await c.search(f?.name.split('.')[0] || 'a', null);
});
```

In `web/README.md`, add a section after "## Offline sync (desktop off)":

```markdown
## Documents and code at the source

The web app reads Box documents and GitLab code directly from the user's own accounts, read-only, with or without
the desktop (design §9). Nothing passes through sync, and nothing read is stored.

- Sign-in is OAuth with PKCE in a pop-up: GitLab `read_api read_repository` (an application with Confidential
  unticked), Box `root_readonly` (the user's own Box Custom App; Box needs its client secret, which stays in
  IndexedDB `llmide-sources`). Tokens live in memory only, so each browser session signs in again.
- Redirect URI: `<site>/oauth-callback.html` (for example `https://llm-ide.com/app/oauth-callback.html`; in
  development `http://127.0.0.1:5180/oauth-callback.html`). Box also needs the site origin in its CORS Domains.
- The CSP adds exactly `https://gitlab.com https://api.box.com https://dl.boxcloud.com https://public.boxcloud.com` to
  `connect-src`. gitlab.com only; self-hosted GitLab is not supported yet.
- Code and text show as plain text (1 MiB cap), Markdown without HTML or images, PDFs as "Save PDF" only, Office files
  as Box's extracted text. Setup: docs/how-to/read-box-gitlab-on-phone-and-web.md.
- Code: `src/sources/`. Tests: `tests/sources-*.test.mjs` (fake APIs); live: `npm run test:live` (opt-in).
```

In `web/MANUAL-CHECK.md`, append:

```markdown
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npm test && npm run test:live && npx tsc --noEmit -p . && npm run build`
Expected: unit tests PASS; `test:live` reports 2 skipped (no variables set); the build succeeds, and `dist/oauth-callback.html` and `dist/oauth-callback.js` exist (`ls dist/oauth-callback.*`).

- [ ] **Step 5: Commit**

```bash
git add web/vite.config.ts web/scripts/serve.mjs deploy/vps/llm-ide.com.nginx web/DEPLOY.md web/tests/scaffold.test.mjs web/package.json web/tests/live/sources-live.test.mjs web/README.md web/MANUAL-CHECK.md
git commit -m "feat(web): allow the Box and GitLab read hosts in connect-src

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: SharedProtocol OAuth, HTTP session, models and preview rules (Swift)

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/SourceOAuth.swift`, `ios_app/SharedProtocol/Sources/SharedProtocol/SourceHTTP.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceOAuthTests.swift`, `ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceHTTPTests.swift`

**Interfaces:**
- Consumes: `SyncCrypto.randomBytes(_:)` (existing, `SyncEnvelope.swift`).
- Produces (used by Tasks 9, 10 and SP6):
  - `public enum SourceProvider: String, Codable, Sendable, CaseIterable { case gitlab, box }`
  - `public struct SourceAppConfig: Codable, Equatable, Sendable { clientId: String; clientSecret: String? }`
  - `public struct SourceTokens: Codable, Equatable, Sendable { access: String; refresh: String?; expiresAtMs: Int }`
  - `public enum SourceOAuthError: Error, Equatable, Sendable { badClientId, badClientSecret, badTokenResponse, scopeTooWide, grantExpired, clientRefused, providerError, unreachable, cancelled, stateMismatch, failed }`
  - `public enum SourceOAuth { callbackScheme; redirectURI(_:); base64url(_:); randomString(bytes:random:); challenge(for:); check(_:_:); authorizeURL(_:_:state:challenge:scope:); code(fromCallback:state:); parseTokens(_:nowMs:); exchange(_:_:code:verifier:nowMs:transport:); refresh(_:_:refreshToken:nowMs:transport:); revoke(_:_:token:transport:) }`
  - `public typealias SourceTransport = (URLRequest, Int) async throws -> (Data, HTTPURLResponse, Bool)`
  - `public enum SourceError: Error, Equatable, Sendable { offline, unreachable, timeout, signedOut, forbidden, notFound, rateLimited(Int), tooLarge, notReady, refusedHost, badResponse, providerError, badQuery }`
  - `public enum SourceHTTP { allowedHosts; isAllowed(_:); enc(_:); urlSessionTransport; map(_ e: URLError) }`
  - `@MainActor public final class SourceSession { init(perMinute:token:refresh:transport:sleep:nowMs:); get(_:cap:headers:) }`
  - `SourceEntry`, `SourceProjectRef`, `SourcePage`, `SourcePreviewKind`, `SourceOpened` (with `Reason`), `@MainActor public protocol SourceReadClient`, `public enum SourcePreview { textCap, extractedCap, pdfCap, jsonCap, kind(_:provider:), decodeText(_:), query(_:), load(_:kind:language:webURL:fetch:), dedupe(_:) }`

- [ ] **Step 1: Write the failing tests**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceOAuthTests.swift`:

```swift
import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("SourceOAuth: PKCE, read-only authorize URLs, callback parsing, token forms")
struct SourceOAuthTests {
    let gl = SourceAppConfig(clientId: String(repeating: "a", count: 64))
    let box = SourceAppConfig(clientId: String(repeating: "b", count: 32), clientSecret: "boxsecret0123456789abcdef")

    @Test("RFC 7636 appendix B vector; verifiers are 43 url-safe characters")
    func pkce() {
        #expect(SourceOAuth.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1zMq7d1Dip6EGHG9w")
        #expect(SourceOAuth.randomString().range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil)
    }

    @Test("authorize URLs: read-only scopes, S256, custom-scheme redirect, no secret")
    func authorize() throws {
        let g = URLComponents(url: SourceOAuth.authorizeURL(.gitlab, gl, state: "st", challenge: "ch"), resolvingAgainstBaseURL: false)!
        func q(_ c: URLComponents, _ n: String) -> String? { c.queryItems?.first { $0.name == n }?.value }
        #expect(g.host == "gitlab.com"); #expect(g.path == "/oauth/authorize")
        #expect(q(g, "scope") == "read_api read_repository")
        #expect(q(g, "code_challenge_method") == "S256")
        #expect(q(g, "redirect_uri") == "llmide-oauth://gitlab/callback")
        let b = URLComponents(url: SourceOAuth.authorizeURL(.box, box, state: "st", challenge: "ch"), resolvingAgainstBaseURL: false)!
        #expect(b.host == "account.box.com"); #expect(q(b, "scope") == "root_readonly"); #expect(q(b, "client_secret") == nil)
        let sp6 = URLComponents(url: SourceOAuth.authorizeURL(.box, box, state: "s", challenge: "c", scope: "root_readwrite"), resolvingAgainstBaseURL: false)!
        #expect(q(sp6, "scope") == "root_readwrite")
        #expect(throws: SourceOAuthError.badClientId) { try SourceOAuth.check(.gitlab, SourceAppConfig(clientId: "x")) }
        #expect(throws: SourceOAuthError.badClientSecret) { try SourceOAuth.check(.box, SourceAppConfig(clientId: box.clientId)) }
        #expect(try SourceOAuth.check(.gitlab, SourceAppConfig(clientId: gl.clientId, clientSecret: "drop")).clientSecret == nil)
    }

    @Test("callback: state must match; access_denied is a cancel; the code is shape-checked")
    func callback() throws {
        #expect(try SourceOAuth.code(fromCallback: URL(string: "llmide-oauth://gitlab/callback?code=good-code-123&state=S")!, state: "S") == "good-code-123")
        #expect(throws: SourceOAuthError.stateMismatch) { try SourceOAuth.code(fromCallback: URL(string: "llmide-oauth://gitlab/callback?code=good-code-123&state=X")!, state: "S") }
        #expect(throws: SourceOAuthError.cancelled) { try SourceOAuth.code(fromCallback: URL(string: "llmide-oauth://box/callback?error=access_denied&state=S")!, state: "S") }
        #expect(throws: SourceOAuthError.failed) { try SourceOAuth.code(fromCallback: URL(string: "llmide-oauth://box/callback?code=%3Cx%3E&state=S")!, state: "S") }
    }

    @Test("tokens: strict parse, wide scopes refused, expiry a minute early")
    func tokens() throws {
        let t = try SourceOAuth.parseTokens(Data(#"{"access_token":"acc-12345678","refresh_token":"r1","expires_in":7200,"scope":"read_api read_repository"}"#.utf8), nowMs: 1000)
        #expect(t == SourceTokens(access: "acc-12345678", refresh: "r1", expiresAtMs: 1000 + 7_200_000 - 60_000))
        #expect(throws: SourceOAuthError.scopeTooWide) { try SourceOAuth.parseTokens(Data(#"{"access_token":"acc-12345678","scope":"api"}"#.utf8), nowMs: 0) }
        #expect(throws: SourceOAuthError.badTokenResponse) { try SourceOAuth.parseTokens(Data(#"{"access_token":1}"#.utf8), nowMs: 0) }
    }

    @Test("exchange and refresh post the right forms; Box adds its secret; errors map")
    func forms() async throws {
        var bodies: [[String: String]] = []
        var status = 200
        let transport: SourceTransport = { req, _ in
            var c = URLComponents(); c.percentEncodedQuery = String(decoding: req.httpBody ?? Data(), as: UTF8.self)
            bodies.append(Dictionary((c.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a }))
            let body = status == 200 ? #"{"access_token":"acc-12345678","refresh_token":"r2","expires_in":3600}"# : #"{"error":"invalid_grant"}"#
            return (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, false)
        }
        _ = try await SourceOAuth.exchange(.gitlab, gl, code: "good-code-123", verifier: "v", nowMs: 0, transport: transport)
        #expect(bodies[0] == ["grant_type": "authorization_code", "code": "good-code-123", "client_id": gl.clientId, "redirect_uri": "llmide-oauth://gitlab/callback", "code_verifier": "v"])
        _ = try await SourceOAuth.exchange(.box, box, code: "good-code-123", verifier: "v", nowMs: 0, transport: transport)
        #expect(bodies[1]["client_secret"] == box.clientSecret)
        _ = try await SourceOAuth.refresh(.box, box, refreshToken: "r1", nowMs: 0, transport: transport)
        #expect(bodies[2] == ["grant_type": "refresh_token", "refresh_token": "r1", "client_id": box.clientId, "client_secret": box.clientSecret!])
        status = 400
        await #expect(throws: SourceOAuthError.grantExpired) { _ = try await SourceOAuth.refresh(.gitlab, gl, refreshToken: "r", nowMs: 0, transport: transport) }
        await SourceOAuth.revoke(.gitlab, gl, token: "t", transport: { _, _ in throw URLError(.notConnectedToInternet) })
    }
}
```

`ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceHTTPTests.swift`:

```swift
import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("SourceSession and preview rules")
struct SourceHTTPTests {
    func ok(_ req: URLRequest, _ status: Int = 200, _ body: String = "x", _ headers: [String: String] = [:]) -> (Data, HTTPURLResponse, Bool) {
        (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, false)
    }

    @Test("allow-list: https, exact hosts, no credentials, port 443")
    func hosts() {
        for s in ["https://gitlab.com/api/v4/x", "https://api.box.com/2.0/x", "https://dl.boxcloud.com/d", "https://public.boxcloud.com/x"] { #expect(SourceHTTP.isAllowed(URL(string: s)!), "\(s)") }
        for s in ["http://gitlab.com/", "https://gitlab.com.evil.example/", "https://u:p@gitlab.com/", "https://gitlab.com:8443/", "https://account.box.com/"] { #expect(!SourceHTTP.isAllowed(URL(string: s)!), "\(s)") }
    }

    @Test("401 refreshes once and retries; 429 waits Retry-After up to twice; offline and refused hosts map")
    func session() async throws {
        var sleeps: [UInt64] = []
        var token = "t1"; var refreshes = 0; var n = 0; var seen: [String] = []
        let s = SourceSession(perMinute: 60_000, token: { token }, refresh: { refreshes += 1; token = "t2"; return token },
                              transport: { req, _ in seen.append(req.value(forHTTPHeaderField: "Authorization") ?? ""); n += 1
                                  switch n { case 1: return self.ok(req, 401); case 2: return self.ok(req, 429, "", ["Retry-After": "3"]); default: return self.ok(req) } },
                              sleep: { sleeps.append($0) }, nowMs: { 0 })
        let (d, _, _) = try await s.get(URL(string: "https://gitlab.com/api/v4/x")!, cap: 10)
        #expect(String(decoding: d, as: UTF8.self) == "x")
        #expect(seen == ["Bearer t1", "Bearer t2", "Bearer t2"]); #expect(refreshes == 1)
        #expect(sleeps.contains(3_000_000_000))
        let limited = SourceSession(perMinute: 60_000, token: { "t" }, refresh: { nil }, transport: { req, _ in self.ok(req, 429, "", ["Retry-After": "999"]) }, sleep: { _ in }, nowMs: { 0 })
        await #expect(throws: SourceError.rateLimited(60)) { _ = try await limited.get(URL(string: "https://api.box.com/x")!, cap: 10) }
        let off = SourceSession(perMinute: 60_000, token: { "t" }, refresh: { nil }, transport: { _, _ in throw URLError(.notConnectedToInternet) }, sleep: { _ in }, nowMs: { 0 })
        await #expect(throws: SourceError.offline) { _ = try await off.get(URL(string: "https://api.box.com/x")!, cap: 10) }
        await #expect(throws: SourceError.refusedHost) { _ = try await off.get(URL(string: "https://evil.example/x")!, cap: 10) }
        let landed = SourceSession(perMinute: 60_000, token: { "t" }, refresh: { nil },
                                   transport: { _, _ in (Data(), HTTPURLResponse(url: URL(string: "https://evil.example/")!, statusCode: 200, httpVersion: nil, headerFields: nil)!, false) }, sleep: { _ in }, nowMs: { 0 })
        await #expect(throws: SourceError.refusedHost) { _ = try await landed.get(URL(string: "https://api.box.com/2.0/files/1/content")!, cap: 10) }
        let gone = SourceSession(perMinute: 60_000, token: { "t" }, refresh: { nil }, transport: { req, _ in self.ok(req, 401) }, sleep: { _ in }, nowMs: { 0 })
        await #expect(throws: SourceError.signedOut) { _ = try await gone.get(URL(string: "https://api.box.com/x")!, cap: 10) }
    }

    @Test("pace: request starts are spaced by 60000/perMinute ms")
    func pace() async throws {
        var sleeps: [UInt64] = []
        let s = SourceSession(perMinute: 60, token: { "t" }, refresh: { nil }, transport: { req, _ in self.ok(req) }, sleep: { sleeps.append($0) }, nowMs: { 0 })
        for _ in 0..<3 { _ = try await s.get(URL(string: "https://gitlab.com/x")!, cap: 10) }
        #expect(sleeps == [1_000_000_000, 2_000_000_000])
    }

    @Test("preview rules and text decoding")
    func preview() async throws {
        #expect(SourcePreview.kind("a.ts", provider: .gitlab).0 == .text)
        #expect(SourcePreview.kind("README.md", provider: .gitlab).0 == .markdown)
        #expect(SourcePreview.kind("deck.PDF", provider: .box).0 == .pdf)
        #expect(SourcePreview.kind("plan.docx", provider: .box).0 == .extracted)
        #expect(SourcePreview.kind("plan.docx", provider: .gitlab).0 == .unsupported)
        #expect(SourcePreview.kind("logo.png", provider: .box).0 == .unsupported)
        #expect(SourcePreview.kind("index.html", provider: .gitlab).0 == .text, "HTML is shown as source text")
        #expect(SourcePreview.decodeText(Data([104, 105])) == "hi")
        #expect(SourcePreview.decodeText(Data([104, 0, 105])) == nil)
        #expect(throws: SourceError.badQuery) { try SourcePreview.query("  ") }
        let e = SourceEntry(id: "1", name: "a.txt", kind: .file, path: "a.txt", size: nil, detail: nil, project: nil)
        let t = try await SourcePreview.load(e, kind: .text, language: "TXT", webURL: nil) { _ in (Data("hi".utf8), HTTPURLResponse(), true) }
        #expect(t.text == "hi"); #expect(t.truncated)
        let p = try await SourcePreview.load(e, kind: .pdf, language: "PDF", webURL: nil) { _ in (Data(), HTTPURLResponse(), true) }
        #expect(p.reason == .tooLarge)
        var fetched = false
        let u = try await SourcePreview.load(e, kind: .unsupported, language: "PNG", webURL: nil) { _ in fetched = true; return (Data(), HTTPURLResponse(), false) }
        #expect(u.reason == .type); #expect(!fetched)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ios_app/SharedProtocol && swift test --filter "SourceOAuth|SourceSession" 2>&1 | tail -20`
Expected: FAIL (`cannot find 'SourceOAuth' in scope`).

- [ ] **Step 3: Implement**

`ios_app/SharedProtocol/Sources/SharedProtocol/SourceOAuth.swift`:

```swift
import Foundation
import CryptoKit

/// Device OAuth for direct reads (design §9, Q11, Q12): authorization code + PKCE S256, read-only scopes by default.
/// Owned by SP7; SP6 (Box sync on devices) passes its own `scope`. The app presents `authorizeURL` with
/// ASWebAuthenticationSession and a `llmide-oauth://<provider>/callback` redirect (iOS 16; https callbacks need 17.4).
public enum SourceProvider: String, Codable, Sendable, CaseIterable { case gitlab, box }

public struct SourceAppConfig: Codable, Equatable, Sendable {
    public var clientId: String
    public var clientSecret: String?
    public init(clientId: String, clientSecret: String? = nil) { self.clientId = clientId; self.clientSecret = clientSecret }
}

public struct SourceTokens: Codable, Equatable, Sendable {
    public var access: String
    public var refresh: String?
    public var expiresAtMs: Int
    public init(access: String, refresh: String?, expiresAtMs: Int) { self.access = access; self.refresh = refresh; self.expiresAtMs = expiresAtMs }
}

public enum SourceOAuthError: Error, Equatable, Sendable {
    case badClientId, badClientSecret, badTokenResponse, scopeTooWide, grantExpired, clientRefused, providerError, unreachable, cancelled, stateMismatch, failed
}

public enum SourceOAuth {
    public static let callbackScheme = "llmide-oauth"
    public static func redirectURI(_ p: SourceProvider) -> String { "\(callbackScheme)://\(p.rawValue)/callback" }

    struct Endpoints { let authorize: URL; let token: URL; let revoke: URL; let scope: String }
    static func endpoints(_ p: SourceProvider) -> Endpoints {
        switch p {
        case .gitlab: return Endpoints(authorize: URL(string: "https://gitlab.com/oauth/authorize")!, token: URL(string: "https://gitlab.com/oauth/token")!,
                                       revoke: URL(string: "https://gitlab.com/oauth/revoke")!, scope: "read_api read_repository")
        case .box: return Endpoints(authorize: URL(string: "https://account.box.com/api/oauth2/authorize")!, token: URL(string: "https://api.box.com/oauth2/token")!,
                                    revoke: URL(string: "https://api.box.com/oauth2/revoke")!, scope: "root_readonly")
        }
    }

    public static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public static func randomString(bytes: Int = 32, random: (Int) -> Data = SyncCrypto.randomBytes) -> String { base64url(random(bytes)) }
    public static func challenge(for verifier: String) -> String { base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }

    public static func check(_ p: SourceProvider, _ c: SourceAppConfig) throws -> SourceAppConfig {
        guard c.clientId.range(of: #"^[A-Za-z0-9_-]{8,128}$"#, options: .regularExpression) != nil else { throw SourceOAuthError.badClientId }
        if p == .gitlab { return SourceAppConfig(clientId: c.clientId) }
        guard let s = c.clientSecret, s.range(of: #"^[A-Za-z0-9]{16,128}$"#, options: .regularExpression) != nil else { throw SourceOAuthError.badClientSecret }
        return SourceAppConfig(clientId: c.clientId, clientSecret: s)
    }

    public static func authorizeURL(_ p: SourceProvider, _ c: SourceAppConfig, state: String, challenge: String, scope: String? = nil) -> URL {
        var u = URLComponents(url: endpoints(p).authorize, resolvingAgainstBaseURL: false)!
        u.queryItems = [URLQueryItem(name: "client_id", value: c.clientId), URLQueryItem(name: "redirect_uri", value: redirectURI(p)),
                        URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "state", value: state),
                        URLQueryItem(name: "scope", value: scope ?? endpoints(p).scope), URLQueryItem(name: "code_challenge", value: challenge),
                        URLQueryItem(name: "code_challenge_method", value: "S256")]
        return u.url!
    }

    public static func code(fromCallback url: URL, state: String) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func v(_ n: String) -> String? { items.first { $0.name == n }?.value }
        guard v("state") == state else { throw SourceOAuthError.stateMismatch }
        if v("error") == "access_denied" { throw SourceOAuthError.cancelled }
        guard let c = v("code"), c.range(of: #"^[A-Za-z0-9._~-]{8,2048}$"#, options: .regularExpression) != nil else { throw SourceOAuthError.failed }
        return c
    }

    public static func parseTokens(_ data: Data, nowMs: Int) throws -> SourceTokens {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let access = o["access_token"] as? String,
              (8...4096).contains(access.count) else { throw SourceOAuthError.badTokenResponse }
        let refresh = o["refresh_token"] as? String
        if let r = refresh, r.count > 4096 { throw SourceOAuthError.badTokenResponse }
        if let scope = o["scope"] as? String, scope.range(of: #"(^|\s)(api|write_repository|root_readwrite)(\s|$)"#, options: .regularExpression) != nil {
            throw SourceOAuthError.scopeTooWide
        }
        let ttl = min(max((o["expires_in"] as? Int) ?? 3600, 1), 86_400)
        return SourceTokens(access: access, refresh: refresh, expiresAtMs: nowMs + ttl * 1000 - 60_000)
    }

    static func post(_ url: URL, _ form: [(String, String)], transport: SourceTransport) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(form.map { "\($0.0)=\(SourceHTTP.enc($0.1))" }.joined(separator: "&").utf8)
        let data: Data, resp: HTTPURLResponse
        do { (data, resp, _) = try await transport(req, 65_536) } catch { throw SourceOAuthError.unreachable }
        guard (200..<300).contains(resp.statusCode) else {
            let err = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String
            if resp.statusCode == 400 || resp.statusCode == 401 { throw err == "invalid_grant" ? SourceOAuthError.grantExpired : SourceOAuthError.clientRefused }
            throw SourceOAuthError.providerError
        }
        return data
    }

    public static func exchange(_ p: SourceProvider, _ c: SourceAppConfig, code: String, verifier: String, nowMs: Int,
                                transport: SourceTransport = SourceHTTP.urlSessionTransport) async throws -> SourceTokens {
        var form = [("grant_type", "authorization_code"), ("code", code), ("client_id", c.clientId), ("redirect_uri", redirectURI(p)), ("code_verifier", verifier)]
        // Box documents no PKCE and requires its secret (spec §8.2); the verifier is sent anyway and is harmless.
        if p == .box { form.append(("client_secret", c.clientSecret ?? "")) }
        return try parseTokens(try await post(endpoints(p).token, form, transport: transport), nowMs: nowMs)
    }

    public static func refresh(_ p: SourceProvider, _ c: SourceAppConfig, refreshToken: String, nowMs: Int,
                               transport: SourceTransport = SourceHTTP.urlSessionTransport) async throws -> SourceTokens {
        var form = [("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("client_id", c.clientId)]
        if p == .gitlab { form.append(("redirect_uri", redirectURI(p))) } else { form.append(("client_secret", c.clientSecret ?? "")) }
        return try parseTokens(try await post(endpoints(p).token, form, transport: transport), nowMs: nowMs)
    }

    /// Best effort: a failed revoke still ends the session here, and the token expires on its own.
    public static func revoke(_ p: SourceProvider, _ c: SourceAppConfig, token: String, transport: SourceTransport = SourceHTTP.urlSessionTransport) async {
        var form = [("client_id", c.clientId), ("token", token)]
        if p == .box { form.append(("client_secret", c.clientSecret ?? "")) }
        _ = try? await post(endpoints(p).revoke, form, transport: transport)
    }
}
```

`ios_app/SharedProtocol/Sources/SharedProtocol/SourceHTTP.swift`:

```swift
import Foundation

/// The guarded HTTP layer for direct reads (design §9, §10): https to four exact hosts, a byte cap, a redirect guard,
/// a per-provider pace, 401 -> one refresh, 429/202 -> Retry-After (at most 2 waits of at most 60 s). GET only.
public typealias SourceTransport = (URLRequest, Int) async throws -> (Data, HTTPURLResponse, Bool)

public enum SourceError: Error, Equatable, Sendable {
    case offline, unreachable, timeout, signedOut, forbidden, notFound, rateLimited(Int), tooLarge, notReady, refusedHost, badResponse, providerError, badQuery
}

final class SourceRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let u = request.url, SourceHTTP.isAllowed(u) else { completionHandler(nil); return }
        var next = request
        // The token never leaves the host it was sent to; Box's pre-signed download URLs need none.
        if u.host != task.originalRequest?.url?.host { next.setValue(nil, forHTTPHeaderField: "Authorization") }
        completionHandler(next)
    }
}

public enum SourceHTTP {
    public static let allowedHosts: Set<String> = ["gitlab.com", "api.box.com", "dl.boxcloud.com", "public.boxcloud.com"]
    public static func isAllowed(_ u: URL) -> Bool {
        u.scheme == "https" && u.user == nil && u.password == nil && (u.port == nil || u.port == 443) && allowedHosts.contains(u.host ?? "")
    }
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    /// encodeURIComponent, stricter: only RFC 3986 unreserved characters stay as they are.
    public static func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "" }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 20
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        return URLSession(configuration: c, delegate: SourceRedirectGuard(), delegateQueue: nil)
    }()
    public static let urlSessionTransport: SourceTransport = { req, cap in
        let (bytes, resp) = try await session.bytes(for: req)
        guard let http = resp as? HTTPURLResponse else { throw SourceError.badResponse }
        var data = Data()
        for try await b in bytes {
            if data.count == cap { return (data, http, true) }
            data.append(b)
        }
        return (data, http, false)
    }
    public static func map(_ e: URLError) -> SourceError {
        switch e.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff: return .offline
        case .timedOut: return .timeout
        default: return .unreachable
        }
    }
}

@MainActor
public final class SourceSession {
    public typealias Sleep = (UInt64) async throws -> Void
    let transport: SourceTransport
    let sleep: Sleep
    let nowMs: () -> Int
    let gapMs: Int
    let token: () async throws -> String
    let refresh: () async -> String?
    private var nextAtMs = 0

    public init(perMinute: Int, token: @escaping () async throws -> String, refresh: @escaping () async -> String?,
                transport: @escaping SourceTransport = SourceHTTP.urlSessionTransport,
                sleep: @escaping Sleep = { try await Task.sleep(nanoseconds: $0) },
                nowMs: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) {
        self.gapMs = max(1, 60_000 / perMinute); self.token = token; self.refresh = refresh
        self.transport = transport; self.sleep = sleep; self.nowMs = nowMs
    }

    public func get(_ url: URL, cap: Int, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse, Bool) {
        guard SourceHTTP.isAllowed(url) else { throw SourceError.refusedHost }
        var refreshed = false
        var waits = 0
        while true {
            let now = nowMs(); let at = max(now, nextAtMs); nextAtMs = at + gapMs
            if at > now { try await sleep(UInt64(at - now) * 1_000_000) }
            let bearer = try await token()
            var req = URLRequest(url: url)
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
            let data: Data, resp: HTTPURLResponse, truncated: Bool
            do { (data, resp, truncated) = try await transport(req, cap) } catch let e as URLError { throw SourceHTTP.map(e) }
            if let landed = resp.url, !SourceHTTP.isAllowed(landed) { throw SourceError.refusedHost }
            switch resp.statusCode {
            case 429, 202:
                let sec = min(max(Int(resp.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 2, 1), 60)
                if waits < 2 { waits += 1; try await sleep(UInt64(sec) * 1_000_000_000); continue }
                throw resp.statusCode == 202 ? SourceError.notReady : SourceError.rateLimited(sec)
            case 200..<300: return (data, resp, truncated)
            case 401 where !refreshed:
                refreshed = true
                guard await refresh() != nil else { throw SourceError.signedOut }
                continue
            case 401: throw SourceError.signedOut
            case 403: throw SourceError.forbidden
            case 404: throw SourceError.notFound
            case 300..<400: throw SourceError.refusedHost
            default: throw SourceError.providerError
            }
        }
    }
}

public struct SourceProjectRef: Hashable, Sendable { public let id: Int; public let ref: String; public let webURL: URL }

public struct SourceEntry: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable { case project, dir, file }
    public let id: String
    public let name: String
    public let kind: Kind
    public let path: String
    public let size: Int?
    public let detail: String?
    public let project: SourceProjectRef?
    public init(id: String, name: String, kind: Kind, path: String, size: Int?, detail: String?, project: SourceProjectRef?) {
        self.id = id; self.name = name; self.kind = kind; self.path = path; self.size = size; self.detail = detail; self.project = project
    }
}

public struct SourcePage: Sendable { public let entries: [SourceEntry]; public let next: String? }

public enum SourcePreviewKind: String, Sendable { case text, markdown, pdf, extracted, unsupported }

public struct SourceOpened: Sendable {
    public enum Reason: String, Sendable { case binary, type, tooLarge, noText }
    public let entry: SourceEntry
    public let kind: SourcePreviewKind
    public let language: String
    public let text: String?
    public let data: Data?
    public let truncated: Bool
    public let webURL: URL?
    public let reason: Reason?
    public init(entry: SourceEntry, kind: SourcePreviewKind, language: String, text: String?, data: Data?, truncated: Bool, webURL: URL?, reason: Reason?) {
        self.entry = entry; self.kind = kind; self.language = language; self.text = text; self.data = data
        self.truncated = truncated; self.webURL = webURL; self.reason = reason
    }
}

@MainActor
public protocol SourceReadClient: AnyObject {
    var provider: SourceProvider { get }
    func list(_ dir: SourceEntry?, cursor: String?) async throws -> SourcePage
    func open(_ file: SourceEntry) async throws -> SourceOpened
    func search(_ q: String, within: SourceEntry?) async throws -> SourcePage
    func webURL(_ e: SourceEntry) -> URL?
}

/// How a file is shown on iOS (decision D2): text (code included, HTML as source), PDF in PDFKit, Office files via
/// Box's extracted text, everything else "not shown". Markdown is shown as its source text on iOS.
public enum SourcePreview {
    public static let textCap = 1_048_576, extractedCap = 2_097_152, pdfCap = 20_971_520, jsonCap = 2_097_152
    static let extractExt: Set<String> = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key"]
    static let binaryExt: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "ico", "zip", "gz", "tgz", "tar", "7z", "rar", "jar", "war",
        "mp3", "mp4", "mov", "wav", "m4a", "avi", "mkv", "woff", "woff2", "ttf", "otf", "eot", "exe", "dll", "so", "dylib", "bin", "dmg", "iso",
        "class", "o", "a", "wasm", "pyc", "sqlite", "db"]

    public static func kind(_ name: String, provider: SourceProvider) -> (SourcePreviewKind, String) {
        let lower = name.lowercased()
        let ext = lower.lastIndex(of: ".").map { String(lower[lower.index(after: $0)...]) } ?? ""
        if ext == "pdf" { return (.pdf, "PDF") }
        if extractExt.contains(ext) { return (provider == .box ? .extracted : .unsupported, ext.uppercased()) }
        if binaryExt.contains(ext) { return (.unsupported, ext.uppercased()) }
        if ["md", "markdown", "mdx"].contains(ext) { return (.markdown, "Markdown") }
        return (.text, ext.isEmpty ? "Text" : ext.uppercased())
    }
    /// nil when the first 8 KiB hold a NUL byte (binary).
    public static func decodeText(_ d: Data) -> String? { d.prefix(8192).contains(0) ? nil : String(decoding: d, as: UTF8.self) }
    public static func query(_ q: String) throws -> String {
        let t = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...200).contains(t.count) else { throw SourceError.badQuery }
        return t
    }
    public static func dedupe(_ es: [SourceEntry]) -> [SourceEntry] { var seen = Set<String>(); return es.filter { seen.insert($0.id).inserted } }

    public static func load(_ e: SourceEntry, kind: SourcePreviewKind, language: String, webURL: URL?,
                            fetch: (Int) async throws -> (Data, HTTPURLResponse, Bool)) async throws -> SourceOpened {
        func out(_ k: SourcePreviewKind, text: String? = nil, data: Data? = nil, truncated: Bool = false, reason: SourceOpened.Reason? = nil) -> SourceOpened {
            SourceOpened(entry: e, kind: k, language: language, text: text, data: data, truncated: truncated, webURL: webURL, reason: reason)
        }
        if kind == .unsupported { return out(.unsupported, reason: .type) }
        if kind == .pdf {
            let (d, _, t) = try await fetch(pdfCap)
            return t ? out(.pdf, reason: .tooLarge) : out(.pdf, data: d)
        }
        let (d, _, t) = try await fetch(kind == .extracted ? extractedCap : textCap)
        guard let text = decodeText(d) else { return out(.unsupported, reason: .binary) }
        return out(kind, text: text, truncated: t)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ios_app/SharedProtocol && swift test 2>&1 | tail -20`
Expected: PASS (all suites, including the new ones). If `swift build` fails with "Invalid manifest" or "Operation not permitted", that is the sandbox (memory note); re-run outside it.

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol/Sources/SharedProtocol/SourceOAuth.swift ios_app/SharedProtocol/Sources/SharedProtocol/SourceHTTP.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceOAuthTests.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceHTTPTests.swift
git commit -m "feat(ios): SharedProtocol read-only OAuth and guarded HTTP for direct reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: SharedProtocol GitLab and Box read clients (Swift)

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/GitLabReadClient.swift`, `ios_app/SharedProtocol/Sources/SharedProtocol/BoxReadClient.swift`
- Create: `ios_app/SharedProtocol/Tests/SharedProtocolTests/FakeSourceServer.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceClientsTests.swift`, `ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceLiveTests.swift`

**Interfaces:**
- Consumes: everything Task 8 produces.
- Produces: `@MainActor public final class GitLabReadClient: SourceReadClient { init(session: SourceSession) }`, `@MainActor public final class BoxReadClient: SourceReadClient { init(session: SourceSession, pollSleep: SourceSession.Sleep = …) }`.

- [ ] **Step 1: Write the fake** `ios_app/SharedProtocol/Tests/SharedProtocolTests/FakeSourceServer.swift`

```swift
import Foundation
@testable import SharedProtocol

/// Fake gitlab.com and Box APIs behind one SourceTransport (no network), mirroring web/tests/helpers/fake-sources.mjs.
@MainActor
final class FakeSourceServer {
    var tokens = ["gitlab": "gitlab-access-1", "box": "box-access-1"]
    var requests: [URLRequest] = []
    var canned: [(prefix: String, status: Int, headers: [String: String])] = []
    var transport: SourceTransport { { [unowned self] req, cap in await self.handle(req, cap) } }
    let rep = "https://dl.boxcloud.com/api/2.0/internal_files/22/versions/1/representations/extracted_text/content/{+asset_path}"

    func reply(_ url: URL, _ status: Int, _ body: Data, _ headers: [String: String] = [:], _ cap: Int) -> (Data, HTTPURLResponse, Bool) {
        (Data(body.prefix(cap)), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!, body.count > cap)
    }
    func json(_ url: URL, _ o: Any, _ cap: Int, _ status: Int = 200, _ headers: [String: String] = [:]) -> (Data, HTTPURLResponse, Bool) {
        reply(url, status, try! JSONSerialization.data(withJSONObject: o), headers, cap)
    }

    func handle(_ req: URLRequest, _ cap: Int) -> (Data, HTTPURLResponse, Bool) {
        requests.append(req)
        let url = req.url!
        if let i = canned.firstIndex(where: { url.absoluteString.hasPrefix($0.prefix) }) { let c = canned.remove(at: i); return reply(url, c.status, Data(), c.headers, cap) }
        let host = url.host ?? ""
        let provider = host == "gitlab.com" ? "gitlab" : "box"
        guard req.value(forHTTPHeaderField: "Authorization") == "Bearer \(tokens[provider]!)" else { return json(url, ["message": "401"], cap, 401) }
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)!.percentEncodedPath
        let q = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        let project: [String: Any] = ["id": 7, "name": "demo", "path_with_namespace": "dee/demo", "default_branch": "main", "web_url": "https://gitlab.com/dee/demo"]
        switch (host, path) {
        case ("gitlab.com", "/api/v4/projects"):
            let all: [[String: Any]] = [project, ["id": 8, "name": "empty", "path_with_namespace": "dee/empty", "web_url": "https://gitlab.com/dee/empty"], ["id": "bad"]]
            return json(url, q["search"].map { s in all.filter { ($0["name"] as? String)?.contains(s) == true } } ?? all, cap, 200, ["X-Next-Page": ""])
        case ("gitlab.com", "/api/v4/projects/7/repository/tree"):
            if q["path"] == "src" { return json(url, [["name": "app.ts", "type": "blob", "path": "src/app.ts"]], cap) }
            return json(url, [["name": "src", "type": "tree", "path": "src"], ["name": "README.md", "type": "blob", "path": "README.md"], ["name": "vendor", "type": "commit", "path": "vendor"]], cap, 200, ["X-Next-Page": "2"])
        case ("gitlab.com", "/api/v4/projects/7/repository/files/src%2Fapp.ts/raw"): return reply(url, 200, Data("export const x = 1;\n".utf8), [:], cap)
        case ("gitlab.com", "/api/v4/projects/7/repository/files/logo.bin/raw"): return reply(url, 200, Data([1, 0, 2]), [:], cap)
        case ("gitlab.com", "/api/v4/projects/7/repository/files/big.txt/raw"): return reply(url, 200, Data(repeating: 97, count: SourcePreview.textCap + 5), [:], cap)
        case ("gitlab.com", "/api/v4/projects/7/search"):
            return json(url, [["path": "src/app.ts", "data": "export const x = 1;"], ["path": "src/app.ts", "data": "again"]], cap)
        case ("api.box.com", "/2.0/folders/0/items"):
            return json(url, ["entries": [["type": "folder", "id": "11", "name": "Specs"], ["type": "file", "id": "21", "name": "notes.md", "size": 8], ["type": "web_link", "id": "31", "name": "Link"]]], cap)
        case ("api.box.com", "/2.0/folders/12/items"):
            let off = Int(q["offset"] ?? "0") ?? 0
            return json(url, ["entries": (0..<(off == 0 ? 100 : 3)).map { ["type": "file", "id": String(1000 + off + $0), "name": "f\(off + $0).txt"] }], cap)
        case ("api.box.com", "/2.0/files/21/content"): return reply(url, 200, Data("# Notes\n".utf8), [:], cap)
        case ("api.box.com", "/2.0/files/23/content"): return reply(url, 200, Data("%PDF-1.4\n".utf8), [:], cap)
        case ("api.box.com", "/2.0/files/22"):
            return json(url, ["representations": ["entries": [["representation": "extracted_text", "status": ["state": "pending"],
                "info": ["url": "https://api.box.com/2.0/internal_files/22/versions/1/representations/extracted_text"], "content": ["url_template": rep]]]]], cap)
        case ("api.box.com", "/2.0/internal_files/22/versions/1/representations/extracted_text"):
            return json(url, ["status": ["state": "success"], "content": ["url_template": rep]], cap)
        case ("api.box.com", "/2.0/files/25"): return json(url, ["representations": ["entries": [Any]()]], cap)
        case ("dl.boxcloud.com", "/api/2.0/internal_files/22/versions/1/representations/extracted_text/content/"): return reply(url, 200, Data("Plan text from Box".utf8), [:], cap)
        case ("api.box.com", "/2.0/search"):
            return json(url, ["entries": [["type": "file", "id": "22", "name": "plan.docx", "path_collection": ["entries": [["name": "All Files"], ["name": "Specs"]]]]]], cap)
        default: return json(url, ["message": "404"], cap, 404)
        }
    }

    func session(_ p: SourceProvider) -> SourceSession {
        SourceSession(perMinute: 60_000, token: { [unowned self] in self.tokens[p.rawValue]! }, refresh: { nil }, transport: transport, sleep: { _ in }, nowMs: { 0 })
    }
}
```

- [ ] **Step 2: Write the failing tests**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceClientsTests.swift`:

```swift
import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("GitLab and Box read clients against fake APIs")
struct SourceClientsTests {
    let proj = SourceProjectRef(id: 7, ref: "main", webURL: URL(string: "https://gitlab.com/dee/demo")!)
    func f(_ path: String) -> SourceEntry { SourceEntry(id: "7:\(path)", name: String(path.split(separator: "/").last!), kind: .file, path: path, size: nil, detail: nil, project: proj) }
    func box(_ id: String, _ name: String, dir: Bool = false) -> SourceEntry { SourceEntry(id: id, name: name, kind: dir ? .dir : .file, path: name, size: nil, detail: nil, project: nil) }

    @Test("GitLab: projects (bad rows dropped), tree with paging, submodules skipped, files by kind, search, web URLs")
    func gitlab() async throws {
        let s = FakeSourceServer(); let c = GitLabReadClient(session: s.session(.gitlab))
        let projects = try await c.list(nil, cursor: nil).entries
        #expect(projects.map(\.path) == ["dee/demo", "dee/empty"])
        #expect(try await c.list(projects[1], cursor: nil).entries.isEmpty, "no default branch: nothing to list")
        let root = try await c.list(projects[0], cursor: nil)
        #expect(root.entries.map(\.name) == ["src", "README.md"]); #expect(root.next == "2")
        let app = try await c.open(try await c.list(root.entries[0], cursor: nil).entries[0])
        #expect(app.text == "export const x = 1;\n"); #expect(app.kind == .text)
        #expect(try await c.open(f("logo.bin")).reason == .binary)
        let big = try await c.open(f("big.txt"))
        #expect(big.truncated); #expect(big.text?.count == SourcePreview.textCap)
        let hits = try await c.search(" x ", within: projects[0]).entries
        #expect(hits.map(\.path) == ["src/app.ts"]); #expect(hits[0].detail == "export const x = 1;")
        #expect(try await c.search("dem", within: nil).entries.map(\.path) == ["dee/demo"])
        #expect(c.webURL(f("src/app.ts"))?.absoluteString == "https://gitlab.com/dee/demo/-/blob/main/src/app.ts")
        #expect(s.requests.allSatisfy { ($0.httpMethod ?? "GET") == "GET" })
    }

    @Test("Box: folders (web links dropped), page-length paging, content, extracted text after one poll, missing text, search")
    func boxClient() async throws {
        let s = FakeSourceServer(); var polls: [UInt64] = []
        let c = BoxReadClient(session: s.session(.box), pollSleep: { polls.append($0) })
        let root = try await c.list(nil, cursor: nil)
        #expect(root.entries.map(\.name) == ["Specs", "notes.md"]); #expect(root.next == nil)
        let p1 = try await c.list(box("12", "Many", dir: true), cursor: nil)
        #expect(p1.entries.count == 100); #expect(p1.next == "100")
        #expect(try await c.list(box("12", "Many", dir: true), cursor: "100").next == nil)
        #expect(try await c.open(box("21", "notes.md")).text == "# Notes\n")
        #expect(try await c.open(box("23", "deck.pdf")).data?.count == 9)
        let plan = try await c.open(box("22", "plan.docx"))
        #expect(plan.kind == .extracted); #expect(plan.text == "Plan text from Box"); #expect(polls == [1_500_000_000])
        #expect(s.requests.first { $0.url!.path == "/2.0/files/22" }?.value(forHTTPHeaderField: "X-Rep-Hints") == "[extracted_text]")
        #expect(try await c.open(box("25", "scan.docx")).reason == .noText)
        let hits = try await c.search("plan", within: box("11", "Specs", dir: true))
        #expect(hits.entries.map(\.path) == ["Specs/plan.docx"])
        #expect(s.requests.last!.url!.query!.contains("ancestor_folder_ids=11"))
        await #expect(throws: SourceError.badResponse) { _ = try await c.list(box("1/../2", "x", dir: true), cursor: nil) }
        #expect(c.webURL(box("22", "plan.docx"))?.absoluteString == "https://app.box.com/file/22")
    }

    @Test("Box: 202 not ready is retried with Retry-After, then reported")
    func notReady() async throws {
        let s = FakeSourceServer()
        for _ in 0..<3 { s.canned.append(("https://api.box.com/2.0/files/21/content", 202, ["Retry-After": "2"])) }
        await #expect(throws: SourceError.notReady) { _ = try await BoxReadClient(session: s.session(.box)).open(box("21", "notes.md")) }
    }
}
```

`ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceLiveTests.swift`:

```swift
import Testing
import Foundation
@testable import SharedProtocol

/// Opt-in live checks against the real APIs; skipped unless the variable is set. Never in CI.
///   LLMIDE_SP7_GITLAB_TOKEN=... LLMIDE_SP7_BOX_TOKEN=... swift test --filter SourceLiveTests
@MainActor
@Suite("Direct reads live (opt-in)")
struct SourceLiveTests {
    static let env = ProcessInfo.processInfo.environment
    func session(_ token: String) -> SourceSession { SourceSession(perMinute: 60, token: { token }, refresh: { nil }) }

    @Test("gitlab.com: projects, tree, open, search", .enabled(if: env["LLMIDE_SP7_GITLAB_TOKEN"] != nil))
    func gitlab() async throws {
        let c = GitLabReadClient(session: session(Self.env["LLMIDE_SP7_GITLAB_TOKEN"]!))
        let p = try #require(try await c.list(nil, cursor: nil).entries.first { $0.project?.ref.isEmpty == false })
        let tree = try await c.list(p, cursor: nil)
        #expect(!tree.entries.isEmpty)
        if let f = tree.entries.first(where: { $0.kind == .file }) { let o = try await c.open(f); #expect(o.text != nil || o.data != nil || o.reason != nil) }
        _ = try await c.search("readme", within: p)
    }

    @Test("Box: root, open, search", .enabled(if: env["LLMIDE_SP7_BOX_TOKEN"] != nil))
    func box() async throws {
        let c = BoxReadClient(session: session(Self.env["LLMIDE_SP7_BOX_TOKEN"]!))
        let root = try await c.list(nil, cursor: nil)
        if let f = root.entries.first(where: { $0.kind == .file }) { let o = try await c.open(f); #expect(o.text != nil || o.data != nil || o.reason != nil) }
        _ = try await c.search("a", within: nil)
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ios_app/SharedProtocol && swift test --filter SourceClientsTests 2>&1 | tail -20`
Expected: FAIL (`cannot find 'GitLabReadClient' in scope`).

- [ ] **Step 4: Implement**

`ios_app/SharedProtocol/Sources/SharedProtocol/GitLabReadClient.swift`:

```swift
import Foundation

/// GitLab code at the source (design §9, Q12): member projects, repository tree, one raw file, blob search.
/// gitlab.com only (decision D1). The app creates it with SourceSession(perMinute: 60): the Free burst is 100/min.
@MainActor
public final class GitLabReadClient: SourceReadClient {
    public let provider = SourceProvider.gitlab
    static let api = "https://gitlab.com/api/v4"
    let http: SourceSession
    public init(session: SourceSession) { http = session }

    func array(_ s: String) async throws -> ([[String: Any]], String?) {
        guard let url = URL(string: s) else { throw SourceError.badResponse }
        let (data, resp, truncated) = try await http.get(url, cap: SourcePreview.jsonCap)
        if truncated { throw SourceError.tooLarge }
        guard let arr = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { throw SourceError.badResponse }
        let n = resp.value(forHTTPHeaderField: "X-Next-Page") ?? ""
        return (arr.compactMap { $0 as? [String: Any] }, n.range(of: #"^\d{1,6}$"#, options: .regularExpression) != nil ? n : nil)
    }
    static func str(_ v: Any?, _ max: Int = 1024) -> String? { (v as? String).flatMap { !$0.isEmpty && $0.count <= max ? $0 : nil } }
    static func project(_ o: [String: Any]) -> SourceEntry? {
        guard let id = o["id"] as? Int, id > 0, let path = str(o["path_with_namespace"]), let name = str(o["name"], 255),
              let web = str(o["web_url"]).flatMap(URL.init(string:)), web.scheme == "https", web.host == "gitlab.com" else { return nil }
        let ref = str(o["default_branch"], 255) ?? ""
        return SourceEntry(id: "p\(id)", name: name, kind: .project, path: path, size: nil, detail: ref.isEmpty ? "Empty project" : nil,
                           project: SourceProjectRef(id: id, ref: ref, webURL: web))
    }
    func projects(_ query: String?, page: String) async throws -> SourcePage {
        var s = "\(Self.api)/projects?membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=50&page=\(page)"
        if let query { s += "&search=\(SourceHTTP.enc(query))" }
        let (items, next) = try await array(s)
        return SourcePage(entries: SourcePreview.dedupe(items.compactMap(Self.project)), next: next)
    }
    static func file(_ p: SourceProjectRef, _ path: String, kind: SourceEntry.Kind, detail: String? = nil) -> SourceEntry {
        SourceEntry(id: "\(p.id):\(path)", name: String(path.split(separator: "/").last ?? Substring(path)), kind: kind, path: path, size: nil, detail: detail, project: p)
    }

    public func list(_ dir: SourceEntry?, cursor: String?) async throws -> SourcePage {
        let page = cursor.flatMap { $0.range(of: #"^\d{1,6}$"#, options: .regularExpression) != nil ? $0 : nil } ?? "1"
        guard let dir else { return try await projects(nil, page: page) }
        guard let p = dir.project else { throw SourceError.badResponse }
        if p.ref.isEmpty { return SourcePage(entries: [], next: nil) }
        var s = "\(Self.api)/projects/\(p.id)/repository/tree?ref=\(SourceHTTP.enc(p.ref))&per_page=100&page=\(page)"
        if dir.kind == .dir { s += "&path=\(SourceHTTP.enc(dir.path))" }
        let (items, next) = try await array(s)
        // "commit" rows are submodules: another repository, not shown.
        let entries = items.compactMap { o -> SourceEntry? in
            guard let path = Self.str(o["path"]), let type = o["type"] as? String, type == "tree" || type == "blob" else { return nil }
            return Self.file(p, path, kind: type == "tree" ? .dir : .file)
        }
        return SourcePage(entries: entries, next: next)
    }

    public func open(_ file: SourceEntry) async throws -> SourceOpened {
        guard let p = file.project,
              let url = URL(string: "\(Self.api)/projects/\(p.id)/repository/files/\(SourceHTTP.enc(file.path))/raw?ref=\(SourceHTTP.enc(p.ref))") else { throw SourceError.badResponse }
        let (kind, lang) = SourcePreview.kind(file.name, provider: .gitlab)
        return try await SourcePreview.load(file, kind: kind, language: lang, webURL: webURL(file)) { cap in try await self.http.get(url, cap: cap) }
    }

    public func search(_ q: String, within: SourceEntry?) async throws -> SourcePage {
        let t = try SourcePreview.query(q)
        guard let p = within?.project else { return try await projects(t, page: "1") }
        if p.ref.isEmpty { return SourcePage(entries: [], next: nil) }
        let (items, _) = try await array("\(Self.api)/projects/\(p.id)/search?scope=blobs&search=\(SourceHTTP.enc(t))&ref=\(SourceHTTP.enc(p.ref))&per_page=20")
        let entries = items.compactMap { o -> SourceEntry? in
            guard let path = Self.str(o["path"]) ?? Self.str(o["filename"]) else { return nil }
            return Self.file(p, path, kind: .file, detail: (o["data"] as? String).map { String($0.prefix(300)) })
        }
        return SourcePage(entries: SourcePreview.dedupe(entries), next: nil)
    }

    public func webURL(_ e: SourceEntry) -> URL? {
        guard let p = e.project else { return nil }
        if e.kind == .project { return p.webURL }
        let path = e.path.split(separator: "/").map { SourceHTTP.enc(String($0)) }.joined(separator: "/")
        return URL(string: "\(p.webURL.absoluteString)/-/\(e.kind == .dir ? "tree" : "blob")/\(SourceHTTP.enc(p.ref))/\(path)")
    }
}
```

`ios_app/SharedProtocol/Sources/SharedProtocol/BoxReadClient.swift`:

```swift
import Foundation

/// Box documents at the source (design §9, Q11): folder items, content or extracted text, search. root_readonly only.
/// The app creates it with SourceSession(perMinute: 240). Shapes follow extension/connectors/box.mjs.
@MainActor
public final class BoxReadClient: SourceReadClient {
    public let provider = SourceProvider.box
    static let api = "https://api.box.com/2.0"
    static let fields = "id,type,name,size,modified_at,extension"
    static let page = 100
    let http: SourceSession
    let pollSleep: SourceSession.Sleep
    public init(session: SourceSession, pollSleep: @escaping SourceSession.Sleep = { try await Task.sleep(nanoseconds: $0) }) {
        http = session; self.pollSleep = pollSleep
    }

    static func validId(_ id: String) -> Bool { id.range(of: #"^\d{1,20}$"#, options: .regularExpression) != nil }
    func object(_ s: String, headers: [String: String] = [:]) async throws -> [String: Any] {
        guard let url = URL(string: s) else { throw SourceError.badResponse }
        let (data, _, truncated) = try await http.get(url, cap: SourcePreview.jsonCap, headers: headers)
        if truncated { throw SourceError.tooLarge }
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw SourceError.badResponse }
        return o
    }
    static func entry(_ o: [String: Any], parentPath: String) -> SourceEntry? {
        guard let type = o["type"] as? String, type == "file" || type == "folder", let id = o["id"] as? String, validId(id),
              let name = o["name"] as? String, !name.isEmpty, name.count <= 255 else { return nil }
        let size = (o["size"] as? Int).flatMap { $0 >= 0 ? $0 : nil }
        return SourceEntry(id: id, name: name, kind: type == "folder" ? .dir : .file, path: parentPath.isEmpty ? name : "\(parentPath)/\(name)",
                           size: size, detail: nil, project: nil)
    }

    public func list(_ dir: SourceEntry?, cursor: String?) async throws -> SourcePage {
        let offset = cursor.flatMap { $0.range(of: #"^\d{1,7}$"#, options: .regularExpression) != nil ? Int($0) : nil } ?? 0
        let id = dir?.id ?? "0"
        guard Self.validId(id) else { throw SourceError.badResponse }
        let o = try await object("\(Self.api)/folders/\(id)/items?fields=\(Self.fields)&limit=\(Self.page)&offset=\(offset)")
        let raw = o["entries"] as? [[String: Any]] ?? []
        // Page length is the end signal (box.mjs B4): total_count can be missing.
        return SourcePage(entries: raw.compactMap { Self.entry($0, parentPath: dir?.path ?? "") }, next: raw.count == Self.page ? String(offset + Self.page) : nil)
    }

    func extractedTextURL(_ id: String) async throws -> URL? {
        let o = try await object("\(Self.api)/files/\(id)?fields=representations", headers: ["X-Rep-Hints": "[extracted_text]"])
        let reps = (o["representations"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []
        guard let rep = reps.first(where: { $0["representation"] as? String == "extracted_text" }) else { return nil }
        var state = (rep["status"] as? [String: Any])?["state"] as? String
        var template = (rep["content"] as? [String: Any])?["url_template"] as? String
        let info = (rep["info"] as? [String: Any])?["url"] as? String
        var tries = 0
        while state == "pending" || state == "none", let info, tries < 3 {
            tries += 1
            try await pollSleep(1_500_000_000)
            let p = try await object(info)
            state = (p["status"] as? [String: Any])?["state"] as? String
            template = ((p["content"] as? [String: Any])?["url_template"] as? String) ?? template
        }
        guard state == "success", let t = template else { return nil }
        return URL(string: t.replacingOccurrences(of: "{+asset_path}", with: ""))
    }

    public func open(_ file: SourceEntry) async throws -> SourceOpened {
        guard Self.validId(file.id) else { throw SourceError.badResponse }
        let (kind, lang) = SourcePreview.kind(file.name, provider: .box)
        let web = webURL(file)
        if kind == .extracted {
            guard let url = try await extractedTextURL(file.id) else {
                return SourceOpened(entry: file, kind: .unsupported, language: lang, text: nil, data: nil, truncated: false, webURL: web, reason: .noText)
            }
            return try await SourcePreview.load(file, kind: kind, language: lang, webURL: web) { cap in try await self.http.get(url, cap: cap) }
        }
        let url = URL(string: "\(Self.api)/files/\(file.id)/content")!
        return try await SourcePreview.load(file, kind: kind, language: lang, webURL: web) { cap in try await self.http.get(url, cap: cap) }
    }

    public func search(_ q: String, within: SourceEntry?) async throws -> SourcePage {
        let t = try SourcePreview.query(q)
        var s = "\(Self.api)/search?query=\(SourceHTTP.enc(t))&type=file&limit=20&fields=\(Self.fields),path_collection"
        if let w = within, w.kind == .dir { guard Self.validId(w.id) else { throw SourceError.badResponse }; s += "&ancestor_folder_ids=\(w.id)" }
        let raw = try await object(s)["entries"] as? [[String: Any]] ?? []
        let entries = raw.compactMap { e -> SourceEntry? in
            let parents = ((e["path_collection"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }.filter { $0 != "All Files" }
            return Self.entry(e, parentPath: parents.joined(separator: "/"))
        }
        return SourcePage(entries: SourcePreview.dedupe(entries), next: nil)
    }

    public func webURL(_ e: SourceEntry) -> URL? { URL(string: "https://app.box.com/\(e.kind == .dir ? "folder" : "file")/\(e.id)") }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ios_app/SharedProtocol && swift test 2>&1 | tail -20`
Expected: PASS; `SourceLiveTests` reports its two tests as skipped.

- [ ] **Step 6: Commit**

```bash
git add ios_app/SharedProtocol/Sources/SharedProtocol/GitLabReadClient.swift ios_app/SharedProtocol/Sources/SharedProtocol/BoxReadClient.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/FakeSourceServer.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceClientsTests.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/SourceLiveTests.swift
git commit -m "feat(ios): SharedProtocol GitLab and Box read clients

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: iPhone store, views, ATS and project membership

**Files:**
- Create: `ios_app/MyApp/Services/SourceReadStore.swift`, `ios_app/MyApp/Views/Control/SourceReadViews.swift`
- Modify: `ios_app/MyApp/Services/SyncStore.swift` (`Keychain.Item`), `ios_app/MyApp/MyAppApp.swift`, `ios_app/MyApp/Views/Control/SyncOfflineViews.swift`, `ios_app/MyApp/Views/Settings/SettingsView.swift`, `ios_app/MyApp/Supporting/Info.plist`, `ios_app/MyApp.xcodeproj/project.pbxproj`

**Interfaces:**
- Consumes: Tasks 8–9 (`SourceOAuth`, `SourceSession`, `GitLabReadClient`, `BoxReadClient`, `SourceReadClient`, `SourceError`, `SourceOAuthError`, `SourceOpened.Reason`, `SourceAppConfig`, `SourceTokens`, `SourceProvider`); `SyncStore.Keychain` (`save`, `load`, `delete`).
- Produces: `@MainActor final class SourceReadStore: ObservableObject` (`configs`, `signedIn`, `busy`, `lastError`, `configure(_:_:) -> Bool`, `forget(_:)`, `signIn(_:)`, `signOut(_:)`, `client(_:)`, `static message(_:)`, `static reasonText(_:)`); views `SourceReadSettingsCard`, `SourceRootSection`, `SourceBrowserView`, `SourceFileView`.

The app target has no unit-test target, so the testable logic is in SharedProtocol (Tasks 8–9). This task is verified by the build and by the manual check in Task 11.

- [ ] **Step 1: Add the Keychain items.** In `ios_app/MyApp/Services/SyncStore.swift`, change

```swift
        enum Item: String { case state = "device-state", keys = "device-keys", mega = "mega-session" }
```

to

```swift
        enum Item: String { case state = "device-state", keys = "device-keys", mega = "mega-session", sourceConfig = "source-config", sourceTokens = "source-tokens" }
```

(`removeFromPhone` deletes only `.state, .keys, .mega`, so removing sync keeps the Box/GitLab sign-ins.)

- [ ] **Step 2: Create** `ios_app/MyApp/Services/SourceReadStore.swift`

```swift
import Foundation
import AuthenticationServices
import UIKit
import SharedProtocol

/// Direct reads (design §9): read-only OAuth to the user's own GitLab and Box. App settings and tokens are in the
/// Keychain, this device only (SyncStore.Keychain, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly). Nothing read
/// from a provider is stored (decision D7).
@MainActor
final class SourceReadStore: ObservableObject {
    @Published private(set) var configs: [SourceProvider: SourceAppConfig] = [:]
    @Published private(set) var signedIn: Set<SourceProvider> = []
    @Published private(set) var busy = false
    @Published private(set) var lastError: String?

    private var tokens: [SourceProvider: SourceTokens] = [:]
    private var refreshTasks: [SourceProvider: Task<String?, Never>] = [:]
    private var clients: [SourceProvider: SourceReadClient] = [:]
    private var authSession: ASWebAuthenticationSession?
    private let anchor = SourceAuthAnchor()
    private var nowMs: Int { Int(Date().timeIntervalSince1970 * 1000) }

    init() {
        configs = Self.keyed(SyncStore.Keychain.load([String: SourceAppConfig].self, .sourceConfig)).filter { (try? SourceOAuth.check($0.key, $0.value)) != nil }
        tokens = Self.keyed(SyncStore.Keychain.load([String: SourceTokens].self, .sourceTokens)).filter { configs[$0.key] != nil }
        signedIn = Set(tokens.keys)
    }
    private static func keyed<T>(_ d: [String: T]?) -> [SourceProvider: T] {
        Dictionary(uniqueKeysWithValues: (d ?? [:]).compactMap { k, v in SourceProvider(rawValue: k).map { ($0, v) } })
    }
    private static func plain<T>(_ d: [SourceProvider: T]) -> [String: T] { Dictionary(uniqueKeysWithValues: d.map { ($0.key.rawValue, $0.value) }) }
    private func saveConfigs() { if configs.isEmpty { SyncStore.Keychain.delete(.sourceConfig) } else { _ = SyncStore.Keychain.save(Self.plain(configs), .sourceConfig) } }
    private func saveTokens() {
        signedIn = Set(tokens.keys)
        if tokens.isEmpty { SyncStore.Keychain.delete(.sourceTokens) } else { _ = SyncStore.Keychain.save(Self.plain(tokens), .sourceTokens) }
    }

    @discardableResult
    func configure(_ p: SourceProvider, _ c: SourceAppConfig) -> Bool {
        do { configs[p] = try SourceOAuth.check(p, c); clients[p] = nil; saveConfigs(); lastError = nil; return true }
        catch { lastError = Self.message(error); return false }
    }

    func forget(_ p: SourceProvider) async {
        await signOut(p)
        configs[p] = nil; clients[p] = nil; saveConfigs()
    }

    func signIn(_ p: SourceProvider) async {
        guard let c = configs[p], !busy else { return }
        busy = true; lastError = nil
        defer { busy = false; authSession = nil }
        let verifier = SourceOAuth.randomString(), state = SourceOAuth.randomString(bytes: 16)
        do {
            let callback = try await authorize(SourceOAuth.authorizeURL(p, c, state: state, challenge: SourceOAuth.challenge(for: verifier)))
            let code = try SourceOAuth.code(fromCallback: callback, state: state)
            tokens[p] = try await SourceOAuth.exchange(p, c, code: code, verifier: verifier, nowMs: nowMs)
            saveTokens()
        } catch SourceOAuthError.cancelled {
            // The user closed the sign-in sheet: not an error.
        } catch { lastError = Self.message(error) }
    }

    func signOut(_ p: SourceProvider) async {
        let t = tokens[p]; tokens[p] = nil; refreshTasks[p] = nil; saveTokens()
        if let t, let c = configs[p] { await SourceOAuth.revoke(p, c, token: t.access) }
    }

    func client(_ p: SourceProvider) -> SourceReadClient {
        if let c = clients[p] { return c }
        let session = SourceSession(perMinute: p == .gitlab ? 60 : 240,
                                    token: { [weak self] in guard let self else { throw SourceError.signedOut }; return try await self.accessToken(p) },
                                    refresh: { [weak self] in await self?.refreshToken(p) })
        let c: SourceReadClient = p == .gitlab ? GitLabReadClient(session: session) : BoxReadClient(session: session)
        clients[p] = c
        return c
    }

    private func accessToken(_ p: SourceProvider) async throws -> String {
        guard let t = tokens[p] else { throw SourceError.signedOut }
        if t.expiresAtMs > nowMs { return t.access }
        guard let fresh = await refreshToken(p) else { throw SourceError.signedOut }
        return fresh
    }

    /// One refresh in flight per provider: Box refresh tokens are single use. Any failure ends that sign-in.
    private func refreshToken(_ p: SourceProvider) async -> String? {
        if let running = refreshTasks[p] { return await running.value }
        let task = Task { @MainActor [weak self] () -> String? in
            guard let self else { return nil }
            guard let c = self.configs[p], let r = self.tokens[p]?.refresh else { self.tokens[p] = nil; self.saveTokens(); return nil }
            do { let t = try await SourceOAuth.refresh(p, c, refreshToken: r, nowMs: self.nowMs); self.tokens[p] = t; self.saveTokens(); return t.access }
            catch { self.tokens[p] = nil; self.saveTokens(); return nil }
        }
        refreshTasks[p] = task
        let value = await task.value
        refreshTasks[p] = nil
        return value
    }

    private func authorize(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: SourceOAuth.callbackScheme) { callback, error in
                if let callback { cont.resume(returning: callback); return }
                if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { cont.resume(throwing: SourceOAuthError.cancelled) }
                else { cont.resume(throwing: SourceOAuthError.failed) }
            }
            s.presentationContextProvider = anchor
            s.prefersEphemeralWebBrowserSession = false // decision D10: reuse the Safari login
            authSession = s
            if !s.start() { cont.resume(throwing: SourceOAuthError.failed) }
        }
    }

    static func message(_ e: Error) -> String {
        switch e {
        case SourceError.offline: return "You are offline. Code and documents are read live and are not kept on this iPhone."
        case SourceError.unreachable: return "The provider is not reachable. Check the network."
        case SourceError.timeout: return "The provider took too long to answer."
        case SourceError.signedOut: return "Your sign-in ended. Sign in again in Settings."
        case SourceError.forbidden: return "The provider refused access to this item."
        case SourceError.notFound: return "Not found. It may have moved or been deleted."
        case SourceError.rateLimited(_): return "The provider asked us to slow down. Wait a minute and try again."
        case SourceError.tooLarge: return "Too large to show here. Open it on the provider's site."
        case SourceError.notReady: return "Box is still preparing this file. Try again in a moment."
        case SourceError.refusedHost: return "The provider sent us to an address this app does not trust."
        case SourceError.badQuery: return "Enter 1 to 200 characters to search."
        case SourceOAuthError.badClientId: return "Enter the application (client) ID from the provider's developer settings."
        case SourceOAuthError.badClientSecret: return "Enter the Box app's client secret."
        case SourceOAuthError.scopeTooWide: return "The provider granted more than read access. Use an app limited to read scopes."
        case SourceOAuthError.clientRefused: return "The provider refused this app's ID or secret. Check the app settings."
        case SourceOAuthError.grantExpired: return "The sign-in code expired. Try again."
        case SourceOAuthError.unreachable: return "The provider is not reachable. Check the network."
        default: return "That did not work. Try again."
        }
    }

    static func reasonText(_ r: SourceOpened.Reason) -> String {
        switch r {
        case .binary: return "This file is binary and is not shown."
        case .type: return "This file type is not shown here."
        case .tooLarge: return "Too large to show here. Open it on the provider's site."
        case .noText: return "Box has no text for this file yet."
        }
    }
}

final class SourceAuthAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}
```

- [ ] **Step 3: Create** `ios_app/MyApp/Views/Control/SourceReadViews.swift`

```swift
import SwiftUI
import PDFKit
import SharedProtocol

/// History tab, desktop off: the way into Box documents and GitLab code at the source (read-only, live).
struct SourceRootSection: View {
    @EnvironmentObject var sources: SourceReadStore
    var body: some View {
        Section("At the source") {
            if sources.signedIn.isEmpty {
                Text("Sign in to GitLab or Box in Settings to read code and documents here, live and read-only.")
                    .font(.footnote).foregroundColor(.secondary)
            }
            if sources.signedIn.contains(.gitlab) { NavigationLink("GitLab code") { SourceBrowserView(provider: .gitlab, dir: nil) } }
            if sources.signedIn.contains(.box) { NavigationLink("Box documents") { SourceBrowserView(provider: .box, dir: nil) } }
        }
    }
}

struct SourceBrowserView: View {
    @EnvironmentObject var sources: SourceReadStore
    let provider: SourceProvider
    let dir: SourceEntry?
    @State private var entries: [SourceEntry] = []
    @State private var next: String?
    @State private var loading = false
    @State private var error: String?
    @State private var query = ""
    @State private var results: [SourceEntry]?

    private var shown: [SourceEntry] { results ?? entries }
    private var searchPrompt: String {
        provider == .gitlab ? (dir == nil ? "Search projects" : "Search code in this project") : (dir == nil ? "Search Box files" : "Search files in this folder")
    }

    var body: some View {
        List {
            if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundColor(DesignSystem.Colors.danger) }
            ForEach(shown) { e in row(e) }
            if loading { ProgressView().accessibilityLabel("Loading") }
            else if shown.isEmpty && error == nil { Text(results == nil ? "Nothing here." : "No results.").foregroundColor(.secondary) }
            if results == nil, next != nil { Button("More") { Task { await load(more: true) } }.disabled(loading) }
        }
        .navigationTitle(dir?.name ?? (provider == .gitlab ? "Projects" : "All files"))
        .searchable(text: $query, prompt: searchPrompt)
        .onSubmit(of: .search) { Task { await search() } }
        .onChange(of: query) { if $0.isEmpty { results = nil } }
        .refreshable { await load(more: false) }
        .task { if entries.isEmpty { await load(more: false) } }
    }

    @ViewBuilder private func row(_ e: SourceEntry) -> some View {
        if e.kind == .file {
            NavigationLink { SourceFileView(provider: provider, entry: e) } label: { label(e) }
        } else {
            NavigationLink { SourceBrowserView(provider: provider, dir: e) } label: { label(e) }
        }
    }
    private func label(_ e: SourceEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(e.name, systemImage: e.kind == .file ? "doc.text" : e.kind == .project ? "shippingbox" : "folder")
            if results != nil, e.path != e.name { Text(e.path).font(.caption).foregroundColor(.secondary) }
            if let d = e.detail { Text(d).font(.caption.monospaced()).foregroundColor(.secondary).lineLimit(3) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(e.kind == .file ? "Opens read-only" : e.kind == .project ? "Opens this project" : "Opens this folder")
    }
    private func load(more: Bool) async {
        loading = true; error = nil
        defer { loading = false }
        do {
            let page = try await sources.client(provider).list(dir, cursor: more ? next : nil)
            entries = more ? entries + page.entries : page.entries
            next = page.next
        } catch { self.error = SourceReadStore.message(error) }
    }
    private func search() async {
        loading = true; error = nil
        defer { loading = false }
        do { results = try await sources.client(provider).search(query, within: dir).entries } catch { self.error = SourceReadStore.message(error) }
    }
}

struct SourceFileView: View {
    @EnvironmentObject var sources: SourceReadStore
    let provider: SourceProvider
    let entry: SourceEntry
    @State private var opened: SourceOpened?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundColor(DesignSystem.Colors.danger).padding(.horizontal) }
            if let o = opened {
                Text("\(o.entry.path) · \(o.language) · read-only").font(.footnote).foregroundColor(.secondary).padding(.horizontal)
                if o.truncated { Text("Only the first part is shown: the file is larger than this app shows.").font(.footnote).padding(.horizontal) }
                if let r = o.reason { Text(SourceReadStore.reasonText(r)).padding(.horizontal) }
                if o.kind == .extracted { Text("Text extracted by Box. Layout and images are not shown.").font(.footnote).foregroundColor(.secondary).padding(.horizontal) }
                if let t = o.text { SourceTextView(text: t, label: "Contents of \(o.entry.name)") }
                else if o.kind == .pdf, let d = o.data { SourcePDFView(data: d, label: "PDF \(o.entry.name)") }
                Spacer(minLength: 0)
            } else if error == nil { ProgressView("Opening…").frame(maxWidth: .infinity) }
        }
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if let u = opened?.webURL, u.scheme == "https" { Link(provider == .gitlab ? "Open on GitLab" : "Open in Box", destination: u) }
            }
        }
        .task {
            guard opened == nil else { return }
            do { opened = try await sources.client(provider).open(entry) } catch { self.error = SourceReadStore.message(error) }
        }
    }
}

/// Read-only, selectable text; no link or data detection; scales with Dynamic Type.
struct SourceTextView: UIViewRepresentable {
    let text: String
    let label: String
    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isEditable = false; v.isSelectable = true; v.dataDetectorTypes = []
        v.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
        v.adjustsFontForContentSizeCategory = true
        v.backgroundColor = .clear
        v.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        v.accessibilityLabel = label
        v.text = text
        return v
    }
    func updateUIView(_ v: UITextView, context: Context) { if v.text != text { v.text = text } }
}

/// PDFKit runs no PDF JavaScript; link taps are swallowed so a document cannot navigate anywhere.
struct SourcePDFView: UIViewRepresentable {
    let data: Data
    let label: String
    final class Coordinator: NSObject, PDFViewDelegate { func pdfViewWillClick(onLink sender: PDFView, with url: URL) {} }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.delegate = context.coordinator
        v.document = PDFDocument(data: data)
        v.accessibilityLabel = label
        return v
    }
    func updateUIView(_ v: PDFView, context: Context) {}
}

/// Settings → Box and GitLab: the user's own app IDs, sign in, sign out, forget.
struct SourceReadSettingsCard: View {
    @EnvironmentObject var sources: SourceReadStore
    @State private var gitlabId = ""
    @State private var boxId = ""
    @State private var boxSecret = ""

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            Text("BOX AND GITLAB")
                .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textTertiary)
                .padding(.leading, DesignSystem.Spacing.xs)
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                Text("Read code and documents live at the source, read-only. Nothing is copied through sync.")
                    .font(DesignSystem.Typography.footnoteFont)
                rows(.gitlab)
                Divider()
                rows(.box)
                if let e = sources.lastError {
                    Text(e).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(DesignSystem.Spacing.md)
            .background(DesignSystem.Colors.surface)
            .cornerRadius(DesignSystem.Layout.cornerRadiusL)
        }
    }

    @ViewBuilder private func rows(_ p: SourceProvider) -> some View {
        let name = p == .gitlab ? "GitLab" : "Box"
        if sources.configs[p] == nil {
            Text(p == .gitlab
                 ? "On gitlab.com add an application (Preferences → Applications): Confidential off, scopes read_api and read_repository, redirect URI \(SourceOAuth.redirectURI(.gitlab))."
                 : "Create a Box Custom App with User Authentication (OAuth 2.0), only “Read all files and folders”, redirect URI \(SourceOAuth.redirectURI(.box)). The secret is kept in this iPhone's Keychain.")
                .font(.footnote).foregroundColor(.secondary)
            if p == .gitlab {
                TextField("GitLab application ID", text: $gitlabId).autocapitalization(.none).autocorrectionDisabled().textFieldStyle(.roundedBorder)
            } else {
                TextField("Box client ID", text: $boxId).autocapitalization(.none).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                SecureField("Box client secret", text: $boxSecret).textFieldStyle(.roundedBorder)
            }
            Button("Save \(name) app") { save(p) }
        } else if sources.signedIn.contains(p) {
            Text("\(name): signed in.")
            Button("Sign out of \(name)") { Task { await sources.signOut(p) } }
        } else {
            Button(sources.busy ? "Signing in…" : "Sign in to \(name)") { Task { await sources.signIn(p) } }.disabled(sources.busy)
            Button("Forget \(name) app", role: .destructive) { Task { await sources.forget(p) } }
        }
    }

    private func save(_ p: SourceProvider) {
        let trim = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
        let c = p == .gitlab ? SourceAppConfig(clientId: trim(gitlabId)) : SourceAppConfig(clientId: trim(boxId), clientSecret: trim(boxSecret))
        boxSecret = ""
        if sources.configure(p, c) { gitlabId = ""; boxId = "" }
    }
}
```

- [ ] **Step 4: Wire the store and entry points**

`ios_app/MyApp/MyAppApp.swift`: add `@StateObject private var sourceReadStore: SourceReadStore` after `@StateObject private var syncStore: SyncStore`; add `_sourceReadStore = StateObject(wrappedValue: SourceReadStore())` after `_syncStore = StateObject(wrappedValue: SyncStore())`; add `.environmentObject(sourceReadStore)` after `.environmentObject(syncStore)`.

`ios_app/MyApp/Views/Control/SyncOfflineViews.swift`: in `SyncOfflineSections.body`, make `SourceRootSection()` the first statement, before `if let snap = syncStore.snapshot {`.

`ios_app/MyApp/Views/Settings/SettingsView.swift`: directly after the line `SyncSettingsCard()`, add a blank line and `SourceReadSettingsCard()`.

- [ ] **Step 5: ATS.** First run `git status --short ios_app/MyApp/Supporting/Info.plist` (see Global Constraints). In `ios_app/MyApp/Supporting/Info.plist`, inside the `NSAppTransportSecurity` dict, after `<key>NSAllowsArbitraryLoads</key>` `<true/>`, add:

```xml
		<!-- Direct reads (SP7): ATS stays fully on for Box and GitLab, whatever the LAN exemption above allows. -->
		<key>NSExceptionDomains</key>
		<dict>
			<key>box.com</key>
			<dict>
				<key>NSIncludesSubdomains</key>
				<true/>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<false/>
				<key>NSExceptionMinimumTLSVersion</key>
				<string>TLSv1.2</string>
			</dict>
			<key>boxcloud.com</key>
			<dict>
				<key>NSIncludesSubdomains</key>
				<true/>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<false/>
				<key>NSExceptionMinimumTLSVersion</key>
				<string>TLSv1.2</string>
			</dict>
			<key>gitlab.com</key>
			<dict>
				<key>NSIncludesSubdomains</key>
				<true/>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<false/>
				<key>NSExceptionMinimumTLSVersion</key>
				<string>TLSv1.2</string>
			</dict>
		</dict>
```

Run: `plutil -lint ios_app/MyApp/Supporting/Info.plist`. Expected: `OK`.

- [ ] **Step 6: Add both files to the Xcode project.** In `ios_app/MyApp.xcodeproj/project.pbxproj` (IDs `…A7`–`…AA` are unused; check with `grep -c "C2E0A1B2C3D4E5F6000000A[7-9A]" ios_app/MyApp.xcodeproj/project.pbxproj`, which must print 0 first):
  - In the `PBXBuildFile` section, after the `SyncOfflineViews.swift in Sources` line, add:
    ```
		C2E0A1B2C3D4E5F6000000A8 /* SourceReadStore.swift in Sources */ = {isa = PBXBuildFile; fileRef = C2E0A1B2C3D4E5F6000000A7 /* SourceReadStore.swift */; };
		C2E0A1B2C3D4E5F6000000AA /* SourceReadViews.swift in Sources */ = {isa = PBXBuildFile; fileRef = C2E0A1B2C3D4E5F6000000A9 /* SourceReadViews.swift */; };
    ```
  - In the `PBXFileReference` section, after the `SyncOfflineViews.swift` file reference line, add:
    ```
		C2E0A1B2C3D4E5F6000000A7 /* SourceReadStore.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SourceReadStore.swift; sourceTree = "<group>"; };
		C2E0A1B2C3D4E5F6000000A9 /* SourceReadViews.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SourceReadViews.swift; sourceTree = "<group>"; };
    ```
  - In the `Services` group (`D5B9C62ACB1A2174374B7BC4`), after `C2E0A1B2C3D4E5F6000000A1 /* SyncStore.swift */,` add `C2E0A1B2C3D4E5F6000000A7 /* SourceReadStore.swift */,`.
  - In the `Control` group (`99D8815DC559E39FCBCE47AC`), after `C2E0A1B2C3D4E5F6000000A5 /* SyncOfflineViews.swift */,` add `C2E0A1B2C3D4E5F6000000A9 /* SourceReadViews.swift */,`.
  - In the app target's `PBXSourcesBuildPhase`, after `C2E0A1B2C3D4E5F6000000A6 /* SyncOfflineViews.swift in Sources */,` add `C2E0A1B2C3D4E5F6000000A8 /* SourceReadStore.swift in Sources */,` and `C2E0A1B2C3D4E5F6000000AA /* SourceReadViews.swift in Sources */,`.

`AuthenticationServices` and `PDFKit` are system frameworks; Swift auto-links them on `import`, so no "Link Binary" change is needed.

- [ ] **Step 7: Build to verify**

Run (as in `.github/workflows/ios-ci.yml`):

```bash
cd ios_app && xcodebuild -project MyApp.xcodeproj -target MyApp -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO SYMROOT="$TMPDIR/ios-build" build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`. Then run `cd ios_app/SharedProtocol && swift test 2>&1 | tail -3` (still green). Then run `grep -rn "localStorage\|UserDefaults" ios_app/MyApp/Services/SourceReadStore.swift`, which must print nothing.

- [ ] **Step 8: Commit**

```bash
git add ios_app/MyApp/Services/SourceReadStore.swift ios_app/MyApp/Views/Control/SourceReadViews.swift ios_app/MyApp/Services/SyncStore.swift ios_app/MyApp/MyAppApp.swift ios_app/MyApp/Views/Control/SyncOfflineViews.swift ios_app/MyApp/Views/Settings/SettingsView.swift ios_app/MyApp.xcodeproj/project.pbxproj
git add -p ios_app/MyApp/Supporting/Info.plist   # only the NSExceptionDomains hunk
git commit -m "feat(ios): read Box documents and GitLab code at the source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Setup how-to, manual iPhone check, spec status

**Files:**
- Create: `docs/how-to/read-box-gitlab-on-phone-and-web.md`
- Modify: `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` (§14 SP7 row), `ios_app/APP_REVIEW_NOTES.md` (one paragraph)

**Interfaces:** none (docs). Verified by `make docs-check` if that target covers `docs/how-to/` (run it; it must pass).

- [ ] **Step 1: Write** `docs/how-to/read-box-gitlab-on-phone-and-web.md`

```markdown
# Read Box documents and GitLab code on the iPhone and the web app

With the desktop off, the LLM-IDE iPhone app and web app can read your documents in Box and your code on gitlab.com
directly: browse, open one file read-only, and search. They use your own provider logins with read-only access.
Nothing is copied through sync and nothing read is stored on the device. Design: spec §9; plan
docs/superpowers/plans/2026-11-06-sync-sp7-direct-reads.md.

## GitLab (gitlab.com)

1. On gitlab.com: avatar → Preferences → Applications → Add new application.
2. Name: `LLM-IDE reader`. Untick **Confidential**. Tick only **read_api** and **read_repository**.
3. Redirect URIs, one per line (add the ones you use):
   - web: `https://llm-ide.com/app/oauth-callback.html` (your site) and, for development, `http://127.0.0.1:5180/oauth-callback.html`
   - iPhone: `llmide-oauth://gitlab/callback`
4. Save, copy the **Application ID** (there is no secret to copy for a non-confidential app), and paste it into
   the web app (Documents and code → GitLab code → App settings) or the iPhone app (Settings → Box and GitLab).
5. Sign in. A sign-in lasts for the browser session on the web, and on the iPhone until you sign out.

Self-hosted GitLab is not supported yet (decision D1).

## Box

1. In the Box developer console: Create New App → Custom App → **User Authentication (OAuth 2.0)**.
2. Application scopes: tick only **Read all files and folders stored in Box**. Leave everything else off.
3. Redirect URIs: `https://llm-ide.com/app/oauth-callback.html` (web), `http://127.0.0.1:5180/oauth-callback.html`
   (development), and `llmide-oauth://box/callback` (iPhone). If the console refuses the `llmide-oauth://` URI, the
   iPhone cannot sign in to Box yet (decision D9).
4. **CORS Domains** (web only): `https://llm-ide.com` and, for development, `http://127.0.0.1:5180`. Without them,
   Box refuses every call from the web app.
5. Copy the Client ID and Client Secret into the app. Box requires the secret for sign-in (it documents no PKCE). It
   is your own app's secret and is kept in this browser's IndexedDB or the iPhone Keychain. Anyone who controls
   script on the LLM-IDE site could read it, so revoke it in the Box console if you suspect that.
6. Sign in. Box shows a consent screen asking for read access only.

Box refresh tokens are single use and last 60 days. After 60 days without use, sign in again.

## What is shown

| File | Shown as |
|---|---|
| Code, config, text, HTML, SVG | plain text (source, never rendered), up to 1 MiB |
| Markdown | web: formatted, without HTML or images; iPhone: source text |
| PDF | iPhone: in the app (PDFKit, links disabled); web: **Save PDF** only |
| Word, Excel, PowerPoint and similar (Box) | the text Box extracts, up to 2 MiB |
| Images, archives, media, binaries | not shown; use "Open on Box/GitLab" |

## Revoke

- GitLab: Preferences → Applications → Authorized applications → Revoke.
- Box: Account settings → Apps → revoke the app, or remove it in the developer console.
- In LLM-IDE: **Sign out** revokes the token; **Forget app settings** also deletes the IDs and the Box secret.

## Manual check (iPhone)

- [ ] Settings → Box and GitLab: save the GitLab ID, **Sign in to GitLab**. The system sign-in sheet shows
      gitlab.com and asks for `read_api` and `read_repository`. Closing the sheet shows no error.
- [ ] With the Mac unreachable, History → At the source → GitLab code: projects, a folder, a `.swift` file
      (monospaced, selectable, larger with a larger text size), a `.png` (not shown), search inside a project.
- [ ] Box: a `.pdf` opens in the app and a link in it does nothing; a `.docx` shows extracted text.
- [ ] Airplane mode: opening a folder says "You are offline…".
- [ ] VoiceOver reads each row as "name, Folder/File" with the hint, and the file body as "Contents of …".
- [ ] Remove sync from this iPhone (Settings → Sync): the Box/GitLab sign-ins stay.
```

- [ ] **Step 2: Update the spec status.** In `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` §14, replace the SP7 row's last cell `docs and code with the desktop off` with:

```
docs and code with the desktop off — **plan written** (docs/superpowers/plans/2026-11-06-sync-sp7-direct-reads.md; owns the shared device OAuth module that SP6 reuses)
```

- [ ] **Step 3: App Review note.** Append to `ios_app/APP_REVIEW_NOTES.md`:

```markdown
## Box and GitLab reading

Settings → Box and GitLab lets the user sign in to their own Box and gitlab.com accounts with OAuth
(ASWebAuthenticationSession), with read-only scopes, to read their documents and code. Tokens are kept in the Keychain
on this device only. Files are shown as text or in PDFKit; nothing is executed or stored. Reviewers need their own
Box/GitLab account and app IDs to try it; the rest of the app works without it.
```

- [ ] **Step 4: Verify**

Run: `make docs-check 2>&1 | tail -5; cd web && npm test 2>&1 | tail -3; cd ../ios_app/SharedProtocol && swift test 2>&1 | tail -3`
Expected: docs check passes (or reports nothing about the new files); web and SharedProtocol suites PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/how-to/read-box-gitlab-on-phone-and-web.md docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md ios_app/APP_REVIEW_NOTES.md
git commit -m "docs: set up Box and GitLab reads on the iPhone and the web app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

- §9 Box reads (`folders/:id/items`, `files/:id/content`, `extracted_text`, PWA origin in CORS domains): Tasks 4, 9, 11. Q11 `root_readonly`: Tasks 1, 8 (scope on the authorize URL, wide scopes refused).
- §9 GitLab reads (`repository/tree`, `files/:path/raw?ref=`), no proxy for gitlab.com, PKCE with `read_api` + `read_repository` (Q12): Tasks 1, 3, 8, 9. The self-hosted proxy is decision D1 (not built).
- §9 "never pass through the sync store": the clients only call provider hosts (allow-list tests in Tasks 2, 8).
- §10 rate limits: pace 60/min GitLab, 240/min Box, Retry-After back-off (Tasks 2, 8).
- Requirements: read-only scopes, secure token storage (memory on the web, Keychain this-device-only on iOS; never localStorage), rendering safety (text only, no-HTML Markdown, no PDF frame on the web, PDFKit with links swallowed), size caps, offline behaviour, accessibility, fake-API tests plus opt-in live tests, exact CSP hosts, iOS ATS: Global Constraints and Tasks 1–10.
- Placeholder scan: every code step carries its code; IDs, paths and commands are concrete.
- Type consistency: `Entry`/`Opened`/`SourceClient` (web) and `SourceEntry`/`SourceOpened`/`SourceReadClient` (Swift) are used under the same names in every later task. `guardedGet(url, auth, pacer, cap, d, headers)` matches its callers in Tasks 3–4. `SourceSession.get(_:cap:headers:)` matches its callers in Task 9.
