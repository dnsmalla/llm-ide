# ui-kit

Status: **K0 Map** written 2026-10-31; **K1 done 2026-10-31** (section 11 records what changed). Sections 1 to 10 describe the tree before K1 and are kept as the K0 record. Citations are `path:line` or path only; read on 2026-10-31 at `main` (`de7d1f38`). Counts say how they were taken (`wc -l`, `ls`, `git ls-files`). Section 9 lists where the migration plan's premises do not match the code; section 10 lists what was not verified.

## 1. Purpose

ui-kit is "one look": the design tokens and the shared presentational pieces every screen of every surface is built from. It is **not** a feature and has no server route, no data and no feature key. The plan's kit row (`docs/superpowers/plans/2026-10-27-kit-by-kit-migration.md`, kit 0) is `schema/design/tokens.json` to Swift `ThemeTokens` and CSS, shared React components, and `Core/DesignSystem`. Every K3 (kit screen in Tauri) depends on it ("ui-kit unblocks every K3 and one look", plan, Order item 2).

Premise check, first: **the token half is done, the component half is not.** Tokens have one source and generated outputs with a drift gate. Components exist twice, hand-written in Swift (SwiftUI) and hand-ported in React inside the throwaway `desktop/` spike, with no shared source (section 2c, section 9).

## 2. Code on every side

### 2a. Contract and generator

| Piece | Path | Lines (`wc -l`) | Notes |
|---|---|---|---|
| Token source | `schema/design/tokens.json` | 92 | Three themes (`dark`, `light`, `midnight`), spacing, radii, type scale, category hues. Colours are `{"rgb":[r,g,b]}` or `{"white":a}` / `{"black":a}`. |
| Token README | `schema/design/README.md` | | Outputs table; status, diff and gutter colours are deliberately not stored (they alias colour roles in code). |
| Generator | `scripts/gen-design-tokens.mjs` (`--check` exits 1 on a stale output) | | `make design-tokens`; `make contract-gates` runs the check (`Makefile:230`). |
| Output, Mac | `mac/Sources/LlmIdeMac/Core/Platform/ThemeTokens.swift` | 196 | Plain values, no SwiftUI. |
| Output, CSS | `schema/design/tokens.css` | 119 | `--tok-*`; `:root` is the dark theme, `[data-theme="<id>"]` overrides colours. |
| Output, extension | `extension/src/styles/tokens.generated.css` | | Same CSS, bundled by Vite. Used by the side panel (`extension/src/sidepanel/styles/global.css`, 45 `var(--tok-` uses by `grep -c`). |
| Output, OS view | `ui/os-view/src/tokens.generated.css` | | Same CSS. |
| Run on 2026-10-31 | `node scripts/gen-design-tokens.mjs --check` | | `design-tokens: ok (3 themes, 4 outputs)`. |

### 2b. Mac (`mac/Sources/LlmIdeMac/`)

| Piece | Path | Size | Notes |
|---|---|---|---|
| Theme | `Core/Platform/Theme.swift` | 382 | Builds `Color` and `Font` from `ThemeTokens`; the derived-colour aliases live here. `theme.current` is read by 152 files (`grep -rln "theme.current"`). |
| Design system | `Core/DesignSystem/` | 29 files, 3 987 lines (`cat \| wc -l`) | Chrome (`SectionChromeBar`, `PanelSectionTabs`, `EditorTabBar`, `FileTreePanel`, `FileDetailView`, `TreeRowLabel`), content (`MarkdownRenderer`, `SelfSizingMarkdownView`, `MermaidInstallBanner`), library picker, and `Components/` (`Chip`, `LabelChip`, `AttachmentChip`, `StatusBanner`, `EmptyStateView`, `SettingsSectionCard`, `SheetHeader`, `SectionLabel`, `ResizableDivider`, `PersistedPanelWidth`, `PathPickerField`, `UserAvatar`, `OperationsAllowlistView`). |
| Shell chrome | `Shell/Chrome/` | 7 files, 784 lines | `StatusBar`, `ActivityBell`, `HeaderAccountMenu`, `ProjectSwitcher`, `QuickSwitcherSheet`, banners. Exempt from the feature/boundary rule (CLAUDE.md) but not from build exclusion. |
| Tests | `Tests/LlmIdeMacTests/ThemeTokensTests.swift`, `ThemeDecorationColorTests.swift`, `ThemeGitTokensTests.swift` | | By name. |

