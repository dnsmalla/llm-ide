# Status audit, 2026-10-31

Read-only investigation at `main`. Purpose: replace unverified MASTER-PLAN lines with evidence. Nothing was built or run (a gate was running concurrently, so no `swift` or `npm test`); counts say how they were taken (`grep -c`, `rev-list`, `ls`). "Not verified" is stated where a claim needs a run or a person.

## (a) Mac Sparkle `CFBundleVersion` limitation

**State: fixed in code, with one remaining ordering risk and no verification of a real update.**

- Cause (project note, 2026-10): `CFBundleVersion` was a constant, so Sparkle could not order builds.
- Fix, commits `b244199f` (2026-10-10 "publish a real CFBundleVersion so Sparkle can compare builds") and `c04da0b4` ("give release builds a real build number"): `mac/Scripts/build.sh` lines 44-59 set `CFBundleVersion` to `LLMIDE_BUILD_NUMBER` (positive integer, validated), else `git rev-list --count HEAD`, else 1 (with a warning, and a red warning when `CI` is set and the count is 1, the shallow-clone case). It is written into the generated Info.plist at line 186. `mac/Scripts/appcast.sh` lines 45-51 reads `CFBundleVersion` back from the built `.app` and writes it as `<sparkle:version>` (line 88), refusing to run when it cannot read it, so the two cannot drift. `.github/workflows/mac-release.yml` sets `LLMIDE_BUILD_NUMBER: github.run_number` (line 53) and checks out with `fetch-depth: 0` (line 68). The troubleshooting row in `docs/how-to/release-with-auto-update.md` (line 175) documents it.
- **Remaining risk (not in the project note):** two sources feed one comparison key. A local release uses the commit count (3 481 at this audit, `git rev-list --count HEAD`); CI uses `github.run_number`, which starts near 1 per workflow. If any release was ever cut locally, or the first CI run is below the last shipped number, Sparkle will see CI builds as **older** and never offer them. Whether a release has shipped, and with which number, was not checked (no appcast or release artifact is in the repo).
- Not verified: an actual Sparkle update from one signed build to the next on a real Mac; no test covers the build-number logic (no test file for `build.sh` or `appcast.sh` under `mac/Tests/LlmIdeMacTests`, by `ls | grep`).
- Recommendation: use one source for both paths (for example CI-only releases, or `run_number` offset above the highest shipped number, or a monotonic counter file in the repo) and add a script test. **Decision for you:** release only through CI, or define the single number source.
- MASTER-PLAN line: `[~]` (fixed in code; ordering risk and a real update test open).

## (b) Connector catalog phase 1

**State: phase 1 is shipped; the "gdrive/gcal via MCP" part is not, and the Miro MCP tool names are unverified guesses.**

Evidence found:

