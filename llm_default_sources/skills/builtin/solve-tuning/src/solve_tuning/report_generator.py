"""Render the Markdown report: a narrative summary region (spliced by the
summarizer subagent) above a collapsible block of deterministic technical
sections. Mirrors the result-explanation report layout, including summary
persistence across re-runs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import assessment, i18n

SUMMARY_START = "<!-- solve-tuning:summary:start -->"
SUMMARY_END = "<!-- solve-tuning:summary:end -->"

_RATIO_LABEL = {
    None: "coeff_ok",
    "info": "coeff_monitor",
    "warning": "coeff_risk",
    "critical": "coeff_high_risk",
}


def _fmt(x: Any) -> str:
    if x is None:
        return "—"
    if isinstance(x, float):
        return f"{x:,.6g}"
    return str(x)


def _placeholder(language: str) -> str:
    return i18n.tr(language, "placeholder")


def _overview(facts: dict[str, Any], lang: str) -> list[str]:
    meta = facts["meta"]
    term = facts["termination"]
    lines = [f"## {i18n.tr(lang, 'overview_header')}", "", "| | |", "|---|---|"]
    lines.append(f"| {i18n.tr(lang, 'ov_version')} | {_fmt(meta.get('version'))} |")
    sizes = meta.get("sizes")
    if sizes:
        mip = i18n.tr(lang, "mip_suffix") if meta.get("is_mip") else ""
        lines.append(
            f"| {i18n.tr(lang, 'ov_model')} | "
            f"{i18n.tr(lang, 'ov_model_value', rows=sizes['rows'], cols=sizes['columns'], nz=sizes['nonzeros'], mip=mip)} |"
        )
    if term.get("status"):
        phrase = term.get("status_phrase") or term["status"]
        lines.append(f"| {i18n.tr(lang, 'ov_status')} | {phrase} |")
    if term.get("best_objective") is not None:
        lines.append(f"| {i18n.tr(lang, 'ov_objective')} | {_fmt(term['best_objective'])} |")
    if term.get("best_bound") is not None:
        lines.append(f"| {i18n.tr(lang, 'ov_bound')} | {_fmt(term['best_bound'])} |")
    if term.get("gap_pct") is not None:
        lines.append(f"| {i18n.tr(lang, 'ov_gap')} | {_fmt(term['gap_pct'])}% |")
    if term.get("runtime_sec") is not None:
        lines.append(f"| {i18n.tr(lang, 'ov_runtime')} | {_fmt(term['runtime_sec'])}s |")
    if term.get("work_units") is not None:
        lines.append(f"| {i18n.tr(lang, 'ov_work')} | {_fmt(term['work_units'])} |")
    if term.get("nodes") is not None:
        lines.append(f"| {i18n.tr(lang, 'ov_nodes')} | {_fmt(term['nodes'])} |")
    lines.append("")
    return lines


def _coeff_section(facts: dict[str, Any], lang: str) -> list[str]:
    ranges = facts["coefficient_stats"]["ranges"]
    ratios = facts["coefficient_stats"]["ratios"]
    if not ranges:
        return []
    lines = [f"## {i18n.tr(lang, 'coeff_header')}", "", i18n.tr(lang, "coeff_table_header"),
             "|---|---|---|---|"]
    for key in ("matrix", "objective", "bounds", "rhs"):
        if key not in ranges:
            continue
        lo, hi = ranges[key]
        ratio = ratios.get(key)
        sev = assessment._ratio_severity(ratio) if ratio else None  # noqa: SLF001
        label = i18n.tr(lang, _RATIO_LABEL[sev])
        rtxt = f"{ratio:.0e}" if ratio else "—"
        lines.append(f"| {key} | [{lo:g}, {hi:g}] | {rtxt} | {label} |")
    src_key = "src_model" if facts["coefficient_stats"].get("source") == "model file" else "src_log"
    lines.append("")
    lines.append(i18n.tr(lang, "coeff_source_note", src=i18n.tr(lang, src_key)))
    lines.append("")
    return lines


def _model_section(facts: dict[str, Any], lang: str) -> list[str]:
    ms = facts.get("model_structure") or {}
    meta = facts["meta"]
    if not ms and not meta.get("obj_sense"):
        return []
    lines = [f"## {i18n.tr(lang, 'model_header')}", ""]
    if ms.get("model_class"):
        linear = i18n.tr(lang, "model_linear_yes" if ms.get("is_linear") else "model_linear_no")
        lines.append(f"- {i18n.tr(lang, 'model_class')}: **{ms['model_class']}** ({linear})")
    if meta.get("obj_sense"):
        lines.append(f"- {i18n.tr(lang, 'model_objsense')}: {meta['obj_sense']}")
    if ms.get("gen_constraints"):
        breakdown = ", ".join(f"{v}× {k}" for k, v in ms["gen_constraints"].items())
        lines.append(f"- {i18n.tr(lang, 'model_gen_breakdown')}: {breakdown}")
    if ms.get("density") is not None:
        lines.append(f"- {i18n.tr(lang, 'model_density')}: {ms['density']:.2%}")
    if any(ms.get(k) for k in ("n_quad_constrs", "n_sos", "n_gen_constrs")):
        lines.append("- " + i18n.tr(
            lang, "model_special",
            q=ms.get("n_quad_constrs", 0), s=ms.get("n_sos", 0), g=ms.get("n_gen_constrs", 0),
        ))
    extremes = ms.get("matrix_extremes") or {}
    hi, lo = extremes.get("max"), extremes.get("min")
    if hi and lo:
        lines.append("- " + i18n.tr(
            lang, "model_extreme",
            hv=hi["value"], hvar=hi["variable"], hc=hi["constraint"],
            lv=lo["value"], lvar=lo["variable"], lc=lo["constraint"],
        ))
    lines.append("")
    return lines


def _findings_section(facts: dict[str, Any], lang: str) -> list[str]:
    findings = facts["findings"]
    lines = [f"## {i18n.tr(lang, 'findings_header')}", ""]
    icon = {"critical": "🔴", "warning": "🟠", "info": "🟢"}
    seen_levers: list[dict] = []
    for f in findings:
        lines.append(f"- {icon.get(f['severity'], '•')} **{f['title']}** — {f['detail']}")
        for lev in f.get("levers", []):
            if lev not in seen_levers:
                seen_levers.append(lev)
    lines.append("")
    if seen_levers:
        lines.append(f"## {i18n.tr(lang, 'recommendations_header')}")
        lines.append("")
        lines.append(i18n.tr(lang, "rec_table_header"))
        lines.append("|---|---|---|")
        for lev in seen_levers:
            param = f"`{lev['parameter']}`" if lev["parameter"] else i18n.tr(lang, "rec_formulation")
            lines.append(f"| {param} | {lev['change']} | {lev['rationale']} |")
        lines.append("")
    return lines


def _warnings_section(facts: dict[str, Any], lang: str) -> list[str]:
    lines = [f"## {i18n.tr(lang, 'warnings_header')}", ""]
    warnings = facts["warnings"]
    if warnings:
        lines.extend(f"- `{w}`" for w in warnings)
    else:
        lines.append(i18n.tr(lang, "no_warnings"))
    lines.append("")
    return lines


def _presolve_section(facts: dict[str, Any], lang: str) -> list[str]:
    p = facts["presolve"]
    if not p or "rows" not in p:
        return []
    return [
        f"## {i18n.tr(lang, 'presolve_header')}", "",
        i18n.tr(lang, "presolve_line",
                rr=p.get("removed_rows", "?"), rc=p.get("removed_columns", "?"),
                pr=p.get("rows", "?"), pc=p.get("columns", "?"), pnz=p.get("nonzeros", "?")),
        "",
    ]


def _nondefault_section(facts: dict[str, Any], lang: str) -> list[str]:
    params = facts["non_default_parameters"]
    if not params:
        return []
    lines = [f"## {i18n.tr(lang, 'nondefault_header')}", ""]
    lines.extend(f"- `{k}` = {v}" for k, v in params.items())
    lines.append("")
    return lines


def _apply_section(facts: dict[str, Any], lang: str) -> list[str]:
    settings = facts.get("recommended_settings") or {}
    if not settings:
        return []
    stem = Path(facts["meta"].get("log_file", "log")).stem
    prm = f"{stem}_recommended.prm"
    lines = [f"## {i18n.tr(lang, 'apply_header')}", "",
             i18n.tr(lang, "apply_intro", prm=prm), "", "```python"]
    lines.extend(f'model.setParam("{p}", {v})' for p, v in settings.items())
    lines.append("```")
    lines.append("")
    return lines


def _comparison_section(facts: dict[str, Any], lang: str) -> list[str]:
    comp = facts.get("comparison")
    if not comp:
        return []
    lines = [f"## {i18n.tr(lang, 'compare_header')}", "",
             i18n.tr(lang, "compare_intro", file=Path(comp["baseline_file"]).name), "",
             i18n.tr(lang, "compare_table_header"), "|---|---|---|---|"]
    for row in comp["metrics"]:
        change = "—"
        if "delta" in row and row.get("delta") is not None:
            better = row.get("better")
            mark = "✅" if better else ("➖" if better is None else "⚠️")
            pct = f" ({row['pct']:+.0f}%)" if row.get("pct") is not None else ""
            change = f"{mark} {row['delta']:+,.4g}{pct}"
        lines.append(f"| {row['metric']} | {_fmt(row['baseline'])} | {_fmt(row['current'])} | {change} |")
    lines.append("")
    return lines


def _technical_sections(facts: dict[str, Any], lang: str) -> list[str]:
    lines: list[str] = []
    lines += _comparison_section(facts, lang)
    lines += _overview(facts, lang)
    lines += _model_section(facts, lang)
    lines += _coeff_section(facts, lang)
    lines += _warnings_section(facts, lang)
    lines += _findings_section(facts, lang)
    lines += _apply_section(facts, lang)
    lines += _presolve_section(facts, lang)
    lines += _nondefault_section(facts, lang)
    return lines


def render(facts: dict[str, Any], log_path: Path, language: str | None = None) -> str:
    meta = facts["meta"]
    lang = language or meta.get("language") or i18n.DEFAULT_LANGUAGE
    lines: list[str] = []
    lines.append(f"# {i18n.tr(lang, 'report_title')} — `{log_path}`")
    lines.append("")
    if meta.get("generated_at"):
        lines.append(f"*{i18n.tr(lang, 'generated_label')}: {meta['generated_at']}*")
        lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(f"## {i18n.tr(lang, 'explanation_header')}")
    lines.append("")
    lines.append(SUMMARY_START)
    lines.append(_placeholder(lang))
    lines.append(SUMMARY_END)
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("<details>")
    lines.append(f"<summary><strong>{i18n.tr(lang, 'tech_details_summary')}</strong></summary>")
    lines.append("")
    lines.extend(_technical_sections(facts, lang))
    lines.append("</details>")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(f"*{i18n.tr(lang, 'report_footer')}*")
    lines.append("")
    return "\n".join(lines)


def extract_explanation(report_text: str) -> str | None:
    lines = report_text.splitlines()
    start = end = None
    for i, line in enumerate(lines):
        if line.strip() == SUMMARY_START:
            start = i + 1
        elif line.strip() == SUMMARY_END:
            end = i
            break
    if start is None or end is None or end < start:
        return None
    notes = i18n.all_translations("regen_note")
    placeholders = i18n.all_translations("placeholder")
    body = "\n".join(
        ln for ln in lines[start:end] if ln.strip() not in notes
    ).strip()
    if not body or body in placeholders:
        return None
    return body


def write_outputs(
    facts: dict[str, Any], log_path: Path, output_dir: Path, language: str | None = None
) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = log_path.stem
    facts_path = output_dir / f"{stem}_log_facts.json"
    report_path = output_dir / f"{stem}_solve_tuning.md"
    lang = language or facts["meta"].get("language") or i18n.DEFAULT_LANGUAGE
    report_text = render(facts, log_path, lang)
    if report_path.exists():
        preserved = extract_explanation(report_path.read_text())
        if preserved is not None:
            note = i18n.tr(lang, "regen_note")
            report_text = report_text.replace(
                _placeholder(lang), f"{preserved}\n\n{note}", 1
            )
    facts_path.write_text(json.dumps(facts, indent=1, default=str))
    report_path.write_text(report_text)
    return report_path, facts_path
