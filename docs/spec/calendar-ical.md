---
title: iCal feed connector (Google Calendar secret address) — spec
status: draft
---

This page records the iCal feed connector as built on 2026-10-31 (API 104, migration 0060). It reads a calendar through its **iCal feed URL**, read-only, with **no OAuth and no Google Cloud project**. For Google Calendar the user pastes the calendar's "Secret address in iCal format". Everything cites code. What was never run against a real Google calendar is listed in section 12 and is **unverified**.

The feed URL is a **bearer secret**: anyone who holds it can read the whole calendar until the user resets it in Google Calendar. It is therefore write-only in this system (section 5).

---

## 1 Files

| Role | Path |
|---|---|
| ICS parser, time zones, RRULE expansion (bounded) | `extension/connectors/ical/ics-parse.mjs` |
| The only outbound path: URL validation, host allowlist, pinned fetch, redirects, caps, conditional GET, backoff, secret redaction | `extension/connectors/ical/ical-fetch.mjs` |
| Notes, sync pass, tombstones, options | `extension/connectors/ical/ical.mjs` |
| State | `extension/kb/ical-store.mjs`, `extension/kb/google-store.mjs` (`getSyncState`, `patchSyncState` with connector `ical`), `extension/kb/migrations/0060_ical_sources.sql` |
| Vault key | `extension/server/vault.mjs` (`ical.src.<12 hex>.url`) |
| Routes | `extension/routes/calendar-ical.mjs`, dispatched from `extension/routes/router.mjs`, always on |
| Contract | `schema/http/calendar-ical.schema.json`, fixtures `schema/http/fixtures/calendar-ical/` |
| Tests | `extension/tests/ical-parse.test.mjs`, `ical-fetch.test.mjs`, `ical-routes.test.mjs`; recorded inputs `extension/tests/fixtures/ical/` (`google-style.ics`, `outlook-style.ics`, `hostile-rrule.ics`, `nested.ics`; binary, NUL, bidi, 10 MB and deeply folded inputs are generated inside the tests) |

## 2 Routes

All routes are token-protected and per user; another user's source id is 404 `ICAL_NOT_FOUND`. Errors use the `{ error: { code, message } }` envelope. Rate-limit buckets: `sync` is `dispatch` (it reaches the feed host), every other route `kbWrite`.

| Route | Request | 200 response |
|---|---|---|
| `POST /kb/calendar-ical/sources` | `{ name, url }` (name 1 to 100 characters after control and bidi stripping; url see section 3) | `{ sourceId, name, nameOnly: true, calendarIdPrefix, host }`. The URL is never returned. |
| `GET /kb/calendar-ical/sources` | none | `{ sources: [{ sourceId, name, calendarIdPrefix, host, status, lastRunAt, lastError, options }] }`, `status` is `idle`, `error` or `revoked`, `options` is `{ daysBack, daysAhead }` |
| `DELETE /kb/calendar-ical/sources/:id` | none | `{ ok, purgedSources }`; deletes the vault row, the source and its sync state, and every cached note row of the feed |
| `POST /kb/calendar-ical/sync` | `{ sourceId }` | `{ sourceId, status: ok or unchanged or not_modified, events, instances, cancelled, removed, truncated, warnings[] }` |
| `POST /kb/calendar-ical/options` | `{ sourceId, options: { daysBack, daysAhead } }` | `{ ok, options }` (clamped: `daysBack` 0 to 365, default 30; `daysAhead` 0 to 730, default 90); a changed window drops the cursor so the next sync is a full pass |

Limits: at most **10 feeds per user** (409 `ICAL_TOO_MANY_SOURCES`), the same address twice is 409 `ICAL_DUPLICATE` (compared through the vault, no hash of the URL is stored), one sync per feed at a time (409 `ICAL_SYNC_RUNNING`), request bodies 16 KiB.

