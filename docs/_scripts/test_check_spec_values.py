from pathlib import Path

from check_spec_values import build_checks, first_int, first_str, main, migration_head


def test_first_int_extracts_capture_group():
    assert first_int("SERVER_API_VERSION = 18;", r"SERVER_API_VERSION = (\d+)") == 18
    assert first_int("head migration is `0016`", r"head migration is `0*(\d+)`") == 16
    assert first_int("nothing here", r"(\d+) widgets") is None


def test_first_str_extracts_capture_group():
    assert first_str('from: "1.5.3"', r'from: "([\d.]+)"') == "1.5.3"
    assert first_str("# TYPE llmide_uptime_seconds gauge", r"# TYPE (\w+) gauge") == "llmide_uptime_seconds"
    assert first_str("nothing here", r"from: \"([\d.]+)\"") is None


def test_migration_head_picks_highest(tmp_path: Path):
    for name in ("0001_initial.sql", "0013_email_state.sql", "0016_token_epoch.sql", "notes.md"):
        (tmp_path / name).write_text("-- x")
    assert migration_head(tmp_path) == 16


def test_migration_head_none_when_empty(tmp_path: Path):
    assert migration_head(tmp_path) is None


def test_live_spec_values_match_source():
    # The live docs/spec pages must agree with source — this is the guard doing
    # its job; if it fails, a documented value has drifted (or was reworded so
    # its claim regex no longer matches).
    assert main() == 0


def test_build_checks_finds_every_documented_value():
    # Every check must locate BOTH a source value and a documented value on live
    # data (None means an extractor or a spec-claim regex stopped matching).
    for label, source_val, doc_val, where in build_checks():
        assert source_val is not None, f"source extractor returned None for: {label}"
        assert doc_val is not None, f"no documented value found for: {label} ({where})"
