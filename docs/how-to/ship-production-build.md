---
title: How to ship a production Mac build
applies_to: mac
---

# Shipping a production Mac build

## Prerequisites

1. Apple Developer Program membership ($99/yr).
2. Developer ID Application certificate installed in your login Keychain. Get it from `developer.apple.com → Certificates, IDs & Profiles`.
3. Notarization-capable Apple ID (the email tied to your Developer account), with an app-specific password stored in Keychain via:

   ```bash
   xcrun notarytool store-credentials "LLM-IDE-Notarize" \
       --apple-id you@example.com \
       --team-id ABCDEFG123
   ```

## Steps

### 1. Verify your signing identity

```bash
security find-identity -p codesigning -v
```

You should see one entry like `Developer ID Application: Your Name (ABCDEFG123)`. Note the cert's full name.

### 2. Sign with your Developer ID

For local-dev builds the existing ad-hoc signing is fine. For distribution,
point `Scripts/sign.sh` at your Developer ID and let it do the work:

```bash
LLMIDE_SIGN_IDENTITY="Developer ID Application: Your Name (ABCDEFG123)" \
  Scripts/sign.sh
```

Do **not** hand-roll this with `codesign --deep`. The script signs
inside-out — Sparkle's XPC services, then `Updater.app`, then `Autoupdate`,
then the framework, then the app — because `--deep` is deprecated for signing
AND applies the outer app's `--entitlements` to every nested binary. That is
how Sparkle's updater previously ended up holding
`com.apple.security.device.microphone` and
`com.apple.security.cs.disable-library-validation`. Only the app itself gets
the entitlements file.

`--timestamp` is applied automatically for a real identity (notarization
requires a secure timestamp) and skipped for ad-hoc builds, which cannot
carry one.

### 3. Notarize

```bash
ditto -c -k --keepParent "$APP_DIR" "$APP_NAME.zip"
xcrun notarytool submit "$APP_NAME.zip" \
    --keychain-profile "LLM-IDE-Notarize" \
    --wait
```

Successful submission takes 1–15 minutes. If it fails, run `xcrun notarytool log <submission-id> --keychain-profile LLM-IDE-Notarize` to see the rejection reason.

### 4. Staple

```bash
xcrun stapler staple "$APP_DIR"
```

This embeds the notarization ticket so Gatekeeper accepts the app offline.

### 5. Build the DMG

Existing `build_app.sh` already produces a DMG. Sign + staple the DMG too:

```bash
codesign --force --sign "Developer ID Application: ..." "$DMG_NAME"
xcrun stapler staple "$DMG_NAME"
```

### 6. Verify

On a different Mac (or after wiping Gatekeeper cache):

```bash
spctl --assess --verbose "$APP_DIR"
```

Should report `accepted` + `source=Notarized Developer ID`.

## Sparkle (auto-updates)

Not yet integrated. Add Sparkle once we have a website to host the appcast.

## See also

- [ADR 0001 — Claude CLI, not API key](../decisions/0001-claude-cli-not-api-key.md)
- [How to build the macOS app (dev)](build-the-macos-app.md)