**Error codes**

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_FAILED` | 400 | body not an object, name or url not strings, name empty, `sourceId` malformed, options not an object |
| `ICAL_URL_INVALID` | 400 | not a URL, not https, userinfo, port other than 443, fragment, control characters, longer than 2 048, not the Google secret-address shape; at sync, no stored address |
| `ICAL_HOST_NOT_ALLOWED` | 400 | host not on the allowlist (including lookalikes, subdomains, IP literals), a redirect to another host, an address that resolves to a refused (private) address |
| `ICAL_NOT_FOUND` | 404 | unknown source id, or another user's |
| `ICAL_DUPLICATE`, `ICAL_TOO_MANY_SOURCES` | 409 | see above |
| `ICAL_SYNC_RUNNING` | 409 | a sync of this feed is in flight |
| `ICAL_FEED_REVOKED` | 409 | the host answered 404 or 410: the secret address was reset or the calendar removed. The source status becomes `revoked`; what was indexed is kept; the user adds the new address |
| `ICAL_RATE_LIMITED` | 429 | the host answered 429 four times |
| `ICAL_FETCH_FAILED` | 502 | network error, timeout (20 s), too many redirects, 5xx four times, any other non-2xx |
| `ICAL_TOO_LARGE` | 502 | the body is over 5 MiB (`content-length` or streamed) |
| `ICAL_PARSE_FAILED` | 502 | the body is not an iCalendar document (an HTML sign-in page, binary data) |
| `INTERNAL` | 500 | anything else, message fixed |

A failed run sets the source `error` with the code in `lastError` and leaves the index untouched.

**Command bus**: adding, deleting and changing options are desktop decisions. A phone or extension "sync now" is a T1 enqueue of the bus kind `sources.update` ([command bus](command-bus.md)); that kind has no handler for this connector yet (section 12).

## 3 Fetch (the only outbound path)

`validateIcalUrl` then `fetchIcal` in `ical-fetch.mjs`.

- **Scheme and shape**: https only (`webcal://` is accepted and read as https), port 443 only, no userinfo, no fragment, at most 2 048 characters, no control characters or spaces. On `calendar.google.com` the path must be `/calendar/ical/<calendar id>/(private-<token> or private or public)/basic.ics`.
- **Host allowlist**: exactly `calendar.google.com`, plus exact valid hostnames named in the operator environment variable `LLMIDE_ICAL_HOSTS` (comma list). No wildcard, no IP literal, no `localhost`; an invalid entry is ignored. A lookalike (`calendar.google.com.evil.com`, `evilcalendar.google.com`, `a.calendar.google.com`) is `ICAL_HOST_NOT_ALLOWED`.
- **Pinned fetch** (`server/pinned-fetch.mjs`): DNS resolved once, every address classified, the checked address dialled, no private-address opt-in. A refused address is `ICAL_HOST_NOT_ALLOWED`.
- **Redirects** by hand, at most **2 hops**, only to the **same host**, each hop re-validated (https, 443, no userinfo). Nothing is sent that a redirect could leak: the request carries no credentials, no cookies, no `Authorization`.
- **Caps**: body 5 MiB read as a stream and cancelled when the cap is crossed (not only `content-length`); 20 s deadline for the whole request including the body.
- **Conditional GET**: `If-None-Match` and `If-Modified-Since` from the stored validators (only printable ASCII up to 300 characters is ever sent); a 304 is `not_modified`. Validators are only reused while the window and the day are unchanged.
- **Backoff**: 429 and 5xx retried up to 3 times with `Retry-After` (capped at 120 s) or `min(1000 * 2^attempt, 16000)` ms plus up to 250 ms jitter.
- **Tests**: `_setIcalFetchForTests`, `_setIcalSleepForTests` (`NODE_ENV=test` only). With no fixture transport a call throws `ICAL_TEST_TRIPWIRE`; the test helper's tripwire also fails any direct `fetch`, `http` or `https` call to a Google host.

## 4 Parser (`ics-parse.mjs`)

In-repo, no dependency. Bounds (`ICS_LIMITS`): input 6 000 000 characters (over: `ICAL_TOO_LARGE`), 400 000 lines, 16 384 characters per unfolded line (longer: the property is dropped, warning `oversized_property`), 16 parameters of 256 characters, component depth 6, **5 000 events**, **500 instances per event**, **5 000 instances per sync**, 100 attendees (the total is kept), 1 000 EXDATE and 500 RDATE values, 20 BYDAY and 10 BYSETPOS entries, 1 000 000 iterations and an 8 s deadline for all expansion together, 100 000 periods per rule.

