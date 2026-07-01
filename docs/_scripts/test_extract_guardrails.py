"""Tests for the guardrail-rules extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from extract_guardrails import extract, render


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def write_fixture(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(body)
    return p


FIXTURE_SOURCE = """\
function check(severity, ruleId, message, details) {
  return { ruleId, severity, message, details };
}

function checkDispatch(payload) {
  const findings = [];
  findings.push(check('blocking', 'dispatch.target',
    'Target must be github, backlog, or linear.'));
  findings.push(check('blocking', 'dispatch.empty', 'No tasks to dispatch.'));
  findings.push(check('warning', 'dispatch.bulk',
    `Bulk dispatch of … items — confirm the target tracker can handle this.`));
  findings.push(check('info', 'dispatch.summary',
    `Will create … tickets.`));
  return findings;
}

function checkCodegen(payload) {
  const findings = [];
  findings.push(check('blocking', 'codegen.repo', 'Repo path is required.'));
  findings.push(check('warning', 'codegen.bulk',
    `Apply touches … files — large changesets are harder to review.`));
  findings.push(check('info', 'codegen.summary',
    `Will write … files.`));
  return findings;
}

export function runGuardrails(kind, payload) {
  let findings = [];
  if (kind === 'dispatch') findings = checkDispatch(payload);
  else findings = [check('blocking', 'guardrail.kind', `Unknown artifact kind: ….`)];
  return findings;
}
"""


# ---------------------------------------------------------------------------
# Happy-path extraction
# ---------------------------------------------------------------------------

def test_extracts_expected_rule_ids(tmp_path: Path) -> None:
    src = write_fixture(tmp_path, "rules.mjs", FIXTURE_SOURCE)
    rows = extract(src)
    ids = {r["rule_id"] for r in rows}
    assert ids == {
        "dispatch.target",
        "dispatch.empty",
        "dispatch.bulk",
        "dispatch.summary",
        "codegen.repo",
        "codegen.bulk",
        "codegen.summary",
        "guardrail.kind",
    }


def test_severities_parsed_correctly(tmp_path: Path) -> None:
    src = write_fixture(tmp_path, "rules.mjs", FIXTURE_SOURCE)
    rows = extract(src)
    by_id = {r["rule_id"]: r for r in rows}
    assert by_id["dispatch.target"]["severity"] == "blocking"
    assert by_id["dispatch.bulk"]["severity"] == "warning"
    assert by_id["dispatch.summary"]["severity"] == "info"


def test_categories_derived_from_rule_id_prefix(tmp_path: Path) -> None:
    src = write_fixture(tmp_path, "rules.mjs", FIXTURE_SOURCE)
    rows = extract(src)
    by_id = {r["rule_id"]: r for r in rows}
    assert by_id["dispatch.empty"]["category"] == "dispatch"
    assert by_id["codegen.repo"]["category"] == "codegen"
    assert by_id["guardrail.kind"]["category"] == "guardrail"


def test_messages_extracted(tmp_path: Path) -> None:
    src = write_fixture(tmp_path, "rules.mjs", FIXTURE_SOURCE)
    rows = extract(src)
    by_id = {r["rule_id"]: r for r in rows}
    assert "github" in by_id["dispatch.target"]["message"]
    assert by_id["dispatch.empty"]["message"] == "No tasks to dispatch."


def test_sorted_by_category_then_id(tmp_path: Path) -> None:
    src = write_fixture(tmp_path, "rules.mjs", FIXTURE_SOURCE)
    rows = extract(src)
    # dispatch comes before codegen, codegen before guardrail
    categories = [r["category"] for r in rows]
    dispatch_idx = [i for i, c in enumerate(categories) if c == "dispatch"]
    codegen_idx = [i for i, c in enumerate(categories) if c == "codegen"]
    guardrail_idx = [i for i, c in enumerate(categories) if c == "guardrail"]
    assert max(dispatch_idx) < min(codegen_idx)
    assert max(codegen_idx) < min(guardrail_idx)


def test_deduplication_keeps_first(tmp_path: Path) -> None:
    """Rule IDs that appear more than once should only be extracted once."""
    src = write_fixture(
        tmp_path,
        "rules.mjs",
        """\
function check(s, r, m) { return { s, r, m }; }
const f = [];
f.push(check('blocking', 'dispatch.creds', 'GitHub dispatch requires repo and token.'));
f.push(check('blocking', 'dispatch.creds', 'Backlog dispatch requires space and apiKey.'));
f.push(check('blocking', 'dispatch.creds', 'Linear dispatch requires teamId and apiKey.'));
""",
    )
    rows = extract(src)
    ids = [r["rule_id"] for r in rows]
    assert ids.count("dispatch.creds") == 1
    # Should keep the first message
    by_id = {r["rule_id"]: r for r in rows}
    assert "GitHub" in by_id["dispatch.creds"]["message"]


# ---------------------------------------------------------------------------
# Renderer tests
# ---------------------------------------------------------------------------

def _make_rows() -> list[dict]:
    return [
        {"rule_id": "dispatch.empty", "severity": "blocking", "category": "dispatch",
         "message": "No tasks to dispatch."},
        {"rule_id": "dispatch.bulk", "severity": "warning", "category": "dispatch",
         "message": "Bulk dispatch of … items."},
        {"rule_id": "codegen.repo", "severity": "blocking", "category": "codegen",
         "message": "Repo path is required."},
    ]


def test_render_starts_with_generated_comment() -> None:
    rows = _make_rows()
    out = render(rows, Path("extension/guardrails/rules.mjs"))
    assert out.startswith("---\ntitle: Guardrail rules\n")
    assert "<!-- generated from extension/guardrails/rules.mjs - do not edit by hand -->" in out


def test_render_groups_by_category() -> None:
    rows = _make_rows()
    out = render(rows, Path("extension/guardrails/rules.mjs"))
    dispatch_pos = out.index("## Dispatch")
    codegen_pos = out.index("## Codegen apply")
    assert dispatch_pos < codegen_pos


def test_render_contains_rule_ids_and_severities() -> None:
    rows = _make_rows()
    out = render(rows, Path("extension/guardrails/rules.mjs"))
    assert "`dispatch.empty`" in out
    assert "`blocking`" in out
    assert "`warning`" in out
    assert "No tasks to dispatch." in out


def test_render_pipe_in_message_escaped() -> None:
    rows = [
        {"rule_id": "test.pipe", "severity": "info", "category": "test",
         "message": "A | B | C"},
    ]
    out = render(rows, Path("extension/guardrails/rules.mjs"))
    assert "A \\| B \\| C" in out


# ---------------------------------------------------------------------------
# Real-source smoke test (requires repo layout)
# ---------------------------------------------------------------------------

def test_real_source_extracts_nonzero_rules() -> None:
    """Verify the real rules.mjs yields more than one rule."""
    root = Path(__file__).resolve().parents[2]
    source = root / "extension" / "guardrails" / "rules.mjs"
    if not source.exists():
        pytest.skip("rules.mjs not present in this environment")
    rows = extract(source)
    assert len(rows) > 1, f"Expected multiple rules, got {len(rows)}"
    # Verify categories present
    cats = {r["category"] for r in rows}
    assert "dispatch" in cats
    assert "codegen" in cats
