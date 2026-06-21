"""Tests for the error-codes extractor."""
from pathlib import Path

import pytest

from extract_error_codes import extract


def write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(body)
    return p


def test_extracts_single_line_factory(tmp_path: Path) -> None:
    src = "export const errAuth = (msg = 'Authentication required') =>\n  new AppError('AUTH_REQUIRED', msg, { status: 401 });\n"
    f = write(tmp_path, "errors.mjs", src)
    rows = extract(f)
    assert len(rows) == 1
    assert rows[0]["code"] == "AUTH_REQUIRED"
    assert rows[0]["status"] == 401


def test_extracts_comment_as_description(tmp_path: Path) -> None:
    src = (
        "// Missing or invalid bearer token\n"
        "export const errAuth = (msg = 'Authentication required') =>\n"
        "  new AppError('AUTH_REQUIRED', msg, { status: 401 });\n"
    )
    f = write(tmp_path, "errors.mjs", src)
    rows = extract(f)
    assert rows[0]["description"] == "Missing or invalid bearer token"


def test_multiline_comment_joined(tmp_path: Path) -> None:
    src = (
        "// First line\n"
        "// second line\n"
        "export const errFoo = () => new AppError('FOO_CODE', 'msg', { status: 400 });\n"
    )
    f = write(tmp_path, "errors.mjs", src)
    rows = extract(f)
    assert rows[0]["description"] == "First line second line"


def test_sorted_alphabetically(tmp_path: Path) -> None:
    src = (
        "export const errZ = () => new AppError('Z_CODE', 'z', { status: 400 });\n"
        "export const errA = () => new AppError('A_CODE', 'a', { status: 400 });\n"
    )
    f = write(tmp_path, "errors.mjs", src)
    rows = extract(f)
    assert [r["code"] for r in rows] == ["A_CODE", "Z_CODE"]


def test_no_duplicate_codes(tmp_path: Path) -> None:
    # Same code appearing twice should appear only once in output.
    src = (
        "export const errA = () => new AppError('DUP', 'first', { status: 400 });\n"
        "export const errB = () => new AppError('DUP', 'second', { status: 400 });\n"
    )
    f = write(tmp_path, "errors.mjs", src)
    rows = extract(f)
    assert len(rows) == 1
    assert rows[0]["code"] == "DUP"


def test_ignores_sendError_function(tmp_path: Path) -> None:
    # sendError references AppError via instanceof, not new AppError('CODE', ...)
    src = (
        "export const errAuth = () => new AppError('AUTH_REQUIRED', 'msg', { status: 401 });\n"
        "export function sendError(res, err) {\n"
        "  const isApp = err instanceof AppError;\n"
        "  const code = isApp ? err.code : 'INTERNAL_ERROR';\n"
        "}\n"
    )
    f = write(tmp_path, "errors.mjs", src)
    rows = extract(f)
    codes = [r["code"] for r in rows]
    assert "AUTH_REQUIRED" in codes
    # INTERNAL_ERROR in ternary is not a factory — should not appear
    assert "INTERNAL_ERROR" not in codes


def test_every_code_has_a_description():
    from extract_error_codes import extract
    from pathlib import Path
    rows = extract(Path("extension/core/errors.mjs"))
    missing = [r["code"] for r in rows if not r["description"].strip()]
    assert not missing, f"error codes missing descriptions: {missing}"
