---
name: excel-diff-extractor
description: >-
  Compare two Excel (.xlsx/.xls/.xlsm) or CSV (.csv/.tsv) files or folders,
  cell-by-cell, and report differences as a bilingual (Japanese + English)
  summary plus a highlighted diff Excel. Trigger on: "compare spreadsheets",
  "check for regressions", "snapshot tests", "extract version diffs", "what
  changed between workbooks", "expected vs actual", or even without explicit
  "diff" — two similar spreadsheets plus a question about their differences is
  enough. Handles multi-sheet workbooks, Japanese encodings (UTF-8, CP932,
  Shift-JIS), float tolerance, and column-name mismatches.
---

# excel-diff-extractor

Compare two spreadsheets, surface every difference, and give the user both a
glanceable text summary and a highlighted Excel file they can share with
reviewers.

## When this skill is the right tool

Use it when the user:

- Has two Excel or CSV files and wants to know what's different between them.
- Is doing **regression testing** or **snapshot testing** against a baseline.
- Wants to **extract version diffs** — "what changed from last week's report?"
- Refers to an "expected" file and an "actual" file (or "old" and "new").
- Uploads two similar-looking spreadsheets without an explicit question —
  comparing them is almost always the implicit ask.

Don't use it for:

- Merging or reconciling files (different task — this skill only reports).
- Comparing non-tabular data (PDFs, Word docs, images).
- Diffing formulas or cell formatting — this skill compares **values**.

## What it produces

Three artifacts, every run:

1. **A bilingual Markdown summary** rendered inline in your reply. Japanese
   and English side-by-side so both reviewers can scan it without
   translation.
2. **A highlighted diff Excel** (`<actual-basename>_diff.xlsx`) saved to the
   output directory:
   - A `Summary / 概要` sheet with file info and a per-sheet status table.
   - One sheet per sheet in the actual file, with **red-filled cells**
     marking every value mismatch. The expected value is attached as a
     cell comment — hover in Excel to see it.
   - Orange fill for rows/sheets present on only one side.
3. **A `summary.md`** file saved to the output directory alongside the
   diff workbooks. Contains the same bilingual report rendered in chat,
   so reviewers can share or archive it without scrolling back through
   the session. Suppress with `--no-summary` if unwanted.

## How to run it

The skill bundles everything into one script. From the skill directory:

```bash
# Single file pair
python scripts/compare.py <expected_file> <actual_file>

# Two folders of spreadsheets (pairs files by basename)
python scripts/compare.py <expected_dir> <actual_dir>
```

### Where outputs are written

By default, diff workbooks are saved to a `compare_diff_output/` folder
created inside the **common parent directory** of `<expected>` and
`<actual>` — the "base data root." Examples:

- Comparing `/data/CaseNo581/` vs `/data/CaseNo595/` → outputs go to
  `/data/compare_diff_output/`.
- Comparing `/proj/baseline.xlsx` vs `/proj/new.xlsx` → outputs go to
  `/proj/compare_diff_output/`.

The folder is created automatically if it does not exist. Pass
`--out-dir <path>` to override.

Common options:
- `--tolerance 1e-12` for stricter numeric comparison (default `1e-6`).
- `--max-details 20` to show more cell differences per sheet in the stdout
  JSON (the highlighted Excel always contains every difference).
- `--no-diff-file` if the user only wants the summary without the Excel.
- `--no-summary` to skip writing `summary.md` into the output directory.
- `--out-name foo.xlsx` renames the single-file output; **ignored in folder
  mode** since there's one diff xlsx per pair.

### File vs folder mode

The script auto-detects based on the inputs:

- Both paths are files → single comparison, JSON shape is the original
  `{summary, diff_file, sheets}` form.
- Both paths are directories → **folder mode**. Top-level files with
  supported extensions (`.xlsx`, `.xls`, `.xlsm`, `.csv`, `.tsv`) are paired
  by basename; each pair produces its own `<basename>_diff.xlsx` in the
  output directory. Stdout JSON uses the folder shape:
  ```json
  {
    "mode": "folder",
    "files_compared": N,
    "files_identical": K,
    "files_with_diffs": M,
    "only_in_expected": [...],
    "only_in_actual": [...],
    "results": [ {file_name, diff_file, result: {summary, sheets}}, ... ]
  }
  ```
