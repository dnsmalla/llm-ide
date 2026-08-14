"""Unit + end-to-end tests for facts assembly and report rendering."""

from pathlib import Path

from solve_tuning import assessment, log_parser, report_generator
from solve_tuning import facts as facts_mod
from solve_tuning.analyzer import AnalysisOptions, run_analysis

FIXTURES = Path(__file__).parent / "fixtures"


def _facts(name: str, language: str = "en") -> dict:
    parsed = log_parser.parse_log((FIXTURES / name).read_text())
    result = assessment.assess(parsed)
    return facts_mod.build_facts(parsed, result, {"language": language})


def test_render_has_markers_and_collapsible():
    text = report_generator.render(_facts("timelimit_warned.log"), Path("g.log"), "en")
    assert report_generator.SUMMARY_START in text
    assert report_generator.SUMMARY_END in text
    assert "<details>" in text and "</details>" in text
    # technical content sits inside the collapsible block
    assert text.index("<details>") < text.index("Coefficient statistics")
    # the high-risk matrix range is surfaced with its assessment label
    assert "HIGH risk" in text
    assert "Recommended changes" in text
    assert "NumericFocus" in text


def test_render_japanese():
    text = report_generator.render(_facts("optimal_presolved.log", "ja"), Path("g.log"), "ja")
    assert "求解チューニングレポート" in text
    assert "係数統計" in text


def test_extract_explanation_ignores_placeholder():
    text = report_generator.render(_facts("optimal_presolved.log"), Path("g.log"), "en")
    assert report_generator.extract_explanation(text) is None


def test_end_to_end_writes_report(tmp_path: Path):
    out = tmp_path / "out"
    report = run_analysis(
        FIXTURES / "timelimit_warned.log",
        AnalysisOptions(output_dir=out, language="en"),
    )
    assert report.exists()
    assert (out / "timelimit_warned_log_facts.json").exists()
    assert "produced by the summarizer subagent" in report.read_text()


def test_rerun_preserves_spliced_summary(tmp_path: Path):
    out = tmp_path / "out"
    opts = AnalysisOptions(output_dir=out, language="en")
    report = run_analysis(FIXTURES / "optimal_nodelog.log", opts)
    placeholder = report_generator.i18n.tr("en", "placeholder")
    assert placeholder in report.read_text()

    summary = "## Verdict\n\nSolved optimally but numerically risky.\n\n## Why\n\n…\n\n## What To Change\n\n…"
    report.write_text(report.read_text().replace(placeholder, summary))

    report2 = run_analysis(FIXTURES / "optimal_nodelog.log", opts)
    text = report2.read_text()
    assert "Solved optimally but numerically risky." in text
    assert placeholder not in text
    note = report_generator.i18n.tr("en", "regen_note")
    assert note in text
    # re-run again: note never duplicates
    report3 = run_analysis(FIXTURES / "optimal_nodelog.log", opts)
    assert report3.read_text().count(note) == 1


def test_bad_log_raises(tmp_path: Path):
    bad = tmp_path / "notalog.log"
    bad.write_text("hello world, not a solver log\n")
    import pytest

    with pytest.raises(RuntimeError):
        run_analysis(bad, AnalysisOptions(output_dir=tmp_path / "o"))
