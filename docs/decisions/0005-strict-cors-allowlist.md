---
title: "0005. CORS is a strict allowlist, never wildcard"
status: accepted
date: 2026-05-18
---

# 0005. CORS is a strict allowlist, never wildcard

## Context

A wildcard `Access-Control-Allow-Origin: *` would let any website the user visits issue requests against the local server. Combined with the JWT being stored in the extension, that is a path to transcript theft.

## Decision

CORS origins are restricted to: `chrome-extension://<our-extension-id>`, `http://localhost(:port)?`, `http://127.0.0.1(:port)?`. The `Access-Control-Allow-Origin` header echoes the request's `Origin` only when it matches the allowlist, never `*`.

## Consequences

- **Positive:** drive-by sites cannot reach the local API even when the server is running.
- **Positive:** localhost dashboards (e.g., the planned dashboard) work without further config.
- **Negative:** the extension ID is hard-coded into the allowlist; an extension republish that changes the ID requires a server update.
- **Locked in:** see [invariants — local server](../explanation/invariants.md#local-server-extensionservermjs).
