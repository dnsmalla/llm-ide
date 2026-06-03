---
title: How to add a UI language
applies_to: server, extension
---

# How to add a UI language

## Goal

Add a new language option (e.g., Portuguese) so the side panel can request notes / chat / questions in that language and the server's prompts include the matching directive.

## Steps

1. **Server — language name + directive.** In `extension/server.mjs`, add an entry to `LANGUAGE_NAMES` keyed by the BCP-47 code (`pt-BR`) with the human name (`Português`).
2. **Server — question headings.** In the same file, extend `HEADING_LABELS` for the new language (the three localised H2 headings used by `/generate-questions`).
3. **Extension — selector option.** In `extension/src/sidepanel/components/LanguageSelector.tsx` (or wherever it lives), add the new option.
4. **DOCX font fallback.** If the language needs a non-default font (e.g., CJK), extend the font logic in `extension/generate-docx.mjs`.
5. **Bump `SERVER_API_VERSION`** only if you also added a wire-format field. Adding a language alone does not change wire format.

## Verification

1. Restart the server.
2. In the side panel, pick the new language.
3. Generate notes → headings and bullets should be in the new language.
4. Open the `/generate-questions` UI → the three section headings should be localised.

## See also

- [Engineering invariants — local server](../explanation/invariants.md#local-server-extensionservermjs)
- [API overview](../reference/api/overview.md)
