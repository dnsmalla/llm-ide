# Doc Gen + Visual and Code Graph parity triage (verified)

Date: 2026-11-02. Input: 51 Mac labels from `scripts/parity-inventory.mjs` that have no literal match in the desktop code
(`mac/Sources/LlmIdeMac/Features/Generation/`, `Features/CodeGraph/` against `ui/screens/docgen`, `ui/screens/graph`,
`ui/kit/src`, `desktop/src-tauri/src/{graph_gen,graph_file}.rs`). First pass by Haiku, every row then checked by Opus
(Mac reachability, desktop absence with synonyms, host commands that exist today). Per-label data:
`scratchpad/triage/docgen-graph-verified.json` (session scratch, not committed).

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REWORDED | 30 | 29 |
| REAL_GAP | 12 | 13 |
| RUNTIME | 6 | 6 |
| MAC_ONLY | 3 | 3 |
| DEAD_ON_MAC | 0 | 0 |

9 of 51 rows changed: 3 class changes, 6 corrections inside REAL_GAP (needs/effort/description).
All REWORDED rows (30 of 30) were opened on the desktop side; 28 hold.

Reachability: every Mac view in this set is live. `UAGraphView` and `VisualView` are built by
`Shell/FeatureCatalog.swift:87,245`; `GraphSettingsSection` and `DocGenServerStoreCard` are registered Settings cards
(`FeatureCatalog.swift:173,136`); `GenerationTemplateSection`, `GenerationSetupSection` and `GenerationSourceTree` are
used by both `DocGenSourcePanel` and `VisualSourcePanel`; `DocTemplateManagerSheet` opens from
`GenerationTemplateSection.swift:84`. No DEAD_ON_MAC rows.

## Reclassifications

1. `) files in Library yet` (GenerationSourceTree.swift:92): REAL_GAP -> REWORDED. The desktop already says the list is
   empty: Notes tab `0 of 0 notes` (SourcePanel.tsx:303-305), Files tab `This folder is empty.` (SourcePanel.tsx:262),
   no folder `No notes folder is chosen yet` (SourcePanel.tsx:289).
2. `Expand graph to full page` (UAGraphView.swift:1306): REWORDED -> REAL_GAP. The Mac opens a full-window overlay with
   only the canvas (`expandedGraphOverlay`, UAGraphView.swift:1315-1350). The desktop button makes the whole window
   OS-fullscreen with `document.documentElement.requestFullscreen` (GraphScreen.tsx:177), so the run panel, list and
   details still take space. That is a different behaviour, not a rewording.
3. `Close full-page graph (Esc)` (UAGraphView.swift:1344): REWORDED -> REAL_GAP, same feature as 2.

Corrections inside REAL_GAP:

4. to 6. Template file import (3 labels, GenerationTemplateSection.swift:131,148,151): needs changed from rust to ui.
   Haiku said a host file-read command is missing. It is not: `attach_pick_files` + `attach_read`
   (desktop/src-tauri/src/attach.rs:242,256, registered lib.rs:379-380) already return a picked file's bytes in 4 MiB
   chunks over an opaque handle (used by ui/screens/chat/attach/host.ts).
7. `Saved as templates/` (DocTemplateManagerSheet.swift:111): still REAL_GAP, but the gap was described wrongly. This is
   not post-save feedback. It is a static caption in the template detail, shown whenever the selected template has a
   folder (`else if let folder = template.folderName`, :109-112). The desktop list shows name and section count only
   (TemplateManager.tsx:70-95), although `folderName` is decoded (decode.ts:44).
8. and 9. Graph generation progress (UAGraphView.swift:1830,1833): effort changed from M to S. `graph_gen.rs` already
   runs separate steps (code, memory, merge, write: graph_gen.rs:108-158). Emitting one event before each step is
   small. Per-file counts would need parsing CLI output (M). The Mac's "+ notes" phase writes code notes, which the
   desktop does not do at all (out of scope).

## Merged feature table

