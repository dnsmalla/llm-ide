# Doc Gen project-folder fixtures

Vendored from the retired Swift app's `Tests/LlmIdeMacTests/Fixtures/docgen/`
(git history, last at `b9e3e878`), byte for byte, so the Node tests in
`tests/docs-templates.test.mjs` read real files older builds wrote. Do not
hand-edit.

- `project/*.md`: the K1a project-marker fixtures.
- `server-scan.golden.json`: the scan golden, rewritten by
  `node scripts/docs-kit-parity-golden.mjs` and checked by
  `tests/docs-server-golden.test.mjs`.

Note on the bytes: `template-md.v0-bare-marker.md` and `command-md.v0-bare-marker.md`
were written by older builds (their wording differs from HEAD). They are read
fixtures only: the server never has to reproduce them. The byte-exact golden
for what HEAD writes is in `tests/docs-templates.test.mjs` (`GOLDEN_*`).
