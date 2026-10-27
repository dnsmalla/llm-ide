# Doc Gen legacy on-disk fixtures

Real on-disk shapes that Doc Gen state has had over time. Read by
`DocGenLegacyStateTests.swift`. Do not hand-edit: regenerate from the source
commit if a fixture ever needs to change, or add a new file for a new shape.

Each file was produced by compiling the historical model file from the named
commit (`git show <commit>:<path>`) with a small driver that calls the same
`JSONEncoder` the store used (`AppJSON.encoder` is a default `JSONEncoder`).
Output is pretty-printed with sorted keys so it reads well; the store wrote
compact JSON, but key order and whitespace do not affect decoding. Where a
store's own writer lived in the same file (the envelope `StoreFile`, the
`[String: DocGenOutputConfig]` dictionary, the `Cached` cache struct), that
struct was copied verbatim from the commit and encoded the same way.

| File | Format | Source commit | How obtained |
|---|---|---|---|
| `doc-templates.v0-bare-array.json` | `[DocTemplate]` bare array, fields `id,name,sections,rawContent?,isBuiltin` | **Reconstructed.** No commit in this repo writes a bare array: the earliest commit (`ed5b1802`, "Initial commit") already writes the envelope. The bare-array read path is a fallback for files from an earlier build that predates this git history. Shape from the first `DocTemplate` model (`ed5b1802:mac/Sources/LlmIdeMac/Models/DocTemplate.swift`); encoded with that model's synthesized Codable. | Reconstructed (see above). |
| `doc-templates.v1-envelope.json` | `{storeVersion:1, templates:[…]}`, template fields `id,name,sections,rawContent?,isBuiltin` | `ed5b1802` (first commit with the envelope) | Real encoder output of the `ed5b1802` `DocTemplate` model plus the `StoreFile` struct copied from `ed5b1802:mac/Sources/LlmIdeMac/Services/DocTemplateStore.swift`. |
| `doc-templates.v1.1-envelope-folders.json` | envelope, adds `folderName`, `isProjectTemplate` (no `surface`) | `c8f625b8` (`feat(mac): seed project templates/ folder…`) | Real encoder output of the `c8f625b8` `DocTemplate` model, same envelope. |
| `doc-templates.v2-envelope-surface.json` | envelope, adds `surface` (`doc` / `visual`) | Current format, from `27a99325` onward (HEAD model) | Encoded from the HEAD `DocTemplate.swift` + `TemplateSurface.swift`; `IngestStub` stubs the two ingest symbols the model references, which are not encoded. |
| `doc-gen-output.v0.json` | `[String(project path): DocGenOutputConfig]` with `destination,localFolderPath?,sendCopyToEmail` | `b706327b` (`feat(mac): Doc Gen の出力先設定とストアを追加`); model unchanged through HEAD (verified by diff) | Real encoder output of the `b706327b` `DocGenOutputConfig.swift`; the store wrote the same dictionary via `JSONEncoder().encode(byProject)`. `ProjectLayout` stubbed (not encoded). |
| `generation-library.v0.json` | `{templates:[Entry], commands:[Entry]}`, `Entry = id,name,description,surface,body` | `44c0703b` (`feat(mac): テンプレートとコマンドの既定を kit から読む`); unchanged through HEAD | The `Cached` struct copied from `44c0703b:…/GenerationLibraryStore.swift`, encoded the same way. Entry contents are invented sample kit rows, not a real server response. |
| `project/template-md.v0-bare-marker.md` | project `templates/<folder>/template.md`, bare marker, no `surface=` | `c8f625b8` `DocTemplate.markdownBody` | Real output of that function. |
| `project/template-md.v2-visual-marker.md` | project template, `surface=visual` marker | Current format, from `27a99325` onward | Written by the surface-marker build, not by HEAD: it ends with two newlines after the last `##` heading, and HEAD's `markdownBody(surface: .visual)` writes one. A read fixture; the byte-exact HEAD output is the golden in `extension/tests/fixtures/docgen/golden.mjs`. |
| `project/command-md.v0-bare-marker.md` | project `commands/<folder>/command.md`, `<!-- llmide:doc-command -->` | `c7df203d` (`feat(mac): DocCommandStore とコマンドの seeder を追加`) | Real output of `c7df203d` `DocCommand.markdownBody`. |

Not fixtured, and why:
- The Doc Gen output file has no envelope and no `storeVersion`; the first
  shape is the only shape.
- Versions of `GenerationLibraryStore` before `44c0703b` did not persist
  anything; there is no older cache format.