| Area | Feature | Final class | Labels | Evidence (one line) |
|---|---|---|---|---|
| docgen | Server file store switch (Settings) | MAC_ONLY | 2 | Mac toggles local files vs server (DocGenServerStoreCard.swift:11-12); desktop always goes through the core (docs-api.ts:1-6), so there is nothing to choose |
| docgen | Template folder captions | RUNTIME | 2 | Captions only; desktop already writes project templates through the core (TemplateManager.tsx:1) |
| docgen | Template detail placeholder | RUNTIME | 1 | Empty pane of the Mac split sheet; desktop has no split pane |
| docgen | Template manager (badges, add/save/delete, confirm, Manage) | REWORDED | 12 | TemplateManager.tsx:61-126, CommandManager.tsx:41-52, SetupPanel.tsx:58; same actions with different words |
| docgen | Template file location | REAL_GAP | 1 | See correction 7 |
| docgen | Result panel (Preview/Raw, generating, failed, discard, save, revise) | REWORDED | 9 | ResultPanel.tsx:56-191 |
| docgen | Reveal saved document / Visual image | REAL_GAP | 2 | Mac Reveal (GenerationEditorPanel.swift:236, VisualView.swift:204); desktop has Open in Explorer (ResultPanel.tsx:135) and the image preview has Close only (SourcePanel.tsx:211-215) |
| docgen | Read-only badge | RUNTIME | 1 | Desktop document is read-only in both modes (ResultPanel.tsx:178-183) |
| docgen | Output folder Choose… | REAL_GAP (HOLD) | 1 | Mac NSOpenPanel accepts any folder (GenerationSetupSection.swift:117-126); desktop is project-relative only (naming.ts:36-39, save.ts:1-4) |
| docgen | Reset to default folder | REWORDED | 1 | `Use default folder` (DocGenScreen.tsx:130) |
| docgen | Empty source list hint | REWORDED | 1 | See reclassification 1 |
| docgen | Unreadable source row marker | REAL_GAP | 1 | Mac marks each row (GenerationSourceTree.swift:220-225); desktop shows a banner only (ResultPanel.tsx:71,120) |
| docgen | Template import from a file | REAL_GAP | 3 | See corrections 4 to 6 |
| docgen | View image | REWORDED | 1 | `View` link plus a preview dialog (SourcePanel.tsx:242-243) |
| graph | Auto-update interval | REAL_GAP | 1 | GraphAutoUpdater (FeatureCatalog.swift:55); desktop Settings notice says Planned (settings/notices.ts:40-45) |
| graph | Doc-mode caption | REWORDED | 1 | GraphScreen.tsx:120 |
| graph | Inspector header and close | REWORDED | 2 | Details.tsx:72-79 |
| graph | Empty inspector hint | RUNTIME | 2 | Desktop shows details only after a selection (GraphScreen.tsx:238) |
| graph | Stale file notice | REWORDED | 2 | Details.tsx:91-97 shows File not found plus Regenerate graph; the path is in the File row (Details.tsx:85) |
| graph | 2D/3D switch | MAC_ONLY | 1 | MASTER-PLAN.md:159 keeps 3D Mac-local; desktop button disabled (GraphScreen.tsx:173) |
| graph | Canvas-only full page | REAL_GAP | 2 | See reclassifications 2 and 3 |
| graph | Generation phase progress | REAL_GAP | 2 | See corrections 8 and 9 |

### REAL_GAP detail

| Feature | What is missing | Needs | Effort | Risky | Safe now |
|---|---|---|---|---|---|
| Reveal saved document / Visual image | A Reveal button on the saved-document row and in the Visual image preview, calling `reveal_in_os` with the project-relative path (os_open.rs:348; saved paths are project-relative, save.ts:11) | ui | S | no | yes |
| Unreadable source row marker | A warning icon and tooltip on Files/Notes rows listed in `run.skipped` (run.ts:28) | ui | S | no | yes |
| Template file location | Show `templates/<folderName>/template.md` for project templates in the Manage dialog | ui | S | no | yes |
| Template import from a file | `Import .md file`: attach_pick_files, take the first .md/.txt under a cap (about 256 KB), attach_read, strict UTF-8 decode, attach_release, then `parseMarkdownTemplate` and the existing onSave. Commands have no import on the desktop at all (the Mac also imports commands from a file) | ui (existing host) | S | low | yes. It inherits the open MASTER-PLAN item "a template create over an existing folder writes into it" |
| Canvas-only full page | An in-window overlay with only the canvas, plus a close button and Esc, reusing the store | ui | S | no | yes |
| Generation phase progress | A Tauri event before each `run_gk` step and the write, shown next to `Generating…` | rust (small) | S | no | yes |
| Auto-update interval | A background regenerate on project open and on a timer, with the interval stored as a host preference. `graph_gen` has no cancel and no lock (MASTER-PLAN S2), so a timer run could collide with a manual run | rust + product decision | M | medium | no |
| Output folder Choose… | Saving outside the project | rust (new write command) + product decision | M | yes | HOLD |

