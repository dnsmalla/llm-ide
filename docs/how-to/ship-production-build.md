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
   xcrun notarytool store-credentials "LLM IDE-Notarize" \
       --apple-id you@example.com \
       --team-id ABCDEFG123
   ```

## Steps

### 1. Verify your signing identity

```bash
security find-identity -p codesigning -v
```

You should see one entry like `Developer ID Application: Your Name (ABCDEFG123)`. Note the cert's full name.

### 2. Update build_app.sh for production

For local-dev builds the existing ad-hoc signing is fine. For distribution:

```bash
codesign --force --deep --options runtime --timestamp \
  --entitlements "$PROJ_DIR/LlmIdeMac.entitlements" \
  --sign "Developer ID Application: Your Name (ABCDEFG123)" \
  "$APP_DIR"
```

### 3. Notarize

```bash
ditto -c -k --keepParent "$APP_DIR" "$APP_NAME.zip"
xcrun notarytool submit "$APP_NAME.zip" \
    --keychain-profile "LLM IDE-Notarize" \
    --wait
```

Successful submission takes 1–15 minutes. If it fails, run `xcrun notarytool log <submission-id> --keychain-profile LLM IDE-Notarize` to see the rejection reason.

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