- Server catalog: `extension/connectors/connector-catalog.mjs` (frozen list: gdrive, gcal, miro, box, slack). Per-user selection: `extension/connectors/connector-state.mjs` (`{ [userId]: { selected: [] } }`, first read pre-selects box and slack). Routes in `extension/server/auth-routes.mjs`: `GET /auth/me/connectors`, `GET /auth/me/connectors/catalog`, `POST /auth/me/connectors/add`, `DELETE /auth/me/connectors/<id>`.
- Mac: `Features/Library/Views/ConnectorAddSheet.swift`, `ConnectorDetailView.swift`, `ConnectorRow.swift`, and selection-gated Settings in `Features/Library/Views/Settings/ConnectionsSettingsSection.swift` (`ConnectionsSelection.visibleCardIds(selected:)`: cards appear only while selected; non-selectable ones always shown). Client `Core/Networking/API/LlmIdeAPIClient+Connectors.swift`. Contract rows for `/auth/me/connectors` and `/auth/me/connectors/catalog` are in `mac/Sources/APIContractLab/Routes.swift`.
- MCP-backed ingest: `extension/connectors/mcp-client.mjs`, `mcp-connector-defs.mjs`, routes `POST /kb/mcp-connector/{test,fetch,seen,classify}` and the OAuth `/auth/mcp-connector/*`. **Only Miro has a descriptor** (`MCP_CONNECTOR_DEFS` contains one entry). The gdrive and gcal descriptors exist only as a commented example (lines 14-27); in the catalog both have `pipelineReady: false` and the header says they "flip in phase 3".
- The Miro `listTool`, `readTool` and argument names are marked "UNVERIFIED... educated guess" (`mcp-connector-defs.mjs` lines 50-75): they need a real connected run through `POST /kb/mcp-connector/test`.
- Tests (by `ls`, counts are test-case greps): `extension/tests/connector-catalog.test.mjs` (4), `connector-state.test.mjs` (5), `connector-routes.test.mjs` (2), `mcp-connector-defs.test.mjs` (14), `mcp-connector-oauth-routes.test.mjs` (8), `kb-router-mcp-connector.test.mjs`, `mcp-connector-seen.test.mjs`; Mac `ConnectorCatalogDecodingTests`, `McpConnectorAdapterTests`, `McpConnectorDecodingTests`. None was run in this audit.
- Not found: a connector-catalog spec file under `docs/spec` or `docs/superpowers/plans` (the notes refer to a "connector-catalog spec"; `ls | grep -i connector` returned nothing). The "phase 3" scope is therefore documented only in code comments.

Conclusion: catalog, per-user selection, Library section, selection-gated Settings and the Miro MCP path **exist with tests**; the Google pair is **not** done and the Miro tool mapping is unconfirmed.

- MASTER-PLAN line: `[~]` split honestly: phase 1 and Miro MCP done, gdrive/gcal and real Miro verification open.

## (c) Phase 1 P12 Swift decode check: skipped routes

