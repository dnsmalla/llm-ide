# Converting an Existing Presentation to GRID

When the user provides a `.pptx` (or asks to port a deck from another tool) to "upgrade", "convert", "re-style", or "GRID-ify", the goal is **faithful reproduction of the content and card styling** inside the GRID template — but **replacing the original's page chrome** with GRID's.

## The critical rule: strip chrome, preserve content-area design

The source deck likely has its own decorative chrome (top bars, bottom bars, standalone title text shapes, branded footers). These **must NOT be carried over** — the GRID template provides its own.

| Original element | Action | GRID replacement |
|------------------|--------|------------------|
| Colored top bar (full-width, thin) | **REMOVE** | GRID template's header area |
| Navy/dark bottom bar (full-width) | **REMOVE** | GRID logo + copyright + slide number |
| Title as a standalone text shape | **REMOVE** | Use `slide.placeholders[0].text = "..."` on a `L_BLANK` / `L_TEXT` layout |
| Title/closing slides with custom dark background | **REMOVE** | Use `L_TITLE` (layout 0) or `L_SECTION` (layout 1) — they already have dark backgrounds and the wireframe sphere |
| Full-slide background images/colors for non-cover slides | **REMOVE** | GRID content layouts are white — use that |

Everything **inside** the original's content area — cards, accent bars, arrows, icons, text blocks, colors, fonts — should be **faithfully preserved**. Do *not* force GRID brand colors onto the content. Match the source's hex values exactly.

---

## Step 1: Analyze the source

Before writing any build code, extract the source's full design system. Run this analysis script against the uploaded file:

```python
import sys
sys.path.insert(0, "/tmp/claude/pptx-build/pylibs")

from pptx import Presentation
from pptx.util import Emu

SOURCE = "/mnt/user-data/uploads/source.pptx"
prs = Presentation(SOURCE)
src_w = prs.slide_width / 914400   # slide width in inches
src_h = prs.slide_height / 914400

print(f"Source slide size: {src_w:.2f}\" x {src_h:.2f}\"")

for i, slide in enumerate(prs.slides):
    print(f"\n=== Slide {i+1} ===")
    for j, shape in enumerate(slide.shapes):
        x = shape.left / 914400
        y = shape.top / 914400
        w = shape.width / 914400
        h = shape.height / 914400
        print(f"  [{j}] {shape.name} ({shape.shape_type})")
        print(f"       pos: x={x:.2f} y={y:.2f} w={w:.2f} h={h:.2f}")
        if hasattr(shape, 'fill'):
            try:
                if shape.fill.type is not None:
                    print(f"       fill: {shape.fill.type}, color=#{shape.fill.fore_color.rgb}")
            except Exception:
                pass
        if shape.has_text_frame:
            for p in shape.text_frame.paragraphs:
                txt = p.text.strip()
                if txt and p.runs:
                    r = p.runs[0]
                    fs = Emu(r.font.size).pt if r.font.size else "?"
                    color = r.font.color.rgb if r.font.color and r.font.color.rgb else "?"
                    print(f"       text: \"{txt[:60]}\" [font={r.font.name}, {fs}pt, bold={r.font.bold}, color={color}]")
```

Record these from the output:

| What to extract | Why |
|-----------------|-----|
| Slide dimensions (`src_w`, `src_h`) | Needed for coordinate scaling |
| Full color palette (all fill + text colors) | Must reuse exact same hex values |
| Card/box style (solid fill? light bg + colored top border? rounded? left accent bar?) | Must replicate card pattern |
| Font names, sizes, bold/italic per element | Must match typography exactly |
| Arrow style (shape arrows vs text `▶`/`▼` characters?) | Must use same approach |
| Decorative elements (divider lines, accent bars on cards) | Reproduce **card-level** accents; skip **page-level** chrome |
| Layout pattern per slide (column count, card placement) | Must preserve spatial arrangement |

