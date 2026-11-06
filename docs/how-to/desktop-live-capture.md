# Desktop live caption capture

## What it reads

Caption text from Zoom (`us.zoom.xos`) and new Teams (`com.microsoft.teams2`) windows through the macOS Accessibility API, every 800 ms, only after you press **Start capture**. It never reads audio, video or the screen. Browser meetings use the Chrome extension.

## Where data goes

- Partial: `~/Library/Application Support/<desktop data dir>/capture/<id>.partial.md`, mode `0600`, removed after the note is verified.
- Note: `<notes root>/source/meetings/YYYY/MM/`.
- One index upsert to the local core.
- Nothing goes to a model until you choose Re-summarise in Library.

## Signing, entitlements and TCC

- Accessibility is a TCC permission, not an entitlement. No `Info.plist` usage key is added.
- No microphone, camera or screen-capture keys or entitlements exist; `desktop/scripts/check-capture-privacy.test.mjs` enforces this.
- The hardened runtime does not block AX client calls. The App Sandbox must stay off: a sandboxed app cannot be an AX client.
- TCC stores the grant against the app's code-signing identity and bundle id `com.llmide.desktop`. Ad-hoc builds get a new identity on rebuild, so remove the old entry and allow again. Developer ID builds keep the grant across updates while identity and bundle id stay the same.
- A build started from Terminal, VS Code or `npm run tauri dev` is attributed to that launcher. Grant Accessibility to the launcher, or start the `.app` from Finder. Debug builds say this on the Live screen.
- The OS prompt appears only after **Allow Accessibility…** is clicked.

These attribution statements are assumptions until the manual checklist confirms them.

## Recording a fixture

Spike builds only: run `npm run tauri dev -- --features spike`, call `capture_dump_tree("us.zoom.xos")`, and find JSON under `capture-fixtures/`. Replace every name and caption with invented text before committing, then add `raw` and `clean` expectations under `desktop/src-tauri/tests/fixtures/captions/`.

## Tests

```bash
cd desktop/src-tauri && cargo test --lib capture_
cd desktop && npm test
cd extension && node --test --experimental-strip-types tests/caption-validation-parity.test.ts
```
