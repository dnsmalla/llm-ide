"""Render the bilingual (Japanese + English) Markdown summary for a diff run.

The same data that goes into the stdout JSON is turned into a `summary.md`
file saved alongside the highlighted diff workbooks. Format follows
`references/output_format.md`.
"""
from __future__ import annotations

from pathlib import Path


def _status_line_single(summary: dict) -> str:
    if summary.get("read_error"):
        return f"⚠ Read error / 読み込みエラー: {summary['read_error']}"
    if summary.get("is_identical"):
        return "✓ Identical / 一致"
    n = summary.get("total_cell_differences", 0)
    return f"✗ Differences found / 差分あり ({n} cell diff(s) / セル差分)"


def _render_sheet_block(sheet: dict) -> list[str]:
    name = sheet.get("sheet_name", "")
    lines = [f"### Sheet: `{name}`"]

    if sheet.get("missing_in_actual"):
        lines.append(
            "- **Only in expected / 期待値のみ存在** — sheet not present in actual file"
        )
        return lines
    if sheet.get("missing_in_expected"):
        lines.append(
            "- **Only in actual / 実データのみ存在** — sheet not present in expected file"
        )
        return lines
    if sheet.get("read_error"):
        lines.append(f"- ⚠ Read error / 読み込みエラー: {sheet['read_error']}")
        return lines

    es = sheet.get("expected_shape")
    as_ = sheet.get("actual_shape")
    if es and as_ and es != as_:
        lines.append(f"- Shape / サイズ: expected `{es}` vs actual `{as_}`")

    col_diffs = sheet.get("column_differences")
    if col_diffs:
        lines.append(f"- Columns differ / 列名不一致: `{col_diffs}`")

    count = sheet.get("cell_difference_count", 0)
    shown = sheet.get("cell_differences_shown", []) or []
    omitted = sheet.get("cell_differences_omitted", 0)
    if count > 0:
        lines.append(
            f"- Cell differences / セル差分: **{count}** (showing first {len(shown)})"
        )
        for cd in shown:
            row = cd.get("excel_row", cd.get("row", "?"))
            col = cd.get("column", "")
            exp = cd.get("expected_value")
            act = cd.get("actual_value")
            lines.append(
                f"  - Row {row}, Col `{col}` | expected: `{exp}` | actual: `{act}`"
            )
        if omitted:
            lines.append(f"  - *(... and {omitted} more / 他 {omitted} 件)*")

    if not lines[1:]:
        lines.append("- ✓ Identical / 一致")
    return lines


def render_single_markdown(payload: dict) -> str:
    """Render the summary for a single expected/actual file pair."""
    s = payload["summary"]
    lines = [
        "# Comparison Report / 比較レポート",
        "",
        f"- **Expected / 期待値:** `{s['expected_path']}`",
        f"- **Actual / 実際値:** `{s['actual_path']}`",
        f"- **Status / ステータス:** {_status_line_single(s)}",
        "",
        "## Summary / 概要",
        f"- Sheets compared / 比較シート数: **{s.get('sheet_count', 0)}**",
        f"- Total cell differences / セル差分合計: **{s.get('total_cell_differences', 0)}**",
        f"- Float tolerance / 浮動小数点許容誤差: `{s.get('tolerance')}`",
        "",
        "## Details / 詳細",
        "",
    ]
    for sheet in payload.get("sheets", []):
        lines.extend(_render_sheet_block(sheet))
        lines.append("")

    diff_file = payload.get("diff_file")
    if diff_file:
        basename = Path(diff_file).name
        lines.extend(
            [
                "---",
                "",
                f"📄 Highlighted diff / 差分ハイライト: `{basename}`",
                "Red cells mark value mismatches; hover to see the expected value.",
                "赤セルは値の不一致を示します（コメントに期待値が記載されています）。",
            ]
        )
    return "\n".join(lines) + "\n"