- Mixed (one file, one directory) → error, exit code 2. Ask the user to
  align the inputs.

Folder mode does **not** recurse into subdirectories — only top-level files
are paired. This is intentional: deep recursion tends to surface noise
(lockfiles, backups, `.DS_Store`) the user didn't want diffed. If nesting
matters, the user should flatten first or run the skill per sub-folder.

### Workflow

1. **Identify the two files.** If the user uploaded two spreadsheets, use
   both. If they only uploaded one and mention a baseline, ask which is
   which — order matters for the "expected vs actual" framing.
2. **Run `compare.py`.** The script reads both files, produces the highlighted
   Excel in the output directory, and prints a JSON summary to stdout.
3. **Parse the JSON** and render the bilingual Markdown summary following
   `references/output_format.md`. Use the `excel_row` field (not `row`) so
   row numbers match what users see when they open the file in Excel.
4. **Present the diff Excel** via `present_files` so the user can download it.
5. **Close with the color legend** — remind the user that red = mismatch
   (comment holds the expected value), orange = present on only one side.

### Exit codes

- `0` — all compared inputs are identical
- `1` — differences found (includes folder mode: any cell diffs OR any file
  present on only one side)
- `2` — read error, unsupported file type, or mixed file/dir inputs

A non-zero exit is **not** an error from the user's perspective. Code `1`
means the skill worked perfectly and found differences — exactly the case
they're using it for. Don't retry or apologize on exit code `1`.

## Reading the references

Two reference files in `references/`:

- **`output_format.md`** — the exact bilingual Markdown template to render
  from the JSON, with a worked example. Read this every time, because the
  template is detailed and easy to get slightly wrong.
- **`comparison_rules.md`** — the semantics of equality used by the
  comparator (float tolerance, NaN handling, column alignment, encoding
  fallback). Read this when the user questions a specific diff or asks
  "why did it report X as different?" or wants to tune the tolerance.

## Choosing the expected/actual order

"Expected" and "actual" are the baseline-vs-new framing. If the user says:

- "compare `baseline.xlsx` with `output.xlsx`" → expected=baseline, actual=output
- "did anything change from v1 to v2?" → expected=v1, actual=v2
- "regression test against `correct_data/`" → expected=correct_data/, actual=output/
- Ambiguous ("compare these two files") → ask briefly, or pick one and
  state the assumption so the user can correct you.

This matters because the diff Excel is built from the **actual** file with
expected values shown in comments. Swapping the order produces a mirror-image
report that's still correct, just oriented differently.

## Handling common surprises

- **"Every cell is different!"** — Usually means column names differ and
  the comparator stopped at the structural mismatch. Point the user to the
  column lists in the summary and suggest aligning headers before re-running.
- **"It says identical but I can see a difference!"** — Float tolerance,
  formatting-only change, or formulas evaluating to the same value.
  `references/comparison_rules.md` covers each case.
- **Encoding errors on CSV** — The script already tries UTF-8 → CP932 →
  Shift-JIS → Latin-1. If all fail, the file is truly corrupt or uses an
  unusual encoding; surface the error rather than guessing further.
- **Huge files** — The stdout JSON trims cell diffs to `--max-details` per
  sheet, but the highlighted Excel contains all of them. Tell the user the
  file is the source of truth for the full list.

## Design rationale (for maintainers)

- **Script does structured output, Claude does formatting.** The Python
  side emits JSON; the bilingual Markdown rendering lives in Claude's
  reply. This keeps the script language-agnostic and makes it easy to
  adjust the report style without touching Python.
- **Comparison is position-based, not key-based.** Automatic row/column
  matching requires guessing the key, and wrong guesses produce worse
  reports than honest positional diffs. Users who need key-based alignment
  sort their inputs first — one line of pandas.
- **Two artifacts, not one.** The Markdown is for quick scanning; the Excel
  is for sharing and drilling in. Generating only one forces the user into
  whichever workflow doesn't fit their moment.