Boundary: `Core/DesignSystem` is Core, so any feature may import it; the gate (`mac/Scripts/feature-boundaries.sh`) does not see Core-to-feature edges that run through it (CLAUDE.md, known limitation).

### 2c. Desktop spike (`desktop/`, tracked: 97 files by `git ls-files desktop`)

| Piece | Path | Lines | Notes |
|---|---|---|---|
| Tokens (second generator) | `desktop/scripts/gen-tokens.mjs`, output `desktop/src/design/tokens.css` | 151 | **Reads `ThemeTokens.swift` and `Theme.swift` by regex, not `tokens.json`.** Different output from `schema/design/tokens.css` (the two files differ from line 1). Run on 2026-10-31: `tokens.css is up to date`. `npm run build` runs the check (`desktop/package.json:8`). |
| Components | `desktop/src/design/components/` (`AppStatusBar`, `Chip`, `EditorTabBar`, `FileTreeRow`, `LibrarySidebar`, `ResizableDivider`, `SectionChromeBar`, `SettingsSectionCard`, `StatusBanner`, `icons`) | 10 files, 747 lines | Hand-ports of Mac components. |
| Styles | `desktop/src/design/components.css` | 430 | |
| Parity evidence | `desktop/parity/*.png` | 5 screenshots | Shell dark, light, midnight, editor, Mac app. Visual only, no automated diff. |
| Status | `desktop/README.md` | | "LLM-IDE Desktop PoC (throwaway)": a Phase 0 spike, "not a product". |

### 2d. Web surfaces that already consume tokens

| Surface | Path | Tokens from |
|---|---|---|
| Chrome extension side panel | `extension/src/sidepanel/` | `tokens.generated.css` (from `tokens.json`) |
| System page host | `ui/os-view/` | `tokens.generated.css` (from `tokens.json`); the page itself is graph-kit's `web/` with its own `os-tokens.css`, `theme.css`, `theme.ts` |
| Desktop spike | `desktop/src/` | `desktop/src/design/tokens.css` (from Swift) |

Three CSS token copies come from `tokens.json`, a fourth from Swift (section 7, U2).

### 2e. Feature key and gates

None: ui-kit has no key and is always compiled. Gates are the token drift check (`make contract-gates`) and the OS bundle check (`make os-view-check`, `Makefile:253`). There is no gate that compares a Swift component with its React twin.

## 3. Cross-kit edges

ui-kit depends on nothing (plan: depends on none). Everything depends on it.

| # | From to | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| UI1 | every Mac feature to ui-kit | direct (`theme.current`, `Core/DesignSystem` types) | ok (Core) | 152 files |
| UI2 | Library, Issues, Explorer to `LibraryPicker`, `FileTreePanel` | direct, Core | ok | `Core/DesignSystem/` |
| UI3 | extension to ui-kit | generated CSS | ok | `extension/src/styles/tokens.generated.css` |
| UI4 | os-kit page to ui-kit | generated CSS in the host, own CSS in the page | partial: two token sheets in one bundle | section 2d |
| UI5 | desktop to ui-kit | second generator over Swift | **drift risk** | section 2c |
| UI6 | graph-kit renderer to ui-kit | none: graph-kit's `web/` carries its own theme | by design (separate repo) | `mac/LocalPackages/graph-kit/web/src/theme.ts` |

No cycles.

## 4. Delegated vs owned

| Piece | Label | Reason |
|---|---|---|
| Colour roles, spacing, radius, type scale | Owned | The product's look; one source file. |
| Token generator and drift check | Owned (thin) | Pure transform. |
| SwiftUI components | Owned | Native feel; no model has a say. |
| React components in `desktop/` | Owned, **unsettled** | Prototype; K3 decides whether they are the shared set. |
| Markdown and Mermaid rendering | Delegated to libraries | `MarkdownRenderer`, Mermaid downloaded on demand. |
| Icon set | Owned, unsettled | SF Symbols on Mac (also named by catalog `icon` fields, for example `connector-catalog.mjs`); `desktop/src/design/components/icons.tsx` hand-draws the web twins. |