def _folder_status_line(payload: dict) -> str:
    files_compared = payload.get("files_compared", 0)
    files_identical = payload.get("files_identical", 0)
    files_with_diffs = payload.get("files_with_diffs", 0)
    files_with_errors = payload.get("files_with_errors", 0)
    only_expected = payload.get("only_in_expected", []) or []
    only_actual = payload.get("only_in_actual", []) or []

    if files_with_errors:
        return f"⚠ Read errors / 読み込みエラー: {files_with_errors}"
    if not (files_with_diffs or only_expected or only_actual):
        return (
            "✓ All paired files identical / 対応ファイルはすべて一致 "
            f"({files_identical}/{files_compared})"
        )
    bits: list[str] = []
    if files_with_diffs:
        bits.append(f"{files_with_diffs} file(s) with cell diffs / セル差分あり")
    if only_expected:
        bits.append(f"{len(only_expected)} only in expected / 期待値のみ")
    if only_actual:
        bits.append(f"{len(only_actual)} only in actual / 実データのみ")
    return f"✗ Differences found / 差分あり ({'; '.join(bits)})"


def render_folder_markdown(payload: dict) -> str:
    """Render the aggregate summary for a folder-vs-folder comparison."""
    lines = [
        "# Comparison Report / 比較レポート",
        "",
        f"- **Expected dir / 期待値ディレクトリ:** `{payload['expected_dir']}`",
        f"- **Actual dir / 実際値ディレクトリ:** `{payload['actual_dir']}`",
        f"- **Status / ステータス:** {_folder_status_line(payload)}",
        "",
        "## Summary / 概要",
        f"- Files paired / 対応ファイル数: **{payload.get('files_compared', 0)}**",
        f"- Files identical / 一致ファイル数: **{payload.get('files_identical', 0)}**",
        f"- Files with diffs / 差分ありファイル数: **{payload.get('files_with_diffs', 0)}**",
        f"- Only in expected / 期待値のみ: **{len(payload.get('only_in_expected', []) or [])}**",
        f"- Only in actual / 実データのみ: **{len(payload.get('only_in_actual', []) or [])}**",
        "",
    ]

    results = payload.get("results", []) or []
    if results:
        lines.extend(
            [
                "## Paired files / 対応済みファイル",
                "",
                "| # | File / ファイル | Status / 結果 | Cell diffs / セル差分 |",
                "|---|---|---|---|",
            ]
        )
        for i, r in enumerate(results, 1):
            s = r["result"]["summary"]
            fname = r["file_name"]
            if s.get("read_error"):
                st, n = f"⚠ {s['read_error']}", "-"
            elif s.get("is_identical"):
                st, n = "✓ Identical / 一致", "0"
            else:
                st, n = "✗ Differs / 差分あり", str(s.get("total_cell_differences", 0))
            lines.append(f"| {i} | `{fname}` | {st} | {n} |")
        lines.append("")

    only_expected = payload.get("only_in_expected", []) or []
    if only_expected:
        lines.append("## Only in expected / 期待値のみ存在")
        lines.append("")
        for f in only_expected:
            lines.append(f"- `{f}`")
        lines.append("")

    only_actual = payload.get("only_in_actual", []) or []
    if only_actual:
        lines.append("## Only in actual / 実データのみ存在")
        lines.append("")
        for f in only_actual:
            lines.append(f"- `{f}`")
        lines.append("")

    # Per-file drill-down only for files that actually have diffs or errors.
    detailed = [
        r
        for r in results
        if not r["result"]["summary"].get("is_identical")
        or r["result"]["summary"].get("read_error")
    ]
    if detailed:
        lines.extend(["## Details per file / ファイル別詳細", ""])
        for r in detailed:
            lines.append(f"### `{r['file_name']}`")
            lines.append("")
            for sheet in r["result"].get("sheets", []):
                lines.extend(_render_sheet_block(sheet))
                lines.append("")

    lines.extend(
        [
            "---",
            "",
            "🟥 Red = value mismatch (expected value in comment) / 値の不一致（コメントに期待値）",
            "🟧 Orange = only on one side / 片側のみ",
            "🟨 Yellow = shape/column mismatch / 形状・列名不一致",
        ]
    )
    return "\n".join(lines) + "\n"


def render_markdown(payload: dict) -> str:
    """Dispatch on payload shape: folder mode has `mode == 'folder'`."""
    if payload.get("mode") == "folder":
        return render_folder_markdown(payload)
    return render_single_markdown(payload)
