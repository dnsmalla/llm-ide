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

For a release DMG:
```bash
cd mac
./build_app.sh --release
```

## Verification

The app launches and the Knowledge Base panel populates from the server. If "Server offline" persists, start the server: see [run-the-server-locally.md](run-the-server-locally.md).

## See also

- [mac/README.md](../../mac/README.md)
