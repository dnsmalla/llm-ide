# Doc Gen project-folder fixtures (server copy)

Copies of `mac/Tests/LlmIdeMacTests/Fixtures/docgen/project/*.md`, byte for
byte, so the Node tests in `tests/docs-templates.test.mjs` read the same real
files the Swift K1a tests read. Provenance (which commit wrote each shape) is in
`mac/Tests/LlmIdeMacTests/Fixtures/docgen/README.md`. Do not hand-edit.

Note on the bytes: `template-md.v0-bare-marker.md` and `command-md.v0-bare-marker.md`
were written by older builds (their wording differs from HEAD). They are read
fixtures only: the server never has to reproduce them. The byte-exact golden
for what HEAD writes is in `tests/docs-templates.test.mjs` (`GOLDEN_*`), and the
Swift side asserts the same literals in `mac/Tests/LlmIdeMacTests/DocGenServerParityTests.swift`.
