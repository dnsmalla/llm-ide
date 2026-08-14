"""Core Excel/CSV comparison engine.

Reads two files (Excel or CSV) and produces a structured DiffResult describing
every difference found. The caller decides what to do with the result — render
a summary, write a highlighted Excel, emit JSON, etc.

Design notes:
- Pure logic: no side effects beyond reading input files.
- DiffResult is serializable (use `to_dict()` for JSON output).
- Float comparison uses a configurable tolerance to avoid spurious diffs from
  IEEE-754 rounding.
- CSV encoding is auto-detected by trying UTF-8, CP932, Shift-JIS, Latin-1 in
  that order (covers common Japanese enterprise files and falls back to other
  encodings for general-purpose use).
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

DEFAULT_FLOAT_TOLERANCE = 1e-6
CSV_ENCODING_CANDIDATES = ("utf-8", "cp932", "shift_jis", "latin-1")
EXCEL_EXTENSIONS = {".xlsx", ".xls", ".xlsm"}
CSV_EXTENSIONS = {".csv", ".tsv"}


@dataclass
class CellDifference:
    """A single cell-level mismatch.

    `row` is zero-indexed against the data rows (row 0 = first row below the
    header). For Excel-style display, show `row + 2` (1-based + header row).
    """

    sheet_name: str
    row: int
    column: str
    expected_value: Any
    actual_value: Any

    def to_dict(self) -> dict[str, Any]:
        return {
            "sheet_name": self.sheet_name,
            "row": self.row,
            "excel_row": self.row + 2,
            "column": self.column,
            "expected_value": _jsonable(self.expected_value),
            "actual_value": _jsonable(self.actual_value),
        }


@dataclass
class SheetDiff:
    """Everything different about one sheet (or the single 'sheet' of a CSV)."""

    sheet_name: str
    missing_in_actual: bool = False
    missing_in_expected: bool = False
    expected_shape: tuple[int, int] | None = None
    actual_shape: tuple[int, int] | None = None
    expected_columns: list[str] | None = None
    actual_columns: list[str] | None = None
    cell_differences: list[CellDifference] = field(default_factory=list)
    read_error: str | None = None

    @property
    def shape_matches(self) -> bool:
        return self.expected_shape == self.actual_shape

    @property
    def columns_match(self) -> bool:
        return self.expected_columns == self.actual_columns

    @property
    def has_differences(self) -> bool:
        return (
            self.missing_in_actual
            or self.missing_in_expected
            or self.read_error is not None
            or not self.shape_matches
            or not self.columns_match
            or bool(self.cell_differences)
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "sheet_name": self.sheet_name,
            "missing_in_actual": self.missing_in_actual,
            "missing_in_expected": self.missing_in_expected,
            "expected_shape": list(self.expected_shape) if self.expected_shape else None,
            "actual_shape": list(self.actual_shape) if self.actual_shape else None,
            "expected_columns": self.expected_columns,
            "actual_columns": self.actual_columns,
            "cell_differences": [d.to_dict() for d in self.cell_differences],
            "cell_difference_count": len(self.cell_differences),
            "read_error": self.read_error,
            "has_differences": self.has_differences,
        }


@dataclass
class DiffResult:
    """The complete result of comparing two files."""

    expected_path: str
    actual_path: str
    file_type: str  # "excel" | "csv" | "unsupported"
    tolerance: float
    sheet_diffs: list[SheetDiff] = field(default_factory=list)
    read_error: str | None = None

    @property
    def is_identical(self) -> bool:
        return self.read_error is None and not any(
            s.has_differences for s in self.sheet_diffs
        )

    @property
    def total_cell_differences(self) -> int:
        return sum(len(s.cell_differences) for s in self.sheet_diffs)

    def to_dict(self) -> dict[str, Any]:
        return {
            "expected_path": self.expected_path,
            "actual_path": self.actual_path,
            "file_type": self.file_type,
            "tolerance": self.tolerance,
            "is_identical": self.is_identical,
            "total_cell_differences": self.total_cell_differences,
            "sheet_count": len(self.sheet_diffs),
            "read_error": self.read_error,
            "sheet_diffs": [s.to_dict() for s in self.sheet_diffs],
        }


class ExcelComparator:
    """Compares two Excel or CSV files and produces a structured DiffResult.

    Usage:
        comparator = ExcelComparator()
        result = comparator.compare(Path("expected.xlsx"), Path("actual.xlsx"))
        if result.is_identical:
            print("Files match")
        else:
            print(f"Found {result.total_cell_differences} cell differences")
    """

    def __init__(self, float_tolerance: float = DEFAULT_FLOAT_TOLERANCE) -> None:
        self.float_tolerance = float_tolerance

    # --- Public API ---------------------------------------------------------

    def compare(self, expected_path: Path, actual_path: Path) -> DiffResult:
        """Compare two files and return a structured diff."""
        expected_path = Path(expected_path)
        actual_path = Path(actual_path)

        ext_expected = expected_path.suffix.lower()
        ext_actual = actual_path.suffix.lower()

        if ext_expected != ext_actual:
            return DiffResult(
                expected_path=str(expected_path),
                actual_path=str(actual_path),
                file_type="unsupported",
                tolerance=self.float_tolerance,
                read_error=(
                    f"File type mismatch: '{ext_expected}' vs '{ext_actual}'. "
                    "Both inputs must be the same type (both Excel or both CSV)."
                ),
            )

        if ext_expected in EXCEL_EXTENSIONS:
            return self._compare_excel(expected_path, actual_path)
        if ext_expected in CSV_EXTENSIONS:
            return self._compare_csv(expected_path, actual_path)

        return DiffResult(
            expected_path=str(expected_path),
            actual_path=str(actual_path),
            file_type="unsupported",
            tolerance=self.float_tolerance,
            read_error=f"Unsupported file extension: '{ext_expected}'",
        )

    # --- Excel --------------------------------------------------------------

    def _compare_excel(self, expected_path: Path, actual_path: Path) -> DiffResult:
        result = DiffResult(
            expected_path=str(expected_path),
            actual_path=str(actual_path),
            file_type="excel",
            tolerance=self.float_tolerance,
        )

        try:
            expected_xl = pd.ExcelFile(expected_path)
            actual_xl = pd.ExcelFile(actual_path)
        except Exception as e:
            result.read_error = f"Failed to open Excel files: {e}"
            return result

        expected_sheets = {str(s) for s in expected_xl.sheet_names}
        actual_sheets = {str(s) for s in actual_xl.sheet_names}

        # Sheets only in one side
        for name in sorted(expected_sheets - actual_sheets):
            result.sheet_diffs.append(
                SheetDiff(sheet_name=name, missing_in_actual=True)
            )
        for name in sorted(actual_sheets - expected_sheets):
            result.sheet_diffs.append(
                SheetDiff(sheet_name=name, missing_in_expected=True)
            )

        # Common sheets
        for name in sorted(expected_sheets & actual_sheets):
            result.sheet_diffs.append(
                self._compare_sheet(expected_xl, actual_xl, name)
            )

        return result

    def _compare_sheet(
        self,
        expected_xl: pd.ExcelFile,
        actual_xl: pd.ExcelFile,
        sheet_name: str,
    ) -> SheetDiff:
        diff = SheetDiff(sheet_name=sheet_name)

        try:
            expected_df = pd.read_excel(expected_xl, sheet_name=sheet_name)
            actual_df = pd.read_excel(actual_xl, sheet_name=sheet_name)
        except Exception as e:
            diff.read_error = f"Failed to read sheet '{sheet_name}': {e}"
            return diff

        self._populate_dataframe_diff(diff, expected_df, actual_df)
        return diff

    # --- CSV ----------------------------------------------------------------

    def _compare_csv(self, expected_path: Path, actual_path: Path) -> DiffResult:
        result = DiffResult(
            expected_path=str(expected_path),
            actual_path=str(actual_path),
            file_type="csv",
            tolerance=self.float_tolerance,
        )

        try:
            expected_df = self._read_csv_with_encoding(expected_path)
            actual_df = self._read_csv_with_encoding(actual_path)
        except Exception as e:
            result.read_error = f"Failed to read CSV files: {e}"
            return result

        # A CSV behaves like a single-sheet Excel file
        diff = SheetDiff(sheet_name=expected_path.stem)
        self._populate_dataframe_diff(diff, expected_df, actual_df)
        result.sheet_diffs.append(diff)

        return result

    def _read_csv_with_encoding(self, path: Path) -> pd.DataFrame:
        """Try a sequence of encodings to handle UTF-8, Japanese, and legacy files."""
        last_error: Exception | None = None
        for encoding in CSV_ENCODING_CANDIDATES:
            try:
                return pd.read_csv(path, encoding=encoding)
            except UnicodeDecodeError as e:
                last_error = e
                logger.debug("CSV read failed with %s: %s", encoding, e)
                continue
        raise last_error or ValueError(f"Unable to decode CSV: {path}")

    # --- DataFrame comparison (shared by Excel sheets and CSV) --------------

    def _populate_dataframe_diff(
        self,
        diff: SheetDiff,
        expected_df: pd.DataFrame,
        actual_df: pd.DataFrame,
    ) -> None:
        diff.expected_shape = tuple(expected_df.shape)
        diff.actual_shape = tuple(actual_df.shape)
        diff.expected_columns = [str(c) for c in expected_df.columns]
        diff.actual_columns = [str(c) for c in actual_df.columns]

        # If column names differ, cell-level comparison would be misleading —
        # the "same" column index may hold different data. Stop at the structural
        # diff and let the caller decide whether to dig deeper.
        if diff.expected_columns != diff.actual_columns:
            return

        diff.cell_differences = self._compare_dataframe_cells(
            expected_df, actual_df, diff.sheet_name
        )

    def _compare_dataframe_cells(
        self,
        expected_df: pd.DataFrame,
        actual_df: pd.DataFrame,
        sheet_name: str,
    ) -> list[CellDifference]:
        differences: list[CellDifference] = []
        min_rows = min(len(expected_df), len(actual_df))
        min_cols = min(len(expected_df.columns), len(actual_df.columns))

        for row_idx in range(min_rows):
            for col_idx in range(min_cols):
                col_name = str(expected_df.columns[col_idx])
                expected_val = expected_df.iloc[row_idx, col_idx]
                actual_val = actual_df.iloc[row_idx, col_idx]

                if not self._values_equal(expected_val, actual_val):
                    differences.append(
                        CellDifference(
                            sheet_name=sheet_name,
                            row=row_idx,
                            column=col_name,
                            expected_value=expected_val,
                            actual_value=actual_val,
                        )
                    )

        return differences

    def _values_equal(self, a: Any, b: Any) -> bool:
        """Value equality with float tolerance and NaN/Inf handling."""
        # Both NaN → considered equal (standard regression-testing convention).
        a_nan = pd.isna(a)
        b_nan = pd.isna(b)
        if a_nan and b_nan:
            return True
        if a_nan or b_nan:
            return False

        # Numeric: tolerance-based comparison, sign-aware for infinities.
        if isinstance(a, (int, float, np.integer, np.floating)) and isinstance(
            b, (int, float, np.integer, np.floating)
        ):
            if np.isinf(a) and np.isinf(b):
                return np.sign(a) == np.sign(b)
            if np.isinf(a) or np.isinf(b):
                return False
            return abs(float(a) - float(b)) < self.float_tolerance

        # Fallback: direct equality (strings, bools, dates, etc.).
        return a == b


# --- Helpers ---------------------------------------------------------------


def _jsonable(value: Any) -> Any:
    """Convert a pandas/numpy value into something json.dumps can handle."""
    if pd.isna(value):
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        f = float(value)
        if np.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        return f
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, (int, float, str, bool)) or value is None:
        return value
    return str(value)


def result_to_json_dict(result: DiffResult) -> dict[str, Any]:
    """Convenience wrapper for `result.to_dict()` — symmetric with the other helpers."""
    return result.to_dict()
