# Phone and web when the desktop is off: decision memo

Date: 2026-11-05. Read-only research; nothing in the repo was changed. Prices and limits were checked on the web today; where only third-party pages were found this is said.

## 0. Facts that frame the answer

1. **No option runs AI while the desktop is off** unless a server holds the user's Claude credential. That credential is personal (`claude login`, ADR 0015) and must stay on the user's machine; ADR 0019 §3 refused server-side AI for the same reason. So every option gives the phone/web the same ceiling when the desktop is off: **read the last published snapshot + queue requests** that run when the desktop returns.
2. **The desktop must not need a login.** ADR 0019 §6 makes the desktop sign in with OAuth at llm-ide.com; that part is withdrawn by the user's constraint.
3. **Documents live in Box, code in GitLab.** Both are reachable from the phone/web directly with the user's own Box / GitLab login (section 3), so they are **not copied** into the sync. The only data that must travel is the desktop's own: chats, meeting notes, meetings, tasks/plans, usage (local SQLite + notes folder).
4. **The desktop already talks to Box without a user login.** `extension/connectors/box.mjs` authenticates with a Client Credentials Grant (`buildTokenForm`: `grant_type=client_credentials`, `box_subject_type`/`box_subject_id`) using app credentials the user entered once as connector setup. The same session can write files. That is the one storage medium where the desktop side costs **no new login and no new auth code**.

## 1. What exists in the repo

- Host API v1 (`schema/host-api/v1/`, `extension/routes/host-api/`): PIN/QR pairing, pinned TLS, direct phone→desktop; `LLMIDE_HOST_API_READ=1` already serves `chat.sessions`, `chat.history`, `usage.get` redacted and clamped. Only while the desktop is up. Keep as the "desktop on" path.
- Relay + accounts (`account-service/src/*.mjs`, `desktop/src-tauri/src/relay/{bridge,client,crypto,registry}.rs`, `account_oauth.rs`, ~2.7k lines): E2E envelopes, passkey accounts, desktop OAuth, commitment-based device linking. Review round 3 (`docs/superpowers/reviews/2026-11-05-relay-review.md`): **the envelope crypto, relay auth and routing held; the device-linking ceremony keeps breaking** (a malicious account service still takes over a link in ~1 s). The outbound Rust client loop is unfinished; PWA and iOS tiers not built; G-EXT (paid external review) still required before public exposure.
- Box connector (`extension/connectors/box.mjs`, Pattern A): CCG token, pinned fetch, 429 back-off, folder walk, `extracted_text` representations. GitLab: `extension/connectors/issues.mjs` / `git.mjs` and the dispatcher.
- `deploy/vps/`: nginx + systemd units for the account service on the one VPS.

## 2. Comparison (medium for the desktop's own data)

Off = phone/web with the desktop off. E2E = the storage operator cannot read. Login = desktop login needed. Effort/risk are for one person.

