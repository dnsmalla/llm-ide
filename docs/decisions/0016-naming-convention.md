# ADR 0016: Product naming convention

**Status:** Accepted  
**Date:** 2026-07-25

## Context

The codebase mixed `LLM-IDE` (spaced), `llm-ide` (slug), `LlmIde` (code), and `llmide` (wire/bundle). That confused docs, UI copy, and on-disk paths.

## Decision

Use **two public forms** plus fixed technical identifiers:

| Context | Form | Example |
|---------|------|---------|
| User-visible brand | **LLM-IDE** | Menu titles, README, extension name, error strings |
| Repo / package / URL slug | **llm-ide** | `github.com/…/llm-ide`, npm `llm-ide-extension`, docs paths |
| Swift / TypeScript types | **LlmIde** | `LlmIdeMac`, `LlmIdeAPIClient` (unchanged — language convention) |
| Wire / bundle (no hyphens) | **llmide** | `com.llmide.macapp`, `_llmide._tcp`, `llmide://`, `llmide:caption` events |
| Environment variables | **LLMIDE_** | `LLMIDE_JWT_SECRET` (unchanged — shell convention) |
| On-disk folders | **llm-ide** | `~/Library/Application Support/llm-ide` |

### Migration

Mac app paths previously used `LLM-IDE` (with a space). `AppIdentity` renames legacy folders to `llm-ide` on first access. Node plugin dir (`extension/plugins/loader.mjs`) checks both names.

### Do not rename

- Swift module / target names (`LlmIdeMacLib`) — SPM identifiers
- Historical gitignore markers in existing user projects (`# >>> LLM-IDE managed`) — still recognized; new scaffolds use `# >>> LLM-IDE managed`

## Consequences

- Single source for Mac display name and paths: `mac/Sources/LlmIdeMac/Models/AppIdentity.swift` and `Strings.swift`
- User-facing prose and UI strings use **LLM-IDE**
- Filesystem paths use **llm-ide** (kebab-case, lowercase)
