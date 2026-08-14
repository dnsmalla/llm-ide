"""
test_license_resolver.py
────────────────────────
Unit tests for iis_summarization.license_resolver.
No Gurobi license required — the resolver only inspects filesystem
paths and environment variables.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from iis_summarization import license_resolver
from iis_summarization.license_resolver import resolve_license


@pytest.fixture(autouse=True)
def _clear_cache_and_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reset the resolver cache and clear Gurobi env vars before each test."""
    monkeypatch.setattr(license_resolver, "_cached", None, raising=False)
    monkeypatch.setattr(license_resolver, "_cache_set", False, raising=False)
    monkeypatch.delenv("GRB_LICENSE_FILE", raising=False)
    monkeypatch.delenv("GUROBI_HOME", raising=False)
    monkeypatch.delenv("HOME", raising=False)


def _write_lic(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("TYPE=ACADEMIC\n", encoding="utf-8")
    return path


class TestResolveLicense:
    def test_grb_license_file_wins(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        winner = _write_lic(tmp_path / "explicit" / "gurobi.lic")
        loser = _write_lic(tmp_path / "home" / "gurobi.lic")
        monkeypatch.setenv("GRB_LICENSE_FILE", str(winner))
        monkeypatch.setenv("HOME", str(loser.parent))

        info = resolve_license(force=True)

        assert info is not None
        assert info.path == winner
        assert info.source == "GRB_LICENSE_FILE"

    def test_falls_through_when_grb_license_file_path_missing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        nonexistent = tmp_path / "nope" / "gurobi.lic"
        gurobi_home = _write_lic(tmp_path / "gurobi" / "gurobi.lic").parent
        monkeypatch.setenv("GRB_LICENSE_FILE", str(nonexistent))
        monkeypatch.setenv("GUROBI_HOME", str(gurobi_home))

        info = resolve_license(force=True)

        assert info is not None
        assert info.path == gurobi_home / "gurobi.lic"
        assert info.source == "GUROBI_HOME"

    def test_home_before_gurobi_home(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        home_lic = _write_lic(tmp_path / "home" / "gurobi.lic")
        gurobi_home = _write_lic(tmp_path / "gurobi" / "gurobi.lic").parent
        monkeypatch.setenv("HOME", str(home_lic.parent))
        monkeypatch.setenv("GUROBI_HOME", str(gurobi_home))

        info = resolve_license(force=True)

        assert info is not None
        assert info.path == home_lic
        assert info.source == "HOME"

    def test_exports_grb_license_file_on_success(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        gurobi_home = _write_lic(tmp_path / "gurobi" / "gurobi.lic").parent
        monkeypatch.setenv("GUROBI_HOME", str(gurobi_home))
        # Pre-condition: GRB_LICENSE_FILE not set.
        assert "GRB_LICENSE_FILE" not in __import__("os").environ

        info = resolve_license(force=True)

        assert info is not None
        assert __import__("os").environ["GRB_LICENSE_FILE"] == str(gurobi_home / "gurobi.lic")

    def test_returns_none_when_nothing_exists(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Point every var at a non-existent path so the resolver has to walk
        # the full candidate list. We can't realistically delete the host's
        # /opt/gurobi*, so this test is meaningful only on hosts without one;
        # otherwise the glob fallback will hit a real install. Skip in that
        # case rather than asserting incorrectly.
        if (
            list(Path("/opt").glob("gurobi*/linux64/gurobi.lic"))
            or Path("/opt/gurobi/gurobi.lic").is_file()
        ):
            pytest.skip("Host has /opt/gurobi*/gurobi.lic; cannot test the no-license path here.")

        monkeypatch.setenv("GRB_LICENSE_FILE", str(tmp_path / "missing.lic"))
        monkeypatch.setenv("HOME", str(tmp_path / "no_home"))
        monkeypatch.setenv("GUROBI_HOME", str(tmp_path / "no_gurobi_home"))

        info = resolve_license(force=True)

        assert info is None

    def test_cache_returns_same_object(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        lic = _write_lic(tmp_path / "gurobi" / "gurobi.lic")
        monkeypatch.setenv("GRB_LICENSE_FILE", str(lic))

        first = resolve_license(force=True)
        # Even if env changes, a cached call returns the previous result.
        monkeypatch.delenv("GRB_LICENSE_FILE", raising=False)
        second = resolve_license()

        assert first is not None
        assert second is first

    def test_force_bypasses_cache(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        first_lic = _write_lic(tmp_path / "one" / "gurobi.lic")
        second_lic = _write_lic(tmp_path / "two" / "gurobi.lic")
        monkeypatch.setenv("GRB_LICENSE_FILE", str(first_lic))
        first = resolve_license(force=True)

        monkeypatch.setenv("GRB_LICENSE_FILE", str(second_lic))
        second = resolve_license(force=True)

        assert first is not None
        assert second is not None
        assert first.path == first_lic
        assert second.path == second_lic