| # | Approach | Off: read / queue / AI | Privacy | Money | Effort + security risk | Platforms (iPhone / web / mac / win / linux) | Desktop login | Lock-in |
|---|---|---|---|---|---|---|---|---|
| **A** | **Box as the sync medium**: desktop writes client-side-encrypted snapshot files + reads an encrypted inbox in a dedicated Box folder through the **existing CCG session**; phone/web use Box OAuth 2.0 (the user's own Box) | read / queue / no | E2E (Box holds ciphertext; key minted by the desktop, handed over by the existing QR pairing) | **$0**: Box Individual 10 GB free, 250 MB per upload; API free; 1000 req/min/user, 240 uploads/min/user | **Low**: no server, no accounts, no identity service; crypto reused from `relay/crypto.rs`; auth on the desktop already exists; phone/web = standard OAuth PKCE + file GET/PUT; user-event long polling gives change signals | all five (API only; no Box Drive needed, so Linux is fine) | **No** (connector setup already done) | Box API on phone/web; folder format is provider-neutral (any object store could replace it) |
| a | Current relay + passkey accounts on the VPS | read / queue / no | E2E | $0 extra + budgeted paid external review | **High**: 3 review rounds, linking still broken; a public identity service = mail, abuse, legal, breach duty (ADR 0019 "Negative") | all five | **Yes** (OAuth+PKCE, ADR 0019 §6) | none |
| e' | Relay-lite on the VPS: keep blob store + envelope crypto, delete passkeys/OAuth/linking; desktop mints capability tokens delivered by QR pairing | read / queue / no | E2E | $0 extra | **Medium**: finish the Rust client loop, delete half the account service; still your own protocol; you run a public blob store (DoS, quotas) for every user, forever | all five | No | none |
| b | Apple CloudKit private DB (native Mac + iOS; CloudKit JS for web) | read / queue / no | Apple-side keys unless the user turns on Advanced Data Protection; the developer never sees data; CloudKit JS cannot read encrypted fields and ADP disables web access by default | $0: counts against the **user's** iCloud quota (5 GB free) | Low on Apple, high elsewhere: no server; Tauri needs a Rust→CloudKit bridge + entitlements; Windows/Linux only via CloudKit Web Services with an Apple ID web sign-in | iPhone yes / web partial / mac yes / win+linux poor | No on macOS; Apple web sign-in on Win/Linux | Apple ID for every user; no Android |
| c | Other user-owned cloud folder (Dropbox App Folder, iCloud Drive container), Joplin/Obsidian pattern | read / queue / no | E2E | $0 (Dropbox 2 GB; iCloud 5 GB) | Low, but needs a **new** desktop auth or the provider's desktop client; Google Drive is not a drop-in (`drive.file` cannot see client-written files; full `drive` scope needs a paid CASA review) | all (Dropbox); Apple only (iCloud) | folder picker or new OAuth | per provider |
| g | **GitLab private repo as the medium** | read / queue / no | E2E possible | $0 (10 GiB per project on Free) | Low code, **wrong tool**: every snapshot is a commit, history keeps every old ciphertext forever (defeats key rotation, relay §4.9), repo bloat needs force-push + GC, 100 req/min burst, inbox writes from the phone need write tokens in the PWA, and the desktop needs a GitLab token with write scope. Use GitLab for code reads only (section 3) | all | token (already configured for issues) | GitLab |
| d1 | Turso / libSQL embedded replica | read / queue / no | **not E2E** unless every column is encrypted (kills FTS5 search) | Free: 100 DBs, 5 GB, 3 GB syncs/mo; Developer $4.99/mo | High: replaces `better-sqlite3`/WAL/FTS5 core; desktop needs a Turso token | all | effectively yes | high |
| d2 | PowerSync / ElectricSQL / Supabase | read / queue / no | plaintext at provider | PowerSync free 500 MB hosted, 2 GB synced/mo (3rd-party figures); Supabase free 500 MB, **pauses after 7 idle days** | High: Postgres backend + schema rewrite; the pause defeats "always on" | all | yes | high |
| d3 | PocketBase on the VPS | read / queue / no | plaintext unless you encrypt = e' in Go | $0 | Medium; same operator duties as e' | all | no | low |
| d4 | CRDT (Yjs/Automerge) sync server | read / queue / no | plaintext unless encrypted | $0 self-host | Very high: wrong model for a relational SQLite core | all | no | medium |
| d5 | Syncthing, VPS as untrusted (receive-encrypted) node | read / queue / no | E2E (feature marked beta) | $0 | No web client, no first-party iOS | desktops yes; iPhone 3rd-party; web no | no | low |
| f | Tailscale / Cloudflare Tunnel | **nothing**: they only reach a desktop that is on | n/a | free tiers | low | all | no | low |

### What well-known apps do

- **Joplin**: E2E on top of Dropbox / OneDrive / WebDAV / S3; no own cloud. The closest precedent to A.
- **Obsidian**: own E2E Sync at $4/mo (1 vault, 1 GB) or $8/mo, or free via any synced folder. "A folder the user already has" is an accepted sync medium.
- **Bear**: CloudKit, $30/yr, deliberately Apple-only because of it (option b's lock-in, live).
- **Things / Standard Notes / Anytype**: each funds or requires its own sync server (Standard Notes free tier + self-host; paid ~$90–120/yr; Anytype any-sync self-host, source-available). This user cannot fund an operated service.
- **Signal linked devices**: the server stores encrypted queues so a linked desktop works while the phone is off; links expire if the primary stays away. Same shape as e'.
- **1Password**: zero-knowledge server + a client-held Secret Key the server never sees: the "key by QR" model in A/e'.
- **Apple Notes**: per-device iCloud copy, offline edits merge later; web disabled under ADP. E2E and web access fight each other (option b).

## 3. Docs and code with the desktop off: read them at the source

- **Box (documents)**: the phone/web sign in to the user's Box with OAuth 2.0 + PKCE (public client; scopes are coarse, `root_readonly` is enough for reading) and call `GET /2.0/folders/:id/items`, `GET /2.0/files/:id/content`, and the same `representations` (`extracted_text`, PDF) `box.mjs` already uses. Box's own iOS app also exists for previews. Cheap: REST only; the app's **CORS domains** are set in the Box developer console, so the PWA calls Box directly. Rate limit 1000 req/min per user.
- **GitLab (code)**: `GET /projects/:id/repository/files/:path/raw?ref=` and `/repository/tree` with a personal access token (`read_api` / `read_repository`) or GitLab OAuth (PKCE). Free: 5,000 req/h, 100 req/min burst; 60/h anonymous. Verify in R1 whether gitlab.com answers CORS for a PWA origin; if not, the static-PWA nginx on the VPS proxies `/gitlab/*` with no credentials of its own (a 10-line location block).
- **What is NOT at the source**: the planner's grounded view, FTS5 search, code graph, notes with links back to meetings. Those are desktop derivatives; the snapshot carries only a compact, per-kind rendering (relay design §2.2 kinds, ≤256 KiB each), not the SQLite file.

## 4. Recommendation for this user

**Top pick: A, Box as the encrypted sync medium for the desktop's own data, reusing the Box connector's existing CCG session on the desktop.**

Why it fits every constraint at once: $0 and nothing to operate (no public identity service, no abuse/mail/legal duties, no G-EXT bill); **no desktop login** because the Library's Box connector is already authenticated; the phone and web log in to the *user's* Box (allowed); data is E2E with a key the desktop mints and hands over by the existing QR/PIN pairing; it covers iPhone, web, macOS, Windows and Linux with the API alone; docs stay in Box and code in GitLab, read directly (section 3), so the snapshot is small.

**Layout in Box** (one folder `LLM-IDE/sync/<desktop-id>/`): `manifest.json` (signed, `manifestSeq`, `validUntil`, kind→file map), `snap/<kind>.bin` (chats, meeting notes, meetings, tasks/plans, usage; ciphertext + clear envelope), `inbox/<device>/<seq>.bin` (queued requests), `outbox/<device>/<seq>.bin` (replies), `keys/<device>.wrap` (signed per-device key wraps, relay §4.4). Phone/web long-poll Box user events to learn of a new manifest; the desktop polls the inbox on a timer while on (Box events also work from the CCG session).

**When the desktop is off**: phone/web decrypt the last snapshot and queue requests; the desktop drains the inbox on return through the Host API v1 command set (`extension/routes/host-api/commands.generated.mjs`) at the relay design's fixed read-only ceiling (§5.2, D2). No AI off-desktop, same as every option.

**Reuse / replace / retire in the repo**

- Reuse: `desktop/src-tauri/src/relay/crypto.rs` and its TS/WebCrypto twin + vectors (envelope, AES-GCM, HKDF, signatures, key wrap); `extension/connectors/box.mjs` session + pinned fetch (add `PUT`/upload and `events` long-poll to the GET-only helpers); Host API v1 commands and the PIN/QR pairing (`routes/host-api/pin.mjs`) for key hand-over; the relay design's snapshot kinds, manifest and read-only ceiling; `deploy/vps/` nginx to serve the static PWA (and the optional GitLab proxy).
- Replace: the relay HTTP surface (manifest/blobs/inbox/outbox endpoints) becomes files in Box; the "desktop snapshot producer / request consumer" (relay R3) is built once, against a `SyncStore` interface with a Box adapter (a VPS or Dropbox adapter later is one file).
- Retire: `account-service/` identity (passkeys, email links), `account_oauth.rs`, the commitment-linking ceremony, the server device registry. The desktop's local signed registry (relay §4.6) stays. ADR 0019 §1, §4–§7 withdrawn; §2–§3 stand. Update MASTER-PLAN Q-WEB-1/2.
- Keep: Host API v1 direct path (LAN/Tailscale) for the "desktop on" case: faster, already reviewed, and gives the phone live AI.

**Fallback: e', relay-lite on the existing VPS**: keep the account service's relay unit (blob store + envelopes, which the review found sound), delete passkey accounts, desktop OAuth and the linking ceremony, and let the desktop mint per-device capability tokens delivered by QR. Same money; choose it only if Box's coarse OAuth scope (phone/web app gets read/write to the whole Box account) or Box dependence is unacceptable. Because the producer/consumer sit behind `SyncStore`, switching is one adapter.

Apple-only shortcut if time runs out: CloudKit/iCloud container shared by the native Mac + iPhone apps is the least code, but no web and no Windows/Linux.

## 5. Cost and effort (estimate, not measured)

- Money: **$0/month beyond the existing VPS** (which now only serves the static PWA; a free static host would do). Apple Developer already paid. No external review bill: the remaining crypto is the already-vectored envelope on top of a provider that only ever sees ciphertext.
- Effort, one person, part time: Box write/events in `box.mjs` + desktop producer/consumer behind a flag (~1 week; the reads are Host API v1 `read` commands already), key hand-over added to QR pairing (days), PWA with Box PKCE + decrypt + queue + Box/GitLab direct reads (~1–2 weeks), iPhone client (~1–2 weeks). Roughly **4–6 weeks** to a usable read+queue tier, versus the relay path's unfinished client loop + PWA + iOS + external review.

## 6. Main risks

1. **Box CCG on a free account**: CCG needs an app authorised in a Box Admin Console or a free *developer* account where apps self-authorise. The connector already works for this user, so the desktop side is proven; a second user must do the same setup (document it). If that is too much for others, the Box adapter falls back to one-time OAuth consent on the desktop, which the user should decide counts as setup, not login.
2. **Coarse Box scopes**: Box has no app-folder scope; the PWA/iOS app gets `root_readwrite` on the whole account. Mitigation: `root_readonly` + a separate upload token for the inbox is not possible per folder, so state it in the UI and keep the client small and auditable (CSP, no third-party script, relay §7.3 rendering rules).
3. **Key loss = re-pair everything** (relay D3): one key hierarchy per user, rotation on revoke as in relay §4.9; keep that logic.
4. **Freeze/rollback**: a stolen Box session reads ciphertext only but can delete or freeze files; the signed manifest's `validUntil` makes a freeze visible, not preventable (relay T3). Show staleness.
5. **Phone background limits**: iOS will not long-poll in the background; queued requests run when the desktop is on and the phone app reopens. Push needs a server again; defer.
6. **GitLab CORS / token custody in a PWA**: verify CORS; if a proxy is needed it must forward the user's token and store nothing. A PAT in browser storage is the weakest link; prefer GitLab OAuth with short-lived tokens.
7. **ADR churn**: mark ADR 0019's identity parts superseded or two half-designs will coexist.

## Sources

- Box Individual 10 GB / 250 MB upload: https://web.mktg.box.com/en-gb/pricing , https://costbench.com/software/document-management/box/free-plan/
- Box API rate limits (1000 req/min/user, 240 uploads/min/user): https://developer.box.com/guides/api-calls/permissions-and-errors/rate-limits/
- Box OAuth scopes (`root_readwrite`, `root_readonly`): https://developer.box.com/guides/api-calls/permissions-and-errors/scopes/
- Box user-event long polling: https://developer.box.com/guides/events/user-events/polling/
- Box Client Credentials Grant and admin/developer-account authorisation: https://developer.box.com/guides/authentication/client-credentials/ , https://developer.box.com/guides/authentication/client-credentials/client-credentials-setup/
- GitLab.com rate limits (Free 5,000/h, 100/min burst, 60/h anonymous): https://docs.gitlab.com/user/gitlab_com/rate_limits/
- GitLab Free 10 GiB per project; repository files raw API: https://docs.gitlab.com/user/storage_usage_quotas , https://docs.gitlab.com/api/repository_files
- CloudKit private DB counts against the user's iCloud quota: https://developer.apple.com/documentation/cloudkit/ckdatabase/scope/private.md , https://developer.apple.com/documentation/cloudkit/ckerror/quotaexceeded.md ; pricing unclear: https://developer.apple.com/forums/thread/715649
- CloudKit Web Services sign-in (archived): https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html
- Advanced Data Protection disables iCloud web access by default: https://support.apple.com/108756 , https://support.apple.com/102651
- Dropbox Basic 2 GB (forum; confirm on dropbox.com/plans): https://www.dropboxforum.com/t5/Storage-Space/User-with-shared-edit-access-unable-to-upload-due-to-error/td-p/754606
- Google Drive appDataFolder: https://developers.google.com/drive/appdata
- Turso free plan: https://turso.tech/pricing
- PowerSync free tier (third-party figures): https://powersync.com/pricing , https://toolradar.com/tools/powersync/pricing
- Supabase free tier pause (third-party; confirm on supabase.com/pricing): https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/
- Cloudflare Workers Free limits: https://developers.cloudflare.com/workers/platform/limits/ ; Durable Objects free plan: https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/
- Syncthing untrusted devices (beta): https://docs.syncthing.net/users/untrusted.html
- Obsidian Sync $4/$8 per month: https://obsidian.md/blog/standard-plan/
- Standard Notes: https://toolradar.com/tools/standard-notes/pricing ; Anytype any-sync: https://www.github.com/anyproto/any-sync-dockercompose
- Bear is CloudKit and Apple-only: https://community.bear.app/t/when-can-bear-go-windows-and-android/13842
- Signal linked devices: https://signal.org/blog/a-synchronized-start-for-linked-devices/ , https://support.signal.org/hc/articles/360007320451
- 1Password Secret Key: https://1password.community/discussion/comment/407776/
