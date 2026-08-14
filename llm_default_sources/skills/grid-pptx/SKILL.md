---
name: grid-pptx
description: >-
  Create GRID-branded PowerPoint presentations: (1) new decks from scratch, (2)
  converting existing .pptx to GRID format. Trigger on: user asks for "slides",
  "deck", "pitch", "presentation", a ".pptx" file, "convert/re-style a
  presentation", or mentions GRID branding — even without explicit "GRID" (it is
  the default style). Template (13.33" x 7.50" widescreen) and helper code are
  bundled; no upload needed.
---

# GRID PPTX

Create GRID-branded widescreen (13.33" × 7.50") presentations in a single pass. Supports two workflows:

- **Create a new deck** — start from scratch with title, section, content, table, KPI, and custom-shape slides.
- **Convert an existing presentation** — take a `.pptx` (or other format) and reproduce its content faithfully inside the GRID template, stripping the original's page chrome.

Everything is bundled:

- `assets/template.pptx` — the GRID template (dark navy cover, white content pages, auto logo/copyright/slide number/CONFIDENTIAL badge)
- `assets/grid_helpers.py` — Python module with all layout builders, shape helpers, colors, and fonts
- `references/converting_existing.md` — deep guide for the conversion workflow (read when converting)
- `references/design_system.md` — full color palette, typography, layout coordinates (read only if the quick reference below isn't enough)

---

## Decision: which workflow?

| Situation | Workflow |
|-----------|----------|
| User asks to "make a deck about X", "pitch for Y", "5 slides on Z" | **Create new** → jump to section below |
| User uploads a `.pptx` and asks to "convert / upgrade / re-style / port / GRID-ify" it | **Convert existing** → read `references/converting_existing.md` |
| User uploads a `.pptx` and asks for *new* slides about a different topic | **Create new** (the upload is reference material, not the deck to convert) — confirm with user if unclear |

---

## Setup (always run this first)

```bash
python3 -m pip install python-pptx lxml --target /tmp/claude/pptx-build/pylibs -q
```

Then in every Python script that builds slides:

```python
import sys
sys.path.insert(0, "/tmp/claude/pptx-build/pylibs")   # python-pptx install location
sys.path.insert(0, "<ABSOLUTE_PATH_TO_SKILL>/assets") # so `import grid_helpers` works

import grid_helpers as g
g.init()   # loads the bundled template.pptx next to grid_helpers.py
```

Replace `<ABSOLUTE_PATH_TO_SKILL>` with the actual directory containing this SKILL.md (on Claude.ai, that's typically `/mnt/skills/...` — use `__file__`-style lookup or the literal path from your system).

---

## Workflow A — Create a new deck

Use `grid_helpers` slide builders. All helpers live on the module (referenced as `g.` below).

### The essential builders

| Function | Use for |
|----------|---------|
| `g.add_title_slide(title, subtitle="")` | Cover slide (dark navy + sphere). First slide only. |
| `g.add_section_slide(title, subtitle="")` | Section divider between major parts (dark navy). |
| `g.add_content_slide(title, bullets)` | Title + bullet list (white bg). |
| `g.add_blank_slide(title="")` | Title + free canvas (white bg). Use when you need custom shapes, charts, diagrams. |
| `g.add_screenshot_slide()` | Fully blank, no title (for full-bleed images). |
| `g.add_table_slide(title, headers, rows, col_widths=None, zebra=True)` | Styled table (navy header, zebra rows). |
| `g.add_two_column_slide(title, left_items, right_items, left_header="", right_header="")` | Quick two-column bullet comparison. |
| `g.add_kpi_slide(title, kpis)` | Large KPI callouts. `kpis=[{"value":"25%","label":"Growth","color":g.C.green}, ...]`. Max ~4. |

### Placing custom content on a blank slide

```python
slide = g.add_blank_slide("Architecture Overview")
g.add_shape(slide, "Frontend\nReact",     1, 2, 3, 2.5, fill_color=g.C.blue)
g.add_shape(slide, "API\nFastAPI",        5, 2, 3, 2.5, fill_color=g.C.cyan)
g.add_shape(slide, "Database\nPostgreSQL", 9, 2, 3, 2.5, fill_color=g.C.navy)
g.add_textbox(slide, "Data flows left → right", 1, 5.0, 11, 0.4, size=12, color=g.C.gray)
g.add_image(slide, "/path/to/diagram.png", 0.5, 5.5, w=12.3)
```

Coordinates are in **inches**. Slide is 13.33" wide × 7.5" tall. Safe content area below the title: roughly y=0.7" to y=7.0", x=0.5" to x=12.8". Avoid the bottom 0.4" (logo/copyright) and top-right 1.4"×0.5" (CONFIDENTIAL badge).

### Minimal working example

```python
import sys
sys.path.insert(0, "/tmp/claude/pptx-build/pylibs")
sys.path.insert(0, "<PATH_TO_SKILL>/assets")
import grid_helpers as g

g.init()
g.remove_template_slide()   # drop the template's placeholder first slide

g.add_title_slide("Project Alpha", "Q4 2026 Engineering Review")

g.add_content_slide("Agenda", [
    "Background",
    "Architecture",
    "Results",
    "Next Steps",
])

g.add_kpi_slide("Quarterly Highlights", [
    {"value": "25%", "label": "Revenue Growth", "color": g.C.green},
    {"value": "3",   "label": "New Markets",    "color": g.C.blue},
    {"value": "94%", "label": "CSAT Score",     "color": g.C.cyan},
])

g.add_table_slide("Performance Metrics",
    headers=["Metric", "Q3", "Q4", "Change"],
    rows=[
        ["Revenue", "$2.1M",  "$2.6M",  "+24%"],
        ["Users",   "12,400", "15,800", "+27%"],
        ["NPS",     "72",     "81",     "+9"],
    ],
    col_widths=[4, 2.5, 2.5, 3],
)

g.add_section_slide("Thank You", "Questions?")
g.save("/mnt/user-data/outputs/project_alpha.pptx")
```

---

## Workflow B — Convert an existing presentation

When the user provides a `.pptx` (or PDF/Keynote/etc. they want "converted" to GRID):

1. Read `references/converting_existing.md` — it has the full analysis-and-rebuild procedure.
2. The short version: analyze every shape in the source, strip the source's page chrome (full-width top/bottom bars, standalone title text shapes), then replicate the **content-area** shapes (cards, arrows, accent bars, text, colors, fonts) inside GRID's content area. The GRID template provides its own header/footer/logo automatically.
3. Preserve the original's design language inside the content area — **do not** impose GRID brand colors or card styles. Match the source's hex values, fonts, and card patterns exactly.

Do not start the conversion without reading `references/converting_existing.md`.

---

## Design system quick reference

Full details are in `references/design_system.md`. The essentials:

**Layouts** (reference as `g.L_TITLE`, `g.L_SECTION`, `g.L_TEXT`, `g.L_BLANK`, `g.L_SCREEN`):
- `0 L_TITLE` — cover, dark navy + sphere, placeholders: `ctrTitle` + `subTitle`
- `1 L_SECTION` — section divider, dark navy + sphere
- `2 L_TEXT` — white bg, title + body placeholder (use for standard bullet slides)
- `3 L_BLANK` — white bg, title only, free canvas (use with shape helpers)
- `4 L_SCREEN` — fully blank, no placeholders

**Colors** (reference as `g.C.navy`, `g.C.blue`, etc.):

| Name | Hex | Typical use |
|------|-----|-------------|
| `navy` | #1D2749 | Table headers, dark accents |
| `blue` | #2F6EBA | **Primary accent** — headers, key elements |
| `cyan` | #3093C6 | Secondary blue |
| `green` | #05AF50 | Positive / success |
| `gold` | #FFC000 | Warnings / highlights |
| `orange` | #DF762E | Emphasis |
| `red` | #F55F1D | Alerts |
| `text` | #595959 | Body text on white |
| `gray` | #ACACAC | Muted / copyright |
| `white` | #FFFFFF | Light backgrounds |
| `row_alt` | #F2F2F2 | Table zebra striping |

**Fonts** (reference as `g.F.heading`, `g.F.body`, etc.):
- `heading` = Yu Gothic (titles/headers, 20–44pt)
- `body` = Calibri (body text, 12–16pt)
- `shape` = Meiryo UI (shape labels, ~12pt)
- `mono` = Consolas (code)

Japanese text renders correctly when `font=` is passed — `style()` auto-applies East Asian font metadata.

---

## Important rules

1. **Always call `g.remove_template_slide()` before adding slides.** The template ships with one blank placeholder slide that must be removed first, otherwise it appears at the top of the output.
2. **Do not manually add logo, copyright, slide number, or CONFIDENTIAL badge** — those are baked into the layouts and appear automatically.
3. **Output file location:** save to `/mnt/user-data/outputs/<name>.pptx` so it can be presented to the user via `present_files`.
4. **If the copyright year needs updating** from 2022 to the current year, call `g.update_copyright_year(2026)` *before* adding any slides.
5. **Slide width is 13.33"**, not the standard 10". Coordinates must account for this.
6. **Do not guess the skill path.** When writing the build script, use the actual path where this SKILL.md lives (e.g. whatever `/mnt/skills/...` or local path it's installed at). Look it up rather than assuming.
7. **Present the final file** using the `present_files` tool so the user can download it.

---

## When things go wrong

- **"Repair warning" when opening the output in PowerPoint** — you forgot `g.remove_template_slide()`, or you tried to remove the template slide by just popping from `_sldIdLst` without dropping the relationship. Use the bundled helper.
- **Japanese characters render in Calibri instead of the intended font** — you set `run.font.name` directly instead of using `g.style(run, font=...)`. The helper handles East Asian font metadata; a bare `.name =` does not.
- **Content runs off the right edge of the slide** — you're using 10"-wide coordinates. GRID is 13.33" wide.
- **Shapes land on top of the CONFIDENTIAL badge or logo** — avoid the keep-out zones (bottom 0.4", top-right 1.4"×0.5").
