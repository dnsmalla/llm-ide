"""Tests for the schema extractor."""
from pathlib import Path

import pytest

from extract_schema import extract_tables


def write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(body)
    return p


def test_extract_tables_from_create(tmp_path: Path) -> None:
    sql = """
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT
    );

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY,
      meeting_id TEXT REFERENCES meetings(id)
    );
    """
    f = write(tmp_path, "m.sql", sql)
    tables = extract_tables([f])
    by_name = {t["name"]: t for t in tables}
    assert set(by_name) == {"meetings", "entities"}
    assert [c["name"] for c in by_name["meetings"]["columns"]] == ["id", "user_id", "title"]


def test_alter_table_adds_columns(tmp_path: Path) -> None:
    a = write(tmp_path, "a.sql", "CREATE TABLE t (id TEXT);")
    b = write(tmp_path, "b.sql", "ALTER TABLE t ADD COLUMN extra TEXT;")
    tables = extract_tables([a, b])
    assert [c["name"] for c in tables[0]["columns"]] == ["id", "extra"]


def test_ignores_constraint_lines(tmp_path: Path) -> None:
    sql = """
    CREATE TABLE x (
      a TEXT,
      b TEXT,
      PRIMARY KEY (a, b),
      FOREIGN KEY (a) REFERENCES y(id)
    );
    """
    f = write(tmp_path, "m.sql", sql)
    tables = extract_tables([f])
    assert [c["name"] for c in tables[0]["columns"]] == ["a", "b"]


def test_files_processed_in_lexical_order(tmp_path: Path) -> None:
    write(tmp_path, "0002_alter.sql", "ALTER TABLE t ADD COLUMN late TEXT;")
    write(tmp_path, "0001_create.sql", "CREATE TABLE t (early TEXT);")
    tables = extract_tables(sorted(tmp_path.glob("*.sql")))
    cols = [c["name"] for c in tables[0]["columns"]]
    assert cols == ["early", "late"]


def test_schema_doc_documents_indexes_fts_and_triggers():
    """The generated doc must cover indexes, the FTS5 virtual table, and triggers.

    The migrations (extension/kb/migrations/*.sql) define all three constructs.
    This test runs against the checked-in docs/reference/database-schema.md, which
    is produced by extract_schema.py — so if this test fails, regenerate with:
        python3 docs/_scripts/extract_schema.py
    """
    doc = Path("docs/reference/database-schema.md").read_text()
    # The FTS5 full-text search virtual table ('search') must be documented.
    assert "fts5" in doc.lower(), "FTS5 virtual table not documented"
    # Indexes from the migrations must appear (dozens defined across all migrations).
    assert "INDEX" in doc.upper(), "indexes not documented"
    # Triggers from the migrations must appear (trg_* triggers defined in 0001, 0005, 0011).
    assert "TRIGGER" in doc.upper(), "triggers not documented"