## Mac copy that promises a missing action ("duplicate to customize")

`DocTemplateManagerSheet.swift:107` tells the user to "duplicate to customize" a built-in template. No Doc Gen template
duplicate action exists anywhere in `mac/Sources` (only Loop and Auto Tasks have Duplicate). With no project open, a
built-in's fields are disabled (`DocTemplate.isEditable`, DocTemplate.swift:272), and `New` makes a blank
"New Template". The desktop does not promise it: it shows `built in` with no Edit, and `New template` starts blank
(TemplateManager.tsx:94,100). So neither app can copy a built-in. Recommendation: the Mac is frozen, so leave the
copy. If wanted, add a desktop `Duplicate` on built-in rows that pre-fills the new-template form with the built-in's
name and sections (S, ui). That would go beyond parity and is optional.

## Implementation batches

A. Small, pure UI, safe now:
- Reveal saved document and Visual image (reveal_in_os)
- Unreadable source row marker
- Template file location caption
- Template import from a file (existing attach_pick_files/attach_read; size and extension caps in the UI)
- Canvas-only full-page graph with Esc

B. UI plus a small host change:
- Graph generation phase progress: emit events from `graph_gen.rs` between steps.
- Optional, safe part of the output-folder gap: an in-project `Choose…`. It uses `pick_folder` + `pick_folder_redeem`
  (source_pick.rs:89,114), accepts the folder only if it is inside the canonical project root, and stores the
  project-relative path in the existing field. It writes nowhere new. This needs a relativise-against-root check, best
  done on the host so symlinks and canonical paths cannot fool it.

C. Rust, core or product decision:
- Code Graph auto-updater. Decision needed: the default interval, whether it runs while the app is in the background,
  and its CPU cost. Prerequisite: generation cancel and a single-run lock in `graph_gen.rs` (already open in MASTER-PLAN
  S2).
- Doc Gen output folder outside the project: HOLD.

### HOLD: output folder outside the project

The Mac writes generated documents to any folder the user picks. The desktop's whole save path is root-confined
(`fs_ops` create/write with a no-replace create and hash compare-and-swap, save.ts:1-4). Recommendation: do not build
this until it is a product decision. If it is approved, a safe version needs all of the following:
- A dedicated host command. The page sends a `pick_folder` token, never a path. The host redeems the token, stores the
  canonical folder in a host preference, and rejects too-broad roots (`project::validate_root`) and system folders.
- Root confinement to that one folder: no `..`, symlinks resolved, and the final component opened with
  `O_NOFOLLOW | O_EXCL` (the same fix as the `fs_ops::copy` dangling-symlink hole).
- Never overwrite: create-new only, with the `-2`, `-3` suffixes as today. A revision only by hash compare-and-swap of a
  file this app wrote.
- A user-visible path: the full absolute folder shown in Setup and in the "Saved to" row, plus a one-click reset to
  `llm-doc/generated`.
- Re-confirmation when the folder is missing or now resolves elsewhere, and no silent fallback.

None of the 51 labels sends content to an external destination. Box/Slack/Email delivery is already disabled on the
desktop.

## Not verified

- Behaviour in a real window (UN-001 applies to every desktop item cited).
- Whether the docgen screen can import `ui/screens/chat/attach/host.ts` directly under the UI module rules, or needs its
  own small adapter over the same three host commands. Either way, no Rust is needed.