- **Document check**: `BEGIN:VCALENDAR` must appear in the first 4 KiB (after BOM and NUL removal), else `ICAL_PARSE_FAILED`. Control characters (NUL included) are removed from every line, a malformed line is skipped (`malformed_line`).
- **Structure**: line unfolding, property parameters with quoted values, TEXT unescape (`\n \N \, \; \\`). A `VEVENT` counts only directly inside a top-level `VCALENDAR`; a nested `VCALENDAR` or `VEVENT` is ignored (`nested_vcalendar`). Only the first of each single-valued property is read.
- **Text**: all text values lose control, format (bidi, zero width), line and paragraph separator characters. Summary 300, location 300, description 100 000 characters.
- **Times**: UTC (`Z`), floating, `TZID` as an IANA zone through `Intl.DateTimeFormat` (also `/mozilla.org/.../Area/City` prefixes and a table of 21 common Windows zone names), all-day (`VALUE=DATE`), `DTEND`, `DURATION`. An unknown `TZID` is read as floating (UTC) and flagged `tz_unknown` plus `floating`. Recurrence runs in wall-clock time and converts each instance, so a 09:00 local event stays 09:00 across a DST change.
- **Overrides and exceptions**: `RECURRENCE-ID` replaces the matching occurrence; the instance keeps the **original** occurrence as its identity, so a moved occurrence replaces the old note. `EXDATE` removes occurrences. `STATUS:CANCELLED` on a master removes every instance of the UID, on an override or single event removes that instance, by exact reference. `RANGE=THISANDFUTURE` is ignored (`recurrence_range_ignored`).
- **RRULE**: `FREQ` DAILY, WEEKLY, MONTHLY, YEARLY; `INTERVAL` 1 to 9 999, `COUNT` (counted from `DTSTART`, before EXDATE), `UNTIL` (date or date-time), `BYDAY` with ordinals, `BYMONTHDAY` with negatives, `BYMONTH`, `BYSETPOS`, `WKST`. Occurrences are produced only for the sync window (with a skip-ahead when there is no `COUNT`). **Not expanded**: `FREQ` below DAILY (`rrule_subdaily`), `BYWEEKNO`, `BYYEARDAY`, `BYHOUR`, `BYMINUTE`, `BYSECOND` (`rrule_unsupported`), an unparsable rule (`rrule_invalid`): the event keeps only its first instance. `FREQ=SECONDLY;COUNT=999999999` therefore costs one parse; a daily rule since 1990 with a huge `COUNT` costs about 13 000 periods and is capped at 500 instances.
- **Never fetched**: `URL` and `ATTACH` values are text (at most 5 `ATTACH`, 300 characters).

## 5 The URL is a secret

