# Plan: tiers use only available providers

**Date:** 2026-10-25
**Branch:** `feat/provider-availability-tiers`

## Problem

A tier can name a provider that cannot run. A user with no DeepSeek key had
Standard = DeepSeek (carried over from an old `activeCLI` by the tier-defaults
migration). Standard writes through to `activeCLI` / `defaultModelId`, which the
quick chat, Loop, Auto Tasks and the phone bridge use, so every quick-chat turn
failed with "No API key configured for DeepSeek". Settings only showed a note; the
pickers still listed every provider.

## Decision (user-chosen)

At startup (and whenever keys or custom providers change), check which providers
are available. A tier whose provider is not available is **cleared, then
auto-filled** from an available provider. A tier stays empty only when no provider
is available. Pickers list only available providers.

## Design

### 1. Availability (`Core/Platform/ProviderAvailability.swift`, new)

Pure function over values, so it is unit-testable:

| Provider (wire id) | Available when |
|---|---|
| `anthropic` | `claude` CLI installed (`TierRouting.isCLIInstalled(.claudeCode)`) **or** `ClaudeCLI.vaultKey` stored |
| `openai` | `openai.apiKey` stored **or** `codex` CLI installed |
| `google` | `google.apiKey` stored **or** `gemini` CLI installed |
| `deepseek` | `deepseek.apiKey` stored (no CLI mode) |
| `custom` (shared endpoint) | `custom.apiKey` stored |
| `custom:<id>` | provider enabled **and** (its `apiKey` vault name stored **or** its base URL is loopback — `EndpointSecurity.isLoopbackURL`) |
| `jev` (decision-only) | never judged: Jev tiers are left untouched |

Stored keys come from `api.configuredSecretKeys()` (vault names only).

`ProviderAvailabilityStore` (`@MainActor`, shared, observable) holds
`available: Set<String>?`. **`nil` = unknown** (not fetched yet, backend down,
fetch failed). Nothing is ever cleared or hidden while unknown: a down backend
must never wipe a user's tiers.

### 2. Reconcile (`TierDefaults.reconcile`, pure)

Input: routing table, available set, a `models(provider) -> [AIModel]` lookup.
For each of `strong`, `standard`, `cheap`, `image`:

1. Skip Jev routes.
2. Route's provider not available → remove the tier.
3. Auto-fill a tier removed in step 2, and Standard whenever it is empty:
   - provider: Standard's provider if available, else `anthropic` if available,
     else the first available built-in (menu order), else the first available
     enabled custom provider. Image tier: only image providers
     (`ImageTierRouting.providers`); never filled from a non-image provider.
   - model: for Claude, match the live list by family — strong → `opus`,
     standard → `sonnet`, cheap → `haiku` — falling back to the first model;
     other providers: their first model.
   - no available provider, or no model known (Claude's live list not loaded
     yet) → leave the tier empty; the next refresh fills it.
4. Strong / Cheap / Image that the user left unset stay unset (only cleared
   tiers are refilled).

Output: new table + whether Standard changed.

### 3. Wiring

- Run `refresh → reconcile → save` on the existing refresh path
  (`TierRoutingRefresh`, called at login, on backend `.running`, on API-version
  change) **before** the table is pushed to the server, and after
  Settings → Model Providers saves or deletes a key and on
  `.customProvidersChanged`.
- Standard changed → `config.applyStandardTier(newStandard)` (existing
  write-through to `activeCLI` / `defaultModelId`).
- Make sure Claude's live model list is loaded before reconciling when
  `anthropic` is available (`LiveModelCache`), so a Claude fill has a model.

### 4. UI

- **Settings → Tiers & Roles:** provider pickers list only available providers
  (all of them while availability is unknown). When nothing is available,
  Standard shows "No provider set up — add one in Model Providers".
- **Quick chat:** when availability is known and Standard's provider is not
  available (or Standard is empty), do not send; show "No model provider set up.
  Add one in Settings → Model Providers." Show the model in use in the header.
  A failed reply must not leave an empty assistant bubble.
- **Code Assistant composer menu** (`CodeAssistantModelState+Providers.swift`):
  list providers from the same availability store instead of its own ad-hoc
  check (Claude no longer always listed); keep the currently selected provider
  listed so a chat's chip never disappears.

## Tests

- Availability table: each row, including loopback custom without key, disabled
  custom, CLI-only OpenAI, unknown (`nil`) store.
- Reconcile: the DeepSeek case (Standard → Claude Sonnet); nothing available
  (all empty); Claude list not loaded (stays empty); user-unset Strong stays
  unset; Jev untouched; image tier only refilled from image providers.
- `make regression` green.

## Out of scope

Backend startup health window and once-a-day backup (reported separately).