Source: `mac/Sources/APIContractLab/Routes.swift` (288 lines), `main.swift` (143 lines), run by `make` target at `Makefile:209` (`swift run api-contract-lab`), part of `make regression` per the plan row P12. Counted by grep of the file: **93 routed** endpoints (decoded with the Mac's `Codable` models, key drops checked) and **128 skipped** endpoints (2xx fixtures not decoded). `main.swift` fails the lab when a 2xx fixture is neither routed nor skipped, and when an endpoint is both, so the list cannot rot silently. `schema/http/swift-decode-allowlist.json` holds 2 per-key allowances (unused response fields, with reasons).

Skip reasons (counted by phrase; they overlap slightly, so the sum is approximate):

| Reason | Count | Notes |
|---|---|---|
| "no Mac caller (see schema/http/INVENTORY.md)" and similar | 70 | Extension-facing or removed routes; nothing on the Mac to decode (includes `POST /code-assist*`, removed in API 92) |
| Mac calls it but decodes into a private wrapper, ack or tuple | 51 | The decode is real but lives in a private type; the lab cannot name it. Closing these means mirroring the wrappers as lab types (as the 14 `...Wrap` mirrors at the end of the file do) or making them internal |
| Streams, OAuth browser callbacks, NDJSON export, non-Decodable result | 7 | Not one JSON body: `POST /agent/v2/stream`, `GET /kb/os/stream`, three callbacks, `GET /kb/export-all`, `POST /kb/loop/agent-run` |

Consequences: the Swift decode check covers **93 of 221 fixture endpoints (42 percent)**, but the 70 with no Mac caller are not a gap in the Mac's behaviour; the real open set is the **51 routes the Mac calls whose decode is private** (about 23 percent of the total), including chat lifecycle (`archive/begin|commit`, sessions list), activity, usage, issue-schedule, secrets, prefs and the doc generator. The extensions catalog routes were skipped on 2026-10-31 (`077abf89`) and routed the same day once the client landed (`66bef1b9`), so the docs-kit/extension skips noted in MASTER-PLAN are closed for extensions; docs-kit routes (`/kb/docs/*`) are routed.

- MASTER-PLAN line: `[~]`, but rewrite the evidence: lab exists and gates; 93 routed, 128 skipped (70 no Mac caller, 51 private wrapper, 7 non-JSON); the old "docs-kit K1 routes skipped" text is stale. Not run in this audit.

## (d) "Swift feature freeze from Phase 1" (Tauri plan decision 4)

**Not in force, and not yet triggered.**

- Source: Tauri plan section 10, decision 4 "Feature freeze on the Swift app from Phase 1 onward"; risk table "Freeze Swift features at Phase 1". "Phase 1" there is the **Tauri plan's phase 1**, which starts only after Phase 0 passes and ADR 0018 is Accepted. ADR 0018 is still `status: proposed`, and the Phase 0 report lists closing items (user bench, one Windows run) as open. So the freeze has no start event yet. It is **not** the same thing as "Phase 1 core contract" (P1 to P16), which is a different phase 1 and finished its schema work.
- Evidence the Mac keeps growing: since 2026-10-24 (ADR date), `git log --since=2026-10-24 -- mac/Sources` shows **50 commits with a `feat` subject** (of 146 total commits touching `mac/Sources`), for example the Extensions catalog screen (`961e9462`, 2026-10-31), one Providers list and Model routing in Settings (`b56d80c3`), per-chat route control (`45f84119`), the live-then-archive chat archive service (`f781d8cc`). All of it is user-approved kit work (K1 phases), consistent with the kit-by-kit plan, which keeps building native screens until each kit's K3.
- A different freeze **is recommended and unanswered**: sync-kit question S2 (freeze new phone surfaces; fix bugs only).
- **Decision for you:** when does the Swift freeze start, and what does it cover? Options: (1) start at ADR 0018 Accepted (the plan's meaning); (2) per kit, when its Tauri K3 screen ships (the kit-by-kit meaning); (3) only the phone bridges now (S2). Until you decide, record the line as "not in force; trigger undefined".
- MASTER-PLAN line: leave `[ ]` with the corrected text (not in force; blocked on ADR 0018 Accepted; S2 open).

## (e) Outbound-request pinning coverage (evidence for the independent review)

Method: `grep -rnE "\bfetch\(|https?\.request\(|https?\.get\(|new WebSocket|net\.connect|tls\.connect"` over `extension/` excluding `node_modules`, `dist`, tests, plus a search for HTTP-capable libraries (ImapFlow, MCP transports, `npm`, `git`). Pinned means the call goes through `server/pinned-fetch.mjs` (`makePinnedFetch`, DNS resolved once by the socket, every address classified, redirects refused, private targets need two opt-ins) or its tracker wrapper `server/tracker-fetch.mjs`. Only two modules import `node:http(s)` for requests: `pinned-fetch.mjs` and `server.mjs` (the listener).

**Pinned (through `makePinnedFetch` or `makeTrackerFetch`):** `providers/web-client.mjs` (the redirect-following URL fetch tool, each hop pinned), provider-catalog chat, model lists and connection tests (`providers/providers.mjs`, `provider-models.mjs`, `adapter-complete.mjs`, `runtime.mjs` adapter path), `providers/adapter/mcp-client.mjs` (HTTP and SSE transports, with a response-size cap), `llm_agent/adapter/mcp-mount.mjs`, extension install, update and indexes (`llm_agent/extensions/install.mjs`, `update.mjs`, `indexes.mjs`), tracker hosts (`connectors/issues.mjs`, `agents/dispatcher.mjs`, `agents/outcome-providers.mjs`). `server.mjs` imports the pinned module for its own uses.

**Not pinned (plain global `fetch` or a library socket), with justification and risk:**

| # | Call site | Target | Why unpinned / current guard | Residual risk |
|---|---|---|---|---|
| 1 | `providers/runtime.mjs:429`, `:713` | `https://api.anthropic.com/v1/messages` (literal) | Fixed first-party host | None for SSRF (literal host, no user URL); no pin means a poisoned resolver could redirect to a private address, low |
| 2 | `providers/web-client.mjs:53` | `https://api.anthropic.com/v1/messages` (literal) | Same | Same |
| 3 | `providers/web-client.mjs:196` | `https://serpapi.com/search` (literal, `api_key` in the query string) | Optional fallback, fixed host | Key in URL can reach logs of any proxy; not SSRF |
| 4 (**closed 2026-10-31**, pinned, host allowlist, manual redirects, token dropped cross-origin, size caps) | `connectors/box.mjs:26` (content fetch, `redirect` default follows), `:112` (token) | `api.box.com` and URLs returned by the Box API | Fixed token host; content URLs come from Box's response | **Medium:** follows redirects and fetches API-returned URLs with a bearer token and no private-address check; add the pinned fetch with same-host redirect rule (as `tracker-fetch` does) |
| 5 | `connectors/google-oauth.mjs:34`, `:64` | `oauth2.googleapis.com`, `openidconnect.googleapis.com` (literals) | Fixed hosts | Low |
| 6 | `connectors/slack-oauth.mjs:25` | `slack.com/api/oauth.v2.access` (literal) | Fixed host | Low |
| 7 | `connectors/slack-source.mjs:99` | `slack.com/api/<method>` (literal base) | Fixed host; method names internal | Low; file download URLs, if added later, must be pinned |
| 8 | `agents/slack.mjs:60` | user-supplied webhook URL | `isWebhookUrl` allows only `https://hooks.slack.com` (exact hostname) | Low (host allowlist, but no redirect refusal visible in the grep; verify) |
| 9 | `agents/github-pr.mjs:249` | `https://api.github.com/repos/<repo>/pulls` (literal host) | Fixed host; `<repo>` path-escaped by the caller (not re-verified) | Low; the tracker pinning work (X7) did not cover this module |
| 10 | `providers/jev.mjs:227` | `JEV_AI_BASE_URL` (operator env) | Base URL checked at config time (`jevBaseUrl`, SSRF check) and `redirect: 'error'` | **Low-medium:** the check is of the name, not the connection (DNS rebinding is not closed as in `pinned-fetch`); operator-controlled |
| 11 (**closed 2026-10-31**, `pinnedFetchFor(def)` on every transport) | `connectors/mcp-client.mjs:261`, `:507`, `:536` (`StreamableHTTPClientTransport`, SDK default fetch) | catalog `serverUrl` (today only `https://mcp.miro.com`), then **every URL the OAuth discovery returns** (authorization server metadata, token and registration endpoints) | Server URL is a frozen catalog literal | **Medium:** the SDK follows server-advertised OAuth endpoints with the default fetch and no pin or private-address check; a compromised or malicious MCP server could point discovery at an internal address. Pass a `fetch` built from the pinned module (the user-added MCP adapter in `providers/adapter/mcp-client.mjs` already does) |
| 12 | `connectors/email-source.mjs:174` (ImapFlow) | user-supplied IMAP host | Own guard: `resolveSafeHost` resolves, classifies and connects to the checked IP with TLS servername | Low: equivalent in intent (not the shared module; keep the two classifiers in sync, `ip-classifier.mjs`) |
| 13 | `llm_agent/sdk/updater.mjs:55` | npm registry URL (constant) and `npm install` subprocess | Constant host; subprocess installs exact version | Low-medium (supply chain, not SSRF): `npm install` runs scripts of the new SDK package; already guarded by a smoke test and version equality |
| 14 | Subprocess egress: `claude` CLI and Agent SDK, `git`, `gh`, MCP stdio servers, `run-bash` tool | arbitrary | By design, outside the Node fetch layer | Not coverable by the pinned fetch; governed by tool permissions and the extension catalog consent model, which is where the review should look |
| 15 | `extension/src/lib/config.ts`, `src/sidepanel/App.tsx` (browser `fetch`) | the loopback core (`127.0.0.1:3456`) | Client-side calls to the local server, not server egress | Not applicable; CORS allowlist covers it |

Findings for the independent review: (1) three calls are exposed to redirect and private-address surprises because the target is **data-dependent**: item 4 (Box content URLs), item 11 (MCP OAuth discovery) and, weakly, item 10 (Jev). Those should move behind the pinned fetch before the "provider and connector fetch pinning" line can be marked done. (2) Items 1 to 3, 5 to 7, 9 are literal hosts; pinning them is consistency, not a vulnerability; a lint rule "no bare `fetch(` in `extension/` outside an allowlist file" would keep the rule honest. (3) ROADMAP X7 "Done" is accurate for tracker hosts only. (4) The future relay client (desktop to relay) must use the pinned fetch with the relay host as the only allowed target and redirects refused.

- (Update 2026-10-31: Box and MCP connector OAuth discovery are now pinned, see the closed rows 4 and 11.) MASTER-PLAN line (S/Security "Provider and connector fetch pinning"): stays `[~]`; as originally recorded: pinned for providers, adapter MCP, extension install and trackers; **not** for Box (data-dependent URLs), the MCP connector OAuth discovery, Jev's connection-level check and 7 literal-host calls.

## Dependency bumps (2026-10-31)

One concern per commit; full extension suite green after the zod bump (4362 pass, 0 fail, 4 skipped).

| Package | From | To | Why |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.32.2 (exact) | OAuth credential redirection to a server-chosen auth server (1.31); cross-origin redirect header/body re-send (1.32). Our `VaultOAuthProvider` was already issuer-scoped, so no code change; new test `tests/mcp-adapter-redirect.test.mjs` pins that the adapter transport refuses a redirect and never contacts the target |
| `zod` | 4.4.3 | 4.6.7 (exact) | GHSA-mrhx-c7xc-m3w5; `npm ls zod` shows one deduped copy, no `overrides` |
| `ai` / `@ai-sdk/openai-compatible` | 6.0.317 / 2.0.87 | 6.0.320 / 2.0.88 (exact) | Patch level; adapter fence and tests green. Agent SDK deliberately not bumped (bench-gated) |
| Rust `time` (+ `time-core`, `time-macros`, `num-conv`) | 0.3.45 | 0.3.47 | Needs Rust 1.88, so `rust-version` in `desktop/src-tauri/Cargo.toml` and the README moved 1.84 to 1.88 (CI installs stable). `serde_with` 3.17.0 and `quick-xml` have no newer MSRV-compatible release; untouched |

`npm audit` delta: extension 25 (14 moderate, 10 high, 1 critical) to 23 (14 moderate, 8 high, 1 critical); desktop 0 to 0.

Left (upstream-only chains, nothing applied): vite advisories, nodemailer, socks, nanoid chains. Option if wanted later: npm `overrides` in `extension/package.json` for the transitive copies, each gated by the full suite.

Closed since: item 11 (the connector OAuth transports now use the pinned fetch). Originally: the connector OAuth transports (`connectors/mcp-client.mjs`) used the SDK default fetch, not the pinned fetch. SDK 1.32 now refuses cross-origin redirects there by default (same-origin only), but private-address checks on discovered endpoints are still not applied.

## Decisions for you

1. Sparkle: single build-number source for local and CI releases (a).
2. Swift freeze: define the trigger and scope (d); relates to sync-kit S2.
3. Whether to write the missing connector-catalog spec and schedule phase 3 (gdrive, gcal descriptors) and a real Miro verification run (b).
4. Whether the 51 private-wrapper skips in the decode lab are worth closing before the Mac switches more routes (c).
5. Pinning: approve moving Box and the MCP connector OAuth discovery behind the pinned fetch (e).