- Stored only in the per-user vault under `ical.src.<sourceId>.url` (AES-GCM with the user's AAD like every vault row). `sourceId` is 12 random hex characters, **not** derived from the URL. `ical_sources` holds the label, a short calendar id prefix (the first 8 printable characters of the Google calendar id, a hint, never the token) and the host.
- The key pattern is accepted by `setSecret` and `getSecret` but **not** by `isUserSettableVaultKey`: `POST /auth/me/secrets` refuses it and `VAULT_KEYS` does not list it.
- The only request that carries it is `POST /kb/calendar-ical/sources`. It is in no response, no audit row (`connector.ical.add`, `connector.sync`, `connector.ical.delete` carry host, counts and status), no log line, no error text (every `IcalError` message and every route error passes `redactIcalSecrets`, which replaces feed URLs and `private-<token>` segments), no note (the same redaction runs over the note text) and no fixture (the tests use a fake token). A test scans the responses, the audit table, every table that could hold it and the captured process output.
- Deleting a feed deletes the vault row; deleting the user deletes `user_secrets`, `ical_sources` and the sync state (`deleteUserCascade`).

## 6 State

`ical_sources(user_id, source_id, name, id_prefix, host, created_at)`, primary key (user, source). `connector_sync_state` (migration 0059) is rebuilt by migration 0060 with its `connector_id` check widened to `gmail, gcal, gdrive, ical`; for `ical` the `account_id` column is the source id. The `cursor` is JSON `{ etag, lastModified, hash, windowKey, complete }` (the validators, the SHA-256 of the last body, `<UTC day>|daysBack|daysAhead`, whether the last pass finished); `options` is `{ daysBack, daysAhead }`; `status` is `idle`, `error` or `revoked`; `last_error` is a stable code. None of it holds the URL.

## 7 Notes (Pattern A)

One note group per event **instance** inside the window, `sources` rows `kind: doc`, ref `ical:<sourceId>:<enc uid>:<instance key>`, the instance key being the date for an all-day event or the UTC start compact (`20251124T010000Z`) of the original occurrence. The shape follows the Google Calendar notes ([google-connectors](google-connectors.md) section 9): title, `When`, `Where`, `Status` when not confirmed, `Organizer`, `Attendees` (names and addresses kept, at most 100 plus "N more", the address is the point of a meeting note), `Links (text only, never opened by LLM-IDE)`, `Description` (HTML converted with the shared tokenizer, plain text escaped), chunked with `chunkLines`. Meta: `source: ical`, `untrusted: true`, `sourceId`, `sourceName`, `uid`, `instance`, `start`, `end`, `allDay`, `status`, `location`, `attendees`, `recurring`, `override`, `flags`, `link`. Every text field goes through `redactSecretsForStorage` (and the feed-URL redaction) before it is stored. The content is untrusted data: an agent grounding on it treats it as data.

## 8 Sync pass

1. Fetch (section 3) with the validators; 404 or 410 is `revoked`; 304 is `not_modified`.
2. A body whose hash equals the last complete pass for the same window is `unchanged` (nothing is rewritten).
3. Parse and expand inside `[now - daysBack, now + daysAhead]`.
4. In one transaction: delete tombstones (exact ref for an instance, by `ical:<source>:<enc uid>:` prefix for a cancelled master), delete then re-insert every instance ref, in batches of 1 000 rows.
5. **Only if the pass was complete** (`truncated: false`): delete rows of this feed written before the pass started (feed removals, instances that left the recurrence). A truncated pass sweeps nothing, so a cap can never empty the index.

`events` counts VEVENT components read, `instances` instances written, `cancelled` tombstones applied, `removed` rows swept.

## 9 Tiers and isolation

Every row, vault key and sync state carries the user; the user comes from the bearer token. Isolation is tested (sources list, sync, options, delete across users, the vault read, the cached rows).

## 10 Tests

`ical-parse.test.mjs` (17): Google and Outlook style feeds, DST, RRULE variants and COUNT, skip-ahead, hostile rules with a time bound and a tiny budget, folding, nested components, binary and oversized input, NUL, bidi, caps. `ical-fetch.test.mjs` (9): URL shapes and lookalikes, operator hosts, redaction, conditional GET, 404, 429 and 5xx backoff, redirect rules, size caps, error leakage. `ical-routes.test.mjs` (12): validation, vault-only secret, generic secrets refusal, ten-feed cap, sync, unchanged, 304, tombstones, sweep, health, isolation, every error code, hostile feeds, options, concurrency, delete, secret scan. Contract fixtures are produced by the route test with `ICAL_DUMP_FIXTURES`.

## 11 Security summary

Host allowlist and pinned fetch; same-host redirects only; streamed caps and a deadline; a parser bounded in memory and CPU; no content is ever fetched; bidi, control characters and HTML neutralised before they reach a note; the secret URL vault-only and redacted everywhere; per-user isolation; fixtures only in tests with a tripwire.

## 12 Unverified, not built

| Item | State |
|---|---|
| A real Google "Secret address in iCal format" feed | Never fetched. The path shape `/calendar/ical/<id>/private-<token>/basic.ics`, whether Google sends `ETag` or `Last-Modified`, how it answers after the address is reset (404 is assumed), and the feed's refresh delay are from public documentation and **unverified** |
| Behaviour of other hosts (Outlook.com, iCloud, Fastmail) | Only reachable through `LLMIDE_ICAL_HOSTS`; not tested against real hosts |
| `BYWEEKNO`, `BYYEARDAY`, `BYHOUR`, sub-daily rules, `RDATE;VALUE=PERIOD`, `THISANDFUTURE`, `VTIMEZONE` rules (zones come from the IANA database, not the feed) | Not expanded; flagged |
| Windows zone names beyond the 21 in the table | Read as floating and flagged `tz_unknown` |
| Scheduled and phone-enqueued sync (`sources.update` bus handler) | Not built |
| A Mac screen on these routes | The Tauri calendar card now uses the multi-feed routes of section 2 (`ui/screens/library/sources/google/`, built against fixtures only, not a real calendar); the Mac app has no screen for them yet |
| Catalog `pipelineReady` for this source | Not wired |
| Activity feed | Uses `knowledge_updated` |

## Regeneration checklist

- [ ] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [ ] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [ ] Spot-check: one representative piece rebuilt from this page alone matches source.
- [ ] Structured facts link to their extractor-generated reference page (no hand-copied drift).