## 5. State and data

None server-side. Per-user UI state is UserDefaults on the Mac (panel widths through `PersistedPanelWidth`, selected theme through `Theme`), `chrome.storage.local` in the extension. Nothing here feeds K1a.

## 6. What K1 would move (proposal)

The plan sizes ui-kit at 3 tasks, K0 to K2, no K3 or K4. Proposal, smallest first:

1. **One CSS from one source.** Make `desktop/` consume `schema/design/tokens.css` (or the same generator writes the desktop copy), delete `desktop/scripts/gen-tokens.mjs`. Gate: `make contract-gates`.
2. **A shared component spec, not shared code.** Write a short list of the 10 components that exist in both Swift and React with their props and states, and one rendered fixture per component and theme. Mac renders to a PNG through a lab, React through a headless browser; a pixel-tolerance diff replaces the five hand-checked screenshots.
3. **Shared React package** (`ui/kit/`) only when a second web surface (the extension and desktop) needs the same component, with the extension and `ui/os-view` as the first consumers. Not before.

## 7. Decisions needed from the user

Options and the recommended answer; the recommendation is mine.

| # | Question | Options | Recommended |
|---|---|---|---|
| U1 | Is `tokens.json` the only token source for every surface, including desktop? | yes, desktop reads JSON; keep desktop reading Swift | yes. The Swift file is itself generated from the JSON, so a regex over it adds a second parser and a second output for the same data. |
| U2 | One CSS file for all web surfaces, or one per surface? | one shared file; per-surface copies (today: three identical copies and one different) | per-surface copies written by the same generator are fine for bundling; the point is the one generator and one naming scheme (`--tok-*`). Retire the desktop variant. |
| U3 | Does the React component set live in `desktop/` (when it graduates), in a new `ui/kit/`, or stays per surface? | desktop; `ui/kit/`; per surface | `ui/kit/` at K3, after the Tauri app stops being a spike. Until then do not add components to `desktop/`. |
| U4 | Parity bar: pixel-diff against the Mac render, or reviewed screenshots? | pixel tolerance with a lab; screenshots | pixel tolerance on fixtures, because five reviewed PNGs do not catch a regression in a PR. |
| U5 | Should graph-kit's `web/` adopt `tokens.json`, or keep its own theme as a separate repo? | adopt through a generated file in graph-kit; keep | keep its own, but add a conformance check that its role names map onto `tokens.json` (like `conformance-memory.mjs`), because graph-kit must stay reusable. |
| U6 | Icons: SF Symbols on Mac only, or one set for all surfaces? | per platform; one open set | per platform at K1; decide with the Tauri K3 because SF Symbols cannot ship in a web view. |

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Desktop tokens drift from the Mac because they follow Swift, not the JSON | U1; generator check already in `npm run build` |
| R2 | Moving components before the spike graduates creates a second throwaway | K1 step 3 only after a real second consumer exists |
| R3 | Pixel-diff fixtures are flaky across OS font rendering | pin fonts in the fixtures; tolerance, not equality |
| R4 | Shell chrome mixed into the kit scope drags Shell-only types | keep `Shell/Chrome` out of ui-kit; kit covers `Core/DesignSystem` and tokens |

## 9. Drift, gaps and corrections to the plan's premises

1. The plan's row says "shared React components"; **none exist as a shared package**. Ten are ported by hand inside `desktop/`, and `desktop/README.md` calls the spike throwaway.
2. The plan's priority P15 "= ui-kit" is described as a blocking gate; the part that is a gate (tokens plus the drift check) is already in `make contract-gates`. What remains is component parity, which has no gate.
3. Token outputs are described as "Swift ThemeTokens and CSS". There are **four** generated CSS files from two generators with two shapes (`schema/design/tokens.css` 119 lines; `desktop/src/design/tokens.css` 151 lines).
4. The plan says the plan's open item "land the `desktop/` scaffold on `main`": it is tracked on `main` (97 files).
5. `desktop/src/design/tokens.css` is generated from `ThemeTokens.swift` (header of the file), not from `tokens.json` as `schema/design/README.md` implies for "the Tauri desktop" (it lists `tokens.css` for it).

