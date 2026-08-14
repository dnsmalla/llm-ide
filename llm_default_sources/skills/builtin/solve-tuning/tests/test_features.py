"""Tests for the four advisor features: node-log/stall, applyable settings,
two-log comparison (the big-M feature is covered in test_model_inspect.py)."""

from pathlib import Path

from solve_tuning import (
    assessment,
    comparison,
    log_parser,
    recommendations,
    report_generator,
)

FIXTURES = Path(__file__).parent / "fixtures"


# ── Node-log parsing + stall analysis ──

def test_node_log_parsed_from_timelimit_fixture():
    parsed = log_parser.parse_log((FIXTURES / "timelimit_warned.log").read_text())
    nl = parsed["node_log"]
    assert len(nl) >= 4
    # rows carry incumbent / best_bound / gap / time
    last = nl[-1]
    assert last["incumbent"] == 101500.0
    assert last["best_bound"] == 119500.0
    assert last["time_sec"] == 55.0


def test_stall_dual_when_bound_flat():
    # incumbent improves over time, bound frozen → dual-bound stall.
    nl = [
        {"time_sec": 10, "incumbent": 120.0, "best_bound": 100.0, "gap_pct": 20},
        {"time_sec": 30, "incumbent": 112.0, "best_bound": 100.0, "gap_pct": 12},
        {"time_sec": 60, "incumbent": 105.0, "best_bound": 100.0, "gap_pct": 5},
    ]
    stall = assessment._analyze_stall(nl)
    assert stall["type"] == "dual"
    assert any(lev.get("set_value") == "3" for lev in stall["levers"])  # MIPFocus 3


def test_stall_primal_when_incumbent_flat():
    nl = [
        {"time_sec": 10, "incumbent": 105.0, "best_bound": 60.0, "gap_pct": 43},
        {"time_sec": 30, "incumbent": 105.0, "best_bound": 80.0, "gap_pct": 24},
        {"time_sec": 60, "incumbent": 105.0, "best_bound": 95.0, "gap_pct": 10},
    ]
    stall = assessment._analyze_stall(nl)
    assert stall["type"] == "primal"
    assert any(lev.get("set_value") == "1" for lev in stall["levers"])  # MIPFocus 1


def test_timelimit_finding_uses_stall_diagnosis():
    parsed = log_parser.parse_log((FIXTURES / "timelimit_warned.log").read_text())
    findings = assessment.assess(parsed)["findings"]
    tl = next(f for f in findings if f["id"] == "time_limit")
    # in the fixture both incumbent and bound move → "progressing" (needs time)
    assert "more time" in tl["detail"].lower() or "stall" in tl["detail"].lower()


# ── Applyable settings ──

def test_collect_settings_dedupes_and_skips_situational():
    findings = [
        {"levers": recommendations.CATALOG["numerical"]},
        {"levers": recommendations.CATALOG["slow_mip_dual"]},
    ]
    s = recommendations.collect_settings(findings)
    assert s["NumericFocus"] == "2"
    assert s["MIPFocus"] == "3"
    assert s["Cuts"] == "2"
    # MIPGap is situational (no set_value) → must not appear
    assert "MIPGap" not in s


def test_apply_section_renders_setparam_block():
    facts = {
        "meta": {"language": "en", "log_file": "/x/run.log"},
        "recommended_settings": {"NumericFocus": "2", "Cuts": "2"},
    }
    lines = report_generator._apply_section(facts, "en")
    text = "\n".join(lines)
    assert 'model.setParam("NumericFocus", 2)' in text
    assert "run_recommended.prm" in text


# ── Two-log comparison ──

def test_comparison_flags_improvement():
    base = log_parser.parse_log((FIXTURES / "timelimit_warned.log").read_text())  # TIME_LIMIT, gap 17%
    cur = log_parser.parse_log((FIXTURES / "optimal_nodelog.log").read_text())    # OPTIMAL, gap 0
    comp = comparison.compare(base, cur, "timelimit_warned.log")
    metrics = {m["metric"]: m for m in comp["metrics"]}
    assert metrics["Gap %"]["baseline"] == 17.2414
    assert metrics["Gap %"]["current"] == 0.0
    assert metrics["Gap %"]["better"] is True  # gap went down
    assert metrics["Runtime (s)"]["better"] is True  # 60s → 0.01s


def test_comparison_section_renders():
    base = log_parser.parse_log((FIXTURES / "timelimit_warned.log").read_text())
    cur = log_parser.parse_log((FIXTURES / "optimal_nodelog.log").read_text())
    facts = {
        "meta": {"language": "en", "log_file": "/x/cur.log"},
        "comparison": comparison.compare(base, cur, "/x/base.log"),
    }
    text = "\n".join(report_generator._comparison_section(facts, "en"))
    assert "Comparison vs baseline" in text
    assert "Gap %" in text
