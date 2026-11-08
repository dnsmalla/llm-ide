from pathlib import Path

import check_mac_refs


def test_the_live_pages_have_no_unexplained_mac_paths():
    assert check_mac_refs.bad_lines(check_mac_refs.live_docs()) == []


def test_a_live_reference_fails_and_a_removed_line_is_allowed(tmp_path):
    live = tmp_path / "live.md"
    live.write_text("run `mac/Scripts/build.sh`\nThe Mac app (`mac/`) was removed.\n", encoding="utf-8")
    problems = check_mac_refs.bad_lines([live])
    assert len(problems) == 1
    assert "mac/Scripts/build.sh" in problems[0]


def test_the_exempt_pages_are_not_scanned():
    live = {p.relative_to(check_mac_refs.ROOT).as_posix() for p in check_mac_refs.live_docs()}
    assert not any(p.startswith(("docs/decisions/", "docs/kits/", "docs/superpowers/")) for p in live)
