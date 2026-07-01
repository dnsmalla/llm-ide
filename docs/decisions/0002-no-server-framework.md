---
title: "0002. Use pure Node http with no server framework"
status: accepted
date: 2026-05-18
---

# 0002. Use pure Node http with no server framework

## Context

The server is small (≤ 30 routes) and runs locally. Express, Fastify, and Koa were considered. None offer a feature we need that we cannot write in a few dozen lines.

## Decision

Build on Node's built-in `http` module. Hand-roll routing, CORS, request-id, JWT verification, rate limiting, and audit middleware as small composable functions under `extension/server/`.

## Consequences

- **Positive:** cold start is fast; dependency surface is small; supply-chain risk is minimal.
- **Positive:** every request-handling concern is explicit and grep-able.
- **Negative:** routing and middleware are hand-rolled; new contributors expecting Express conventions have a small ramp.
- **Negative:** no ecosystem of pre-built middleware to lean on.
- **Locked in:** see [invariants — local server](../explanation/invariants.md#local-server-extensionservermjs).
