"""
test_i18n.py
────────────
Tests for iis_summarization.i18n — output-language resolution and the
message catalog used to localize the deterministic (Python-written)
parts of the report. No Gurobi required.
"""

from __future__ import annotations

import pytest

from iis_summarization.i18n import resolve_language, tr


# ─────────────────────────────────────────────────────────────
# resolve_language — explicit flag wins
# ─────────────────────────────────────────────────────────────


class TestResolveExplicit:
    def test_explicit_ja(self) -> None:
        assert resolve_language("ja") == "ja"

    def test_explicit_en(self) -> None:
        assert resolve_language("en") == "en"

    def test_explicit_locale_string_ja(self) -> None:
        assert resolve_language("ja_JP.UTF-8") == "ja"

    def test_unknown_explicit_falls_back_to_en(self) -> None:
        assert resolve_language("fr") == "en"


# ─────────────────────────────────────────────────────────────
# resolve_language — auto-detect from OS locale env vars
# ─────────────────────────────────────────────────────────────


class TestResolveAuto:
    def test_lang_ja_detected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for var in ("LC_ALL", "LC_MESSAGES", "LANGUAGE"):
            monkeypatch.delenv(var, raising=False)
        monkeypatch.setenv("LANG", "ja_JP.UTF-8")
        assert resolve_language(None) == "ja"

    def test_lc_all_precedence(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LC_ALL", "ja_JP.UTF-8")
        monkeypatch.setenv("LANG", "en_US.UTF-8")
        assert resolve_language(None) == "ja"

    def test_language_list_ja(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for var in ("LC_ALL", "LC_MESSAGES", "LANG"):
            monkeypatch.delenv(var, raising=False)
        monkeypatch.setenv("LANGUAGE", "ja_JP:en_US")
        assert resolve_language(None) == "ja"

    def test_english_locale_returns_en(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for var in ("LC_ALL", "LC_MESSAGES", "LANGUAGE"):
            monkeypatch.delenv(var, raising=False)
        monkeypatch.setenv("LANG", "en_US.UTF-8")
        assert resolve_language(None) == "en"

    def test_no_locale_env_returns_en(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for var in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
            monkeypatch.delenv(var, raising=False)
        assert resolve_language(None) == "en"

    def test_auto_keyword_triggers_detection(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LANG", "ja_JP.UTF-8")
        assert resolve_language("auto") == "ja"

    def test_explicit_overrides_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LANG", "ja_JP.UTF-8")
        assert resolve_language("en") == "en"


# ─────────────────────────────────────────────────────────────
# tr — message catalog lookup + formatting
# ─────────────────────────────────────────────────────────────


class TestTranslate:
    def test_en_title(self) -> None:
        assert tr("en", "report_title") == "Infeasibility Report"

    def test_ja_title_differs_and_nonempty(self) -> None:
        ja = tr("ja", "report_title")
        assert ja and ja != tr("en", "report_title")

    def test_format_kwargs_en(self) -> None:
        out = tr("en", "forced_le", var="x", ub="0", cons="cap", lb="5")
        assert "x" in out and "cap" in out

    def test_format_kwargs_ja(self) -> None:
        out = tr("ja", "forced_le", var="x", ub="0", cons="cap", lb="5")
        # Variable/constraint tokens are preserved verbatim across languages.
        assert "`x`" in out and "`cap`" in out

    def test_unknown_language_falls_back_to_en(self) -> None:
        assert tr("fr", "report_title") == tr("en", "report_title")

    def test_every_key_has_both_languages(self) -> None:
        from iis_summarization.i18n import _CATALOG

        for key, entry in _CATALOG.items():
            assert "en" in entry, f"{key} missing en"
            assert "ja" in entry, f"{key} missing ja"
            assert entry["ja"], f"{key} has empty ja"
