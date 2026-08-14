"""CLI entry point for excel-diff-extractor.

Compares two inputs and:
1. Writes a highlighted diff Excel (one per file pair) to the output directory.
2. Prints a JSON summary to stdout — the caller (Claude) parses this to
   render the bilingual Markdown report in chat.

Inputs can be either:
- Two files (Excel or CSV) — single comparison, JSON shape unchanged.
- Two directories — pairs files by basename, runs comparisons in a loop,
  and emits an aggregated JSON with a per-file `results` list.

Usage:
    python compare.py <expected> <actual> \
        [--out-dir <dir>]            # default: <common-parent>/compare_diff_output
        [--tolerance 1e-6] \
        [--max-details 10]

Exit codes:
    0 = all compared files are identical
    1 = at least one difference found (or folder has unmatched files)
    2 = read error / unsupported / mixed file+dir inputs
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

DEFAULT_OUT_SUBDIR = "compare_diff_output"

# Make sibling modules importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from comparator import (  # noqa: E402
    CSV_EXTENSIONS,
    DEFAULT_FLOAT_TOLERANCE,
    EXCEL_EXTENSIONS,
    DiffResult,
    ExcelComparator,
)
from highlight_writer import HighlightedDiffWriter  # noqa: E402
from summary_writer import render_markdown  # noqa: E402

SUPPORTED_EXTENSIONS = EXCEL_EXTENSIONS | CSV_EXTENSIONS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("excel-diff-extractor")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Compare two Excel or CSV files and produce a bilingual summary "
            "plus a highlighted diff Excel."
        ),
    )
    p.add_argument("expected", type=Path, help="Path to the expected (baseline) file")
    p.add_argument("actual", type=Path, help="Path to the actual (new) file")
    p.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help=(
            "Directory for the highlighted diff Excel. "
            f"Default: <common-parent-of-inputs>/{DEFAULT_OUT_SUBDIR}"
        ),
    )
    p.add_argument(
        "--out-name",
        type=str,
        default=None,
        help="Override the name of the diff Excel. Default: <actual-basename>_diff.xlsx",
    )
    p.add_argument(
        "--tolerance",
        type=float,
        default=DEFAULT_FLOAT_TOLERANCE,
        help=f"Float tolerance for numeric comparison (default: {DEFAULT_FLOAT_TOLERANCE})",
    )
    p.add_argument(
        "--max-details",
        type=int,
        default=10,
        help="Max cell differences per sheet to include in the stdout JSON (default: 10). "
        "The highlighted Excel always contains every difference.",
    )
    p.add_argument(
        "--no-diff-file",
        action="store_true",
        help="Skip writing the highlighted Excel; only emit the JSON summary.",
    )
    p.add_argument(
        "--no-summary",
        action="store_true",
        help="Skip writing summary.md into the output directory.",
    )
    return p.parse_args(argv)


def build_stdout_payload(
    result: DiffResult, diff_file: Path | None, max_details: int
) -> dict:
    """Trim the full result for stdout. The highlighted Excel has the complete record."""
    full = result.to_dict()
    for sheet in full["sheet_diffs"]:
        diffs = sheet["cell_differences"]
        sheet["cell_differences_shown"] = diffs[:max_details]
        sheet["cell_differences_omitted"] = max(0, len(diffs) - max_details)
        # Don't repeat the full list — callers can re-run with --max-details to get more.
        del sheet["cell_differences"]
    return {
        "summary": {
            "expected_path": full["expected_path"],
            "actual_path": full["actual_path"],
            "file_type": full["file_type"],
            "tolerance": full["tolerance"],
            "is_identical": full["is_identical"],
            "total_cell_differences": full["total_cell_differences"],
            "sheet_count": full["sheet_count"],
            "read_error": full["read_error"],
        },
        "diff_file": str(diff_file) if diff_file else None,
        "sheets": full["sheet_diffs"],
    }


def _run_single_pair(
    expected: Path,
    actual: Path,
    out_dir: Path,
    out_name: str | None,
    tolerance: float,
    max_details: int,
    write_diff_file: bool,
) -> tuple[dict, DiffResult, Path | None]:
    """Compare one expected/actual pair. Returns (stdout_payload, result, diff_file)."""
    comparator = ExcelComparator(float_tolerance=tolerance)
    result = comparator.compare(expected, actual)

    diff_file: Path | None = None
    if write_diff_file and result.file_type != "unsupported":
        name = out_name or f"{actual.stem}_diff.xlsx"
        diff_file = out_dir / name
        try:
            HighlightedDiffWriter(result).write(diff_file)
        except Exception as e:
            logger.error("Failed to write highlighted diff Excel for %s: %s", actual, e)
            diff_file = None

    payload = build_stdout_payload(result, diff_file, max_details)
    return payload, result, diff_file


def _list_supported_files(directory: Path) -> dict[str, Path]:
    """Return {basename: path} for files with supported extensions in `directory`.

    Only top-level files are considered — we don't recurse, to avoid surprising
    the user with deeply nested diffs they didn't expect.
    """
    mapping: dict[str, Path] = {}
    for p in sorted(directory.iterdir()):
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS:
            mapping[p.name] = p
    return mapping


def _run_folder_pair(
    expected_dir: Path,
    actual_dir: Path,
    out_dir: Path,
    tolerance: float,
    max_details: int,
    write_diff_file: bool,
) -> tuple[dict, int]:
    """Pair files by basename across two directories, run comparator on each.

    Returns (stdout_payload, exit_code).
    """
    expected_files = _list_supported_files(expected_dir)
    actual_files = _list_supported_files(actual_dir)

    common = sorted(set(expected_files) & set(actual_files))
    only_in_expected = sorted(set(expected_files) - set(actual_files))
    only_in_actual = sorted(set(actual_files) - set(expected_files))

    per_file_payloads: list[dict] = []
    files_identical = 0
    files_with_diffs = 0
    files_with_errors = 0

    for name in common:
        expected = expected_files[name]
        actual = actual_files[name]
        if expected.suffix.lower() != actual.suffix.lower():
            # Defensive — basename matched but extension somehow differs (case-only).
            # Treat as "only in" on each side to avoid silent type coercion.
            only_in_expected.append(name)
            only_in_actual.append(name)
            continue

        payload, result, diff_file = _run_single_pair(
            expected=expected,
            actual=actual,
            out_dir=out_dir,
            out_name=None,
            tolerance=tolerance,
            max_details=max_details,
            write_diff_file=write_diff_file,
        )
        per_file_payloads.append(
            {
                "file_name": name,
                "expected_path": str(expected),
                "actual_path": str(actual),
                "diff_file": str(diff_file) if diff_file else None,
                "result": payload,
            }
        )

        if result.read_error:
            files_with_errors += 1
        elif result.is_identical:
            files_identical += 1
        else:
            files_with_diffs += 1

    aggregate = {
        "mode": "folder",
        "expected_dir": str(expected_dir),
        "actual_dir": str(actual_dir),
        "files_compared": len(common),
        "files_identical": files_identical,
        "files_with_diffs": files_with_diffs,
        "files_with_errors": files_with_errors,
        "only_in_expected": only_in_expected,
        "only_in_actual": only_in_actual,
        "results": per_file_payloads,
    }

    # Exit code policy for folder mode:
    # - 2 if any read error (treat as fatal for CI regression testing)
    # - 1 if any diffs OR any file only on one side (structural mismatch matters)
    # - 0 only when every basename matched and every pair was identical
    if files_with_errors:
        return aggregate, 2
    if files_with_diffs or only_in_expected or only_in_actual:
        return aggregate, 1
    return aggregate, 0


def _derive_default_out_dir(expected: Path, actual: Path) -> Path:
    """Default output location: <common-parent-of-inputs>/compare_diff_output.

    Uses os.path.commonpath on the absolute parents so both files and directories
    resolve consistently. Falls back to the parent of `actual` if the two inputs
    do not share a common ancestor (e.g. across different drives on Windows).
    """
    exp_abs = expected.resolve()
    act_abs = actual.resolve()
    exp_base = exp_abs if exp_abs.is_dir() else exp_abs.parent
    act_base = act_abs if act_abs.is_dir() else act_abs.parent
    try:
        common = Path(os.path.commonpath([str(exp_base), str(act_base)]))
    except ValueError:
        common = act_base
    return common / DEFAULT_OUT_SUBDIR


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not args.expected.exists():
        print(json.dumps({"error": f"Expected path not found: {args.expected}"}))
        return 2
    if not args.actual.exists():
        print(json.dumps({"error": f"Actual path not found: {args.actual}"}))
        return 2

    if args.out_dir is None:
        args.out_dir = _derive_default_out_dir(args.expected, args.actual)
        logger.info("Using default output directory: %s", args.out_dir)

    try:
        args.out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(json.dumps({"error": f"Cannot create output directory {args.out_dir}: {e}"}))
        return 2

    expected_is_dir = args.expected.is_dir()
    actual_is_dir = args.actual.is_dir()

    if expected_is_dir != actual_is_dir:
        print(
            json.dumps(
                {
                    "error": (
                        "Input mismatch: both inputs must be files, or both "
                        "directories. Got "
                        f"expected={'dir' if expected_is_dir else 'file'}, "
                        f"actual={'dir' if actual_is_dir else 'file'}."
                    )
                }
            )
        )
        return 2

    if expected_is_dir:
        # --out-name is meaningless when there are many outputs; ignore with a warning.
        if args.out_name:
            logger.warning("--out-name is ignored in folder mode (one diff xlsx per file pair).")
        payload, exit_code = _run_folder_pair(
            expected_dir=args.expected,
            actual_dir=args.actual,
            out_dir=args.out_dir,
            tolerance=args.tolerance,
            max_details=args.max_details,
            write_diff_file=not args.no_diff_file,
        )
        _maybe_write_summary(args.out_dir, payload, skip=args.no_summary)
        print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
        return exit_code

    # Single-file mode (backward compatible).
    payload, result, _ = _run_single_pair(
        expected=args.expected,
        actual=args.actual,
        out_dir=args.out_dir,
        out_name=args.out_name,
        tolerance=args.tolerance,
        max_details=args.max_details,
        write_diff_file=not args.no_diff_file,
    )
    _maybe_write_summary(args.out_dir, payload, skip=args.no_summary)
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))

    if result.read_error:
        return 2
    return 0 if result.is_identical else 1


def _maybe_write_summary(out_dir: Path, payload: dict, skip: bool) -> None:
    """Write summary.md to `out_dir` unless `skip` is true. Never fatal."""
    if skip:
        return
    path = out_dir / "summary.md"
    try:
        path.write_text(render_markdown(payload), encoding="utf-8")
        logger.info("Wrote summary: %s", path)
    except OSError as e:
        logger.error("Failed to write summary.md at %s: %s", path, e)


if __name__ == "__main__":
    sys.exit(main())
