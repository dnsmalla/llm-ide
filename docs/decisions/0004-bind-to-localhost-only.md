---
title: "0004. Bind the server to 127.0.0.1 only"
status: accepted
date: 2026-05-18
---

# 0004. Bind the server to 127.0.0.1 only

## Context

The server holds transcripts, plans, and a credential vault. Binding to `0.0.0.0` (all interfaces) would expose all of that to anyone on the user's local network or VPN.

## Decision

The server listens on `127.0.0.1:3456`. Binding to `0.0.0.0` is rejected in code; there is no env var to override it.

## Consequences

- **Positive:** transcripts and credentials are not reachable from the LAN.
- **Positive:** the firewall question disappears.
- **Negative:** users who want a remote teammate to call the server must use SSH port-forwarding or an explicit reverse proxy.
- **Locked in:** see [invariants — local server](../explanation/invariants.md#local-server-extensionservermjs). Do NOT add a `HOST` env var.
