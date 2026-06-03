---
title: How to run the server locally
applies_to: server
---

# How to run the server locally

## Goal

A running `127.0.0.1:3456` API for the extension or macOS app to call.

## Steps

```bash
cd extension
npm install         # first time only
npm run server      # node server.mjs
```

For verbose logging:
```bash
MEETNOTES_LOG_LEVEL=debug npm run server
```

For JSON logs:
```bash
MEETNOTES_LOG_JSON=1 npm run server
```

## Verification

```bash
curl -s http://127.0.0.1:3456/health | jq '.status'
```
Expected: `"ok"`.

## See also

- [Environment variables reference](../reference/env-vars.md)
- [CLI scripts reference](../reference/cli-scripts.md)
