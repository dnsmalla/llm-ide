# Output Format / 出力フォーマット

This skill produces **two artifacts** per comparison:

1. A **bilingual Markdown summary** rendered inline in the chat reply.
2. A **highlighted diff Excel file** (`<actual-basename>_diff.xlsx`) saved to
   the output directory and presented via `present_files`.

The script (`compare.py`) emits a JSON summary to stdout — Claude parses it
and formats the Markdown reply using the template below.

---

## Markdown summary template

Use this layout. Keep bilingual headings exactly as shown — users scan for
them. Values (file paths, numbers, cell coordinates) do not need translation.

```markdown
# Comparison Report / 比較レポート

- **Expected / 期待値:** `<expected_path>`
- **Actual / 実際値:** `<actual_path>`
- **Status / ステータス:** <status_line>

## Summary / 概要
- Sheets compared / 比較シート数: **<n>**
- Total cell differences / セル差分合計: **<n>**
- Float tolerance / 浮動小数点許容誤差: `<tolerance>`

## Details / 詳細

### Sheet: `<name>`
<per-sheet block>

...
```

### Status line rules

| JSON `is_identical` | Render as |
|----|----|
| `true`  | `✓ Identical / 一致` |
| `false` | `✗ Differences found / 差分あり (<total_cell_differences> cell diff(s) / セル差分)` |
| `read_error` is set | `⚠ Read error / 読み込みエラー: <read_error>` |

### Per-sheet block rules

For each entry in `sheets`:

- If `missing_in_actual` is true:
  ```
  - **Only in expected / 期待値のみ存在** — sheet not present in actual file
  ```
- If `missing_in_expected` is true:
  ```
  - **Only in actual / 実データのみ存在** — sheet not present in expected file
  ```
- If `read_error` is set:
  ```
  - ⚠ Read error / 読み込みエラー: <read_error>
  ```
- Otherwise, render any of the following that apply:
  ```
  - Shape / サイズ: expected `<expected_shape>` vs actual `<actual_shape>`
  - Columns differ / 列名不一致: ...(list)
  - Cell differences / セル差分: **N** (showing first <k>)
    - Row <excel_row>, Col `<column>` | expected: `<expected_value>` | actual: `<actual_value>`
    - ...
    - *(... and <cell_differences_omitted> more / 他 <cell_differences_omitted> 件)*
  ```

Use `excel_row` (not `row`) when quoting a row number so it matches what users
see in Excel — the JSON includes both for convenience.

### Closing line

End the reply with a short pointer to the highlighted Excel, for example:

```
📄 Highlighted diff saved / 差分ハイライトファイル: `<basename>_diff.xlsx`
Red cells mark value mismatches; hover to see the expected value.
赤セルは値の不一致を示します（コメントに期待値が記載されています）。
```

---

## Highlighted Excel conventions

The `_diff.xlsx` file contains:

- **`Summary_概要`** (first sheet) — file info, per-sheet status table.
- **One sheet per sheet in the actual file** — full content rendered, with:
  - **Red fill** (`#FFC7CE`) on every cell whose value differs from expected.
    The expected value is attached as a cell comment.
  - **Orange fill** (`#FFD8A8`) marking rows/sheets that exist only on one side.
  - **Yellow fill** (`#FFF2CC`) marking structural issues (shape / column
    name mismatches) in the summary table.
- The first row of every content sheet is frozen for scrolling.

When presenting the file, tell the user the color legend so they can navigate
it without re-reading this reference.

---

## Worked example

**JSON from compare.py** (abbreviated):

```json
{
  "summary": {
    "expected_path": "baseline/orders.xlsx",
    "actual_path": "output/orders.xlsx",
    "is_identical": false,
    "total_cell_differences": 3,
    "sheet_count": 2,
    "tolerance": 1e-06
  },
  "diff_file": "/mnt/user-data/outputs/orders_diff.xlsx",
  "sheets": [
    {
      "sheet_name": "Orders",
      "expected_shape": [100, 5],
      "actual_shape": [100, 5],
      "cell_difference_count": 3,
      "cell_differences_shown": [
        {"excel_row": 4, "column": "Price", "expected_value": 100.0, "actual_value": 105.0},
        {"excel_row": 7, "column": "Qty",   "expected_value": 3,     "actual_value": 4}
      ],
      "cell_differences_omitted": 1
    },
    {
      "sheet_name": "Summary",
      "missing_in_actual": true
    }
  ]
}
```

**Rendered Markdown:**

```markdown
# Comparison Report / 比較レポート

- **Expected / 期待値:** `baseline/orders.xlsx`
- **Actual / 実際値:** `output/orders.xlsx`
- **Status / ステータス:** ✗ Differences found / 差分あり (3 cell diff(s) / セル差分)

## Summary / 概要
- Sheets compared / 比較シート数: **2**
- Total cell differences / セル差分合計: **3**
- Float tolerance / 浮動小数点許容誤差: `1e-06`

## Details / 詳細

### Sheet: `Orders`
- Cell differences / セル差分: **3** (showing first 2)
  - Row 4, Col `Price` | expected: `100.0` | actual: `105.0`
  - Row 7, Col `Qty` | expected: `3` | actual: `4`
  - *(... and 1 more / 他 1 件)*

### Sheet: `Summary`
- **Only in expected / 期待値のみ存在** — sheet not present in actual file

📄 Highlighted diff / 差分ハイライト: `orders_diff.xlsx`
Red cells mark value mismatches; hover to see the expected value.
赤セルは値の不一致を示します（コメントに期待値が記載されています）。
```
