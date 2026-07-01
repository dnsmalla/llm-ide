---
title: Guardrail rules
source: extension/guardrails/rules.mjs
---

<!-- generated from extension/guardrails/rules.mjs - do not edit by hand -->

# Guardrail rules

Rules are evaluated at submit AND at approval. Severities: `blocking` rejects the action; `warning` requires explicit override; `info` annotates only.

## Dispatch

| ID | Severity | Message |
|---|---|---|
| `dispatch.bulk` | `warning` | Bulk dispatch of … tickets — confirm the target tracker can handle this. |
| `dispatch.creds` | `blocking` | GitHub dispatch requires repo and token in config. |
| `dispatch.empty` | `blocking` | No tasks to dispatch. |
| `dispatch.pii` | `warning` | Possible PII in ticket title: …. |
| `dispatch.secret` | `blocking` | Possible secret in task "…". |
| `dispatch.summary` | `info` | Will create … … ticket…. |
| `dispatch.target` | `blocking` | Target must be github, backlog, or linear (preview never reaches review). |
| `dispatch.title-length` | `warning` | Title is empty or longer than 250 characters; some trackers will truncate. |

## Codegen apply

| ID | Severity | Message |
|---|---|---|
| `codegen.allowlist` | `blocking` | No repos are allow-listed for code apply. Add the repo path to the allow-list in Settings → Connectors. |
| `codegen.bulk` | `warning` | Apply touches … files — large changesets are harder to review. |
| `codegen.destructive` | `warning` | Destructive operation in "…": …. |
| `codegen.empty` | `blocking` | No files or tests to apply. |
| `codegen.path` | `blocking` | File entry is missing a path. |
| `codegen.path-escape` | `blocking` | Path "…" attempts to escape the repo root. |
| `codegen.path-ext` | `warning` | Path "…" has an unfamiliar extension; double-check before approving. |
| `codegen.repo` | `blocking` | Repo path is required. |
| `codegen.secret` | `blocking` | Possible secret in "…": …. |
| `codegen.size` | `warning` | "…" is … KB; large generated files often need manual review. |
| `codegen.summary` | `info` | Will write … file… + … test… under …. |

## Guardrail engine

| ID | Severity | Message |
|---|---|---|
| `guardrail.kind` | `blocking` | Unknown artifact kind: … |
