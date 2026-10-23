---
title: How to build the macOS app
applies_to: macOS
---

# How to build the macOS app

## Goal

A running `LlmIdeMac.app` connected to your local server.

## Steps

```bash
cd mac
./build_app.sh
```

This compiles via Swift Package Manager, packages an `.app` bundle, and opens it. The app expects the server at `127.0.0.1:3456`.

The bundled executable is stripped. Its debug symbols are written next to the bundle as `mac/LlmIdeMac.app.dSYM`. Run `LLMIDE_SKIP_STRIP=1 ./build_app.sh` to keep them in the executable for debugging.

`./build_app.sh` takes one optional flag, `--clean-all`, which deletes the SwiftPM caches and rebuilds from scratch. It runs build → sign → DMG (no notarization), so it also leaves a dev DMG at `mac/LlmIdeMac_v<VERSION>.dmg`. That DMG is ad-hoc signed unless `LLMIDE_SIGN_IDENTITY` (or the gitignored `mac/Scripts/.sign-identity`) names an identity, and it is never notarized: do not hand it out.

For a release DMG (build → sign → notarize → DMG), run the release pipeline instead:

```bash
cd mac
LLMIDE_SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" \
LLMIDE_NOTARY_PROFILE=<notarytool keychain profile> \
Scripts/release.sh
```

`Scripts/release.sh` refuses to run without both variables, unless you set `LLMIDE_ALLOW_DEV_RELEASE=1` to get an unsigned dev build. Each phase is also runnable on its own: `Scripts/build.sh`, `Scripts/sign.sh`, `Scripts/notarize.sh`, `Scripts/dmg.sh`. See [release.md](release.md#3-mac-app) for the full release flow.

## Verification

The app launches and the Knowledge Base panel populates from the server. If "Server offline" persists, start the server: see [run-the-server-locally.md](run-the-server-locally.md).

## See also

- [mac/README.md](https://github.com/dnsmalla/llm-ide/blob/main/mac/README.md)