## 10. What I could not verify

- Whether the 10 React components match their Swift twins in behaviour (only file lists and sizes were read).
- Whether the five parity screenshots are current; no app was run.
- `make contract-gates`, `swift test` and `npm run build` in `desktop/` were not run; only the two `--check` commands in section 2 were.
- The count of 152 files using `theme.current` is a grep match, not an audit of every use.

## 11. K1 outcome (2026-10-31): decisions and what shipped

The user approved ADR 0018 for Phase 3 start and delegated U1 to U6 to the recommendations above. **All six are provisional**: they stand until a K3 screen proves one wrong, and any of them can be reopened by the user.

| # | Decision (provisional) | Done in K1 |
|---|---|---|
| U1 | `tokens.json` is the only token source for every surface, desktop included | `desktop/scripts/gen-tokens.mjs` (regex over Swift) deleted; the desktop reads the kit's generated CSS. Drift gates: `node scripts/gen-design-tokens.mjs --check` in `make contract-gates`, `npm run build` and `make test-desktop-node`; the Swift gate is unchanged (same generator). |
| U2 | Per-surface CSS from the same generator, one `--tok-*` naming scheme | Fifth and sixth generator outputs: `ui/kit/src/styles/tokens.generated.css` (web variant) and `ui/kit/src/themes.generated.ts`. The three older CSS copies stay byte-identical (the committed System-view bundle embeds one). The desktop variant naming (`--body`, `--font-*`) is retired. |
| U3 | Shared React package at `ui/kit/` | `@llmide/ui-kit`: 8 components promoted from the spike (`Chip`, `EditorTabBar`, `FileTreeRow`, `LibrarySidebar`, `ResizableDivider`, `SectionChromeBar`, `SettingsSectionCard`, `StatusBanner`) plus icons and theme helpers. `AppStatusBar` stays in `desktop/` (it renders core status). The desktop consumes the kit through a Vite alias, no behaviour change. |
| U4 | Parity bar is pixel tolerance on fixtures | **Not built.** Tests today: DOM/ARIA (server render), token values per theme, contrast, no raw colours, no remote-resource sinks, alias drift vs `Theme.swift`. Pixel diff needs a headless browser plus a Mac render of each fixture; neither is a light dependency, so it is a documented follow-up (K2) and the five reviewed screenshots remain the visual evidence. |
| U5 | graph-kit keeps its own web theme; conformance check maps it onto `tokens.json` | `ui/kit/tests/tokens.test.mjs` compares graph-kit `web/src/theme.css` colour variables and theme ids with `tokens.json` (skips if the submodule is absent). It passes today. |
| U6 | One open icon set for web surfaces; SF Symbols stay Mac-only | Lucide, `lucide-static` 1.65.0 pinned, ISC, glyphs vendored (27 icons), licence in `ui/kit/LICENSES/`. Glyph shapes in the spike screens changed from the hand-drawn stand-ins. |

Findings while moving the code (R2 of section 8 held: nothing was added to the spike before the move):

1. `.ui-icon-button`, `.ui-chrome-bar`, `.ui-chrome-title` and `.ui-chrome-spacer` were used by spike components but had no base CSS. The kit now styles them (a visible change to the toolbar toggles and banner dismiss buttons).
2. The spike CSS resolved the platform text styles (callout 12 px, caption 10 px) itself; the shared generator now emits those web fallbacks in the kit CSS.
3. Light theme `textMuted` on `body` measures 4.31:1 (WCAG AA 4.5). It is a `tokens.json` value that also drives the Mac; recorded as a known gap with a regression floor in `ui/kit/tests/contrast.test.mjs`.
4. `ResizableDivider` was not keyboard operable; it is now (arrows, Home, End), and its label is a prop.

Left for K3 screens: replace the `LibrarySidebar` demo content with real data, restructure `EditorTabBar` tab semantics, scope-able themes (needs `[data-theme]` selectors, not `:root[...]`), the Mac-side fixture render for pixel parity, and wiring the relay web view and phone PWA to the kit.
