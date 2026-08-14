# Comparison Rules / 比較ルール

These are the semantics the comparator enforces. Knowing them matters when
diffs look surprising — they almost always trace back to one of these rules.

---

## Floating-point tolerance

Numeric values are considered equal if `abs(a - b) < tolerance`. The default
tolerance is `1e-6`, which covers IEEE-754 rounding artifacts while still
catching genuine numerical changes.

Override with `--tolerance` when:
- The user works with scientific data where smaller epsilons matter (`1e-12`).
- The user works with currency aggregated from many rows where accumulated
  error is higher (`1e-2`).
- The user explicitly wants exact equality (`0`).

---

## NaN, Inf, and missing values

- `NaN == NaN` → **equal**. This is the convention for regression testing —
  two "missing" cells in the same position are considered a match even
  though Python's `float('nan') == float('nan')` is `False`.
- `NaN` vs anything else → **different**.
- `+Inf` vs `+Inf` → **equal**; `-Inf` vs `-Inf` → **equal**.
- `+Inf` vs `-Inf` → **different**.
- `Inf` vs a finite number → **different**.

---

## Type coercion

- `int` vs `float` with the same value → **equal** (e.g., `3` vs `3.0`).
- Numeric numpy types (`np.int64`, `np.float32`, …) → coerced to Python
  `int`/`float` before comparison.
- Booleans compared with `==` (so `True == 1` → equal, matching pandas behavior).
- Strings compared exactly, including whitespace. If the user wants
  whitespace-insensitive comparison, they need to normalize beforehand.
- Timestamps compared via `==`; timezone-naive and timezone-aware timestamps
  at the same instant are **not** equal (pandas raises — we catch and mark
  different).

---

## Column ordering

Columns are compared **by position**, then validated by name.

If column names differ in any way, cell-level comparison is **skipped** for
that sheet — comparing position 2 in expected against position 2 in actual
would be meaningless when the columns represent different fields. The sheet
is still reported, flagged as a structural mismatch, and the two column
lists are included in the output so the user can see the drift.

If the user wants to align columns by name instead of position, they need to
sort both files' columns before running the comparison (one-line pandas
operation on each DataFrame).

---

## Row ordering

Rows are also compared by position. The comparator does **not** attempt to
match rows by key. Two files where the same rows appear in different order
will show many cell diffs.

If the user needs row-order-insensitive comparison, sort both files by a
stable key first. This is a deliberate design choice: automatic row matching
requires guessing the key, and wrong guesses produce confusing reports.

---

## Shape mismatches

When the row or column count differs, comparison proceeds on the overlap
(`min(rows)` × `min(cols)`). Extra rows/columns are noted in the summary
but not flagged cell-by-cell — otherwise a one-row insertion at the top
would report every subsequent row as different.

---

## CSV encoding

The comparator tries encodings in order:

1. `utf-8` — modern default.
2. `cp932` — Microsoft's Shift-JIS variant, standard for Japanese Excel exports.
3. `shift_jis` — legacy Japanese encoding.
4. `latin-1` — last-resort fallback; won't raise but may mangle characters.

The first encoding that decodes successfully wins. This matches typical
enterprise workflows where "export to CSV" produces CP932-encoded files on
Japanese Windows systems.

If both files are valid but use different encodings, the comparator still
produces the correct diff — the decoder runs per-file, so `utf-8.csv` vs
`cp932.csv` compare just fine as long as the decoded string values match.

---

## Excel gotchas

- **Formulas**: `pd.read_excel` reads evaluated values, not formula strings.
  Two files with different formulas but identical computed values will be
  reported as identical. This is usually what the user wants — they're
  comparing **data**, not spreadsheet logic.
- **Merged cells**: pandas reads the value of the top-left cell and leaves the
  rest as `NaN`. Two files that merge differently may show as equal on
  non-top-left merged positions.
- **Formatting**: Cell colors, fonts, and number formats are ignored. Only
  values are compared.
- **Hidden sheets / rows**: Read and compared like any other content.

---

## When to run the comparator twice

If the first run reports "Column names differ" for every sheet, the two files
probably have swapped conventions (e.g., English headers vs Japanese). The
cell diffs will be empty even though the data itself might match.

Fix one side's column names to match the other, then re-run.