Classify each source shape as either **chrome** (page-level decoration to strip) or **content** (to reproduce). Typical chrome markers:
- Full-width shape touching left and right edges
- Very thin height (< 0.1") spanning full width
- Positioned at the very top (y < 0.15") or very bottom (y > src_h - 0.4")
- Standalone title text that duplicates what GRID's placeholder would carry

---

## Step 2: Coordinate scaling

Standard presentations are often 10.00" × 5.63" or 13.33" × 7.50". GRID is 13.33" × 7.50". Scale horizontally by width ratio; scale vertically to map the source's content area (between the bars) to GRID's safe area:

```python
# Horizontal: simple ratio
GRID_W = 13.33
SX = GRID_W / src_w

def sx(x_orig): return x_orig * SX
def sw(w_orig): return w_orig * SX

# Vertical: map content-area (between chrome bars) to GRID safe area (below title, above footer)
# Typical source content area runs from y≈0.10" to y≈5.33" (for 10x5.63 slides).
# Measure from your analysis output; adjust these two constants accordingly.
ORIG_Y_MIN, ORIG_Y_MAX = 0.10, 5.33
GRID_Y_MIN, GRID_Y_MAX = 0.75, 7.0
SY = (GRID_Y_MAX - GRID_Y_MIN) / (ORIG_Y_MAX - ORIG_Y_MIN)

def sy(y_orig): return GRID_Y_MIN + (y_orig - ORIG_Y_MIN) * SY
def sh(h_orig): return h_orig * SY
```

Apply `sx()`/`sy()`/`sw()`/`sh()` to every **content** shape. Skip chrome entirely.

---

## Step 3: Preserve the original's design language

Reproduce the source's patterns exactly — do not substitute GRID-brand equivalents:

| Source pattern | Reproduce as |
|----------------|--------------|
| Light card bg (e.g. `#E8EDF5`) + thin colored top border (e.g. `#3B82F6`, ~0.06" tall) | `g.add_card_with_top_border(slide, x, y, w, h, border_color=RGBColor(0x3B,0x82,0xF6))` |
| Light card + colored left accent bar | `g.add_card_with_left_bar(slide, x, y, w, h, bar_color=...)` |
| Text arrows (`▶`, `▼` as characters) | `g.add_text_arrow(slide, "▶", x, y, w, h, size=..., color=...)` |
| Shape arrows (MSO right-arrow, left-arrow, chevron) | `g.add_shape(slide, "", x, y, w, h, fill_color=..., shape_type=MSO_SHAPE.RIGHT_ARROW)` |
| Dark bar *within* content area (summary/CTA bar) | `g.add_shape` with the original fill color — only if it's a content element, NOT page chrome |
| Numbered circles | `g.add_shape(..., shape_type=MSO_SHAPE.OVAL, fill_color=...)` with the number as text |
| Transparent text over colored background | `g.add_textbox(slide, ..., color=...)` — no fill |

---

## Step 4: Build the new deck slide-by-slide

General pattern:

```python
import sys
sys.path.insert(0, "/tmp/claude/pptx-build/pylibs")
sys.path.insert(0, "<PATH_TO_SKILL>/assets")
import grid_helpers as g

g.init()
g.remove_template_slide()

# For each source slide, decide the GRID layout:
#   - First slide (cover-style) → g.add_title_slide(...)
#   - Section dividers          → g.add_section_slide(...)
#   - Last slide (thank-you)    → g.add_section_slide(...)
#   - Everything else           → g.add_blank_slide(title) + manual shape placement

for src_slide in source.slides:
    # 1. Extract title text from the source's title shape(s) — usually the first large text near the top.
    # 2. Create a GRID blank slide with that title.
    # 3. For each non-chrome content shape in src_slide:
    #    - Scale coords with sx/sy/sw/sh
    #    - Reproduce using g.add_shape / g.add_textbox / g.add_card_with_* with the ORIGINAL colors and fonts
```

---

## Step 5: Verify fidelity

After generating, do a shape-count sanity check:

```python
from pptx import Presentation
orig = Presentation(SOURCE)
grid = Presentation("/mnt/user-data/outputs/converted.pptx")

for i in range(min(len(orig.slides), len(grid.slides))):
    o = len(orig.slides[i].shapes)
    gcount = len(grid.slides[i].shapes)
    # GRID adds a few auto elements, original has chrome we stripped — expect small deltas
    delta = gcount - o
    flag = "OK" if -3 <= delta <= 3 else "CHECK"
    print(f"Slide {i+1}: orig={o} shapes, grid={gcount} shapes (delta={delta:+d}) {flag}")
```

A CHECK means the slide either lost content shapes (missing reproduction) or gained too many (likely reproduced chrome you should have stripped). Inspect and fix.

---

## Pre-flight checklist

Before declaring the conversion complete:

- Every content shape from the original has a corresponding shape in the output (scaled)
- Same card style as original (light bg + accent border, not solid colored blocks — unless the original used solid blocks)
- Exact same hex values from the original (no GRID brand color substitution in the content area)
- Matching font names, sizes, and weights
- Same arrow style (text `▶`/`▼` if original used characters; shape arrows if original used MSO shapes)
- Card-level accents preserved (top borders, left bars, numbered circles)
- Page-level chrome removed (full-width bars, standalone title shapes, custom backgrounds on non-cover slides)
- First slide uses `L_TITLE` (layout 0); section dividers and thank-you slides use `L_SECTION` (layout 1)
- Content slides use `L_BLANK` (layout 3) for free positioning
- `g.remove_template_slide()` was called
- Saved to `/mnt/user-data/outputs/` and presented via `present_files`
