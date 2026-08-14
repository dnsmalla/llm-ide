# GRID Design System — Full Reference

Load this file only when you need exact placeholder coordinates, the full layout spec, or detailed typography/color guidance beyond what's in SKILL.md.

## Slide dimensions

- Width: **13.33"** (widescreen 16:9, wider than the legacy 10" PowerPoint default)
- Height: **7.50"**

---

## Layout inventory

| Idx | Helper alias | Name | Background | Placeholders | Typical use |
|:---:|:-------------|:-----|:-----------|:-------------|:------------|
| 0 | `L_TITLE` | Title (cover) | Dark navy #1A274F + wireframe sphere image | `ctrTitle` + `subTitle` | First slide of deck |
| 1 | `L_SECTION` | Section Title | Dark navy #1A274F + wireframe sphere image | `ctrTitle` + `subTitle` | Part dividers, thank-you slide |
| 2 | `L_TEXT` | Contents Text | White | `title` + `body` | Standard bullet-list slides |
| 3 | `L_BLANK` | Contents Blank | White | `title` only (no body) | Custom layouts with shapes, diagrams, charts |
| 4 | `L_SCREEN` | Screen Shot | White | (none) | Full-bleed images or screenshots |

### Placeholder coordinates

| Layout | Placeholder 0 (title) | Placeholder 1 (subtitle/body) |
|--------|-----------------------|-------------------------------|
| 0 Title | `ctrTitle` x=1.67" y=2.61" w=10.00" h=2.37" | `subTitle` x=1.67" y=5.13" w=10.00" h=0.54" |
| 1 Section | `ctrTitle` x=1.21" y=3.13" w=10.90" h=0.75" | `subTitle` x=1.21" y=3.97" w=10.92" h=0.54" |
| 2 Text | `title` x=0.13" y=0.21" w=10.84" h=0.45" | `body` x=0.47" y=0.70" w=12.40" h=6.27" |
| 3 Blank | `title` x=0.13" y=0.21" w=10.84" h=0.45" | — |
| 4 Screen | — | — |

### Safe content areas

| Layout | Safe x-range | Safe y-range |
|--------|--------------|--------------|
| 0 / 1 (dark) | centered, x 1.5"–11.8" | 2.0"–5.0" (Title) / 3.0"–4.5" (Section) |
| 2 / 3 (white) | 0.5"–12.8" | 0.7"–6.9" |
| 4 (screen) | 0"–13.33" | 0"–7.1" (avoid bottom 0.4") |

### Auto-included chrome (do not add manually)

Present on every layout:

- GRID logo at bottom-left, x=0.17" y=7.24"
- "© 2022 GRID Inc." at bottom-center, Calibri 10pt gray (use `update_copyright_year()` to change the year)
- Slide number at bottom-right, Calibri 10pt bold
- CONFIDENTIAL badge at top-right, x=11.94" y=0.19"

### Keep-out zones

- Bottom strip: y > 7.1" (logo + copyright + slide number)
- Top-right: x > 11.9", y < 0.7" (CONFIDENTIAL badge, 1.4" × 0.5")

---

## Color palette (GRID2026 theme)

All colors accessible as `g.C.<name>`:

| Role | Name | Hex | Typical usage |
|------|------|-----|---------------|
| Dark 1 | `text` | #595959 | Body text on white backgrounds |
| Light 1 | `white` | #FFFFFF | White / light fills |
| Dark 2 | `navy` | #1D2749 | Table headers, dark content accents |
| (bg) | `dark_navy` | #1A274F | Cover / section background (already applied by layout) |
| Light 2 | `gray` | #ACACAC | Muted text, copyright, subtle elements |
| Accent 1 | `blue` | #2F6EBA | **Primary brand blue** — headers, key elements |
| Accent 2 | `cyan` | #3093C6 | Secondary blue |
| Accent 3 | `green` | #05AF50 | Positive / success |
| Accent 4 | `gold` | #FFC000 | Warnings, highlights |
| Accent 5 | `orange` | #DF762E | Emphasis |
| Accent 6 | `red` | #F55F1D | Alerts |
| — | `black` | #000000 | Rarely — prefer `text` for body |
| Hyperlink | `link` | #0563C1 | Hyperlink blue |
| Table zebra | `row_alt` | #F2F2F2 | Alternate table row background |

---

## Typography

All fonts accessible as `g.F.<name>`:

| Element | Font | Size | Notes |
|---------|------|------|-------|
| Headings / titles | `heading` = Yu Gothic (游ゴシック) | 36–44pt (cover), 20–24pt (section), 20–24pt (slide title) | Slide titles and major headers |
| Body text | `body` = Calibri | 12–16pt | Default for bullets, descriptions |
| Shape labels | `shape` = Meiryo UI | 12pt | Default in template shapes |
| Code / technical | `mono` = Consolas | 10–12pt | Code snippets, technical labels |
| Copyright | Calibri | 10pt, gray | Bottom center (automatic) |
| Slide number | Calibri | 10pt, bold | Bottom right (automatic) |

### Japanese text rendering

The `style()` helper automatically sets `a:ea` and `a:cs` font metadata when you pass `font=`, ensuring Japanese characters render with the specified font. Setting `run.font.name` directly is **not** sufficient — it only sets the Latin typeface and Japanese characters fall back to Calibri.

Always use:

```python
g.style(run, font=g.F.heading)   # sets latin + ea + cs
```

Not:

```python
run.font.name = g.F.heading   # only sets latin; JP will fall back
```

---

## Layout-specific notes

### Layout 0 — Title (cover)
- Background: dark navy `#1A274F` solid fill + wireframe sphere image (full-bleed)
- GRID full logo at bottom center: x=5.76" y=5.82" w=2.09" (appears automatically)
- Tagline: "INFRASTRUCTURE + LIFE + INNOVATION" — Calibri, centered, x=3.17" y=2.07" (automatic)

### Layout 1 — Section Title
- Same dark navy + sphere as layout 0
- Footer (copyright, slide number, CONFIDENTIAL badge) present

### Layout 2 — Contents Text
- White background
- Title anchored top-left full-width
- Body placeholder fills most of the slide below the title

### Layout 3 — Contents Blank
- White background
- Title only — free canvas below for custom shape layouts

### Layout 4 — Screen Shot
- White background
- Completely empty — no placeholders — ideal for full-bleed images
