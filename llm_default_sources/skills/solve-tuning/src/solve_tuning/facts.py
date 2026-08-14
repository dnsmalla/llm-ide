"""Assemble the compact facts.json the summarizer subagent reads.

Everything the engine learned from the log (and, when supplied, the model file)
plus the derived findings, in a few KB — never the raw log or model."""

from __future__ import annotations

from typing import Any


def _ratio(rng: list[float] | None) -> float | None:
    if not rng:
        return None
    lo, hi = abs(rng[0]), abs(rng[1])
    return hi / lo if lo > 0 else None


def build_facts(
    parsed: dict[str, Any],
    assessment: dict[str, Any],
    meta: dict[str, Any],
    model_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    model_info = model_info or {}

    # Coefficient ranges: the model file is exact, so it wins where present.
    log_stats = parsed.get("coefficient_stats") or {}
    model_stats = model_info.get("coefficient_stats") or {}
    stats = {**log_stats, **model_stats}
    ratios = {k: _ratio(v) for k, v in stats.items()}

    # Structural facts: prefer the model file, fall back to what the log showed.
    sizes = model_info.get("sizes") or parsed.get("sizes")
    var_types = model_info.get("variable_types") or parsed.get("variable_types")
    is_mip = model_info.get("is_mip", parsed.get("is_mip", False))

    return {
        "meta": {
            **meta,
            "version": parsed.get("version"),
            "platform": parsed.get("platform"),
            "is_mip": is_mip,
            "sizes": sizes,
            "variable_types": var_types,
            "fingerprint": parsed.get("fingerprint"),
            "obj_sense": model_info.get("obj_sense"),
            "model_file": model_info.get("model_file"),
        },
        "coefficient_stats": {
            "ranges": stats,
            "ratios": ratios,
            "source": "model file" if model_stats else "log",
        },
        "model_structure": {
            "model_class": model_info.get("model_class"),
            "is_linear": model_info.get("is_linear"),
            "density": model_info.get("density"),
            "n_quad_constrs": model_info.get("n_quad_constrs"),
            "n_quad_obj_terms": model_info.get("n_quad_obj_terms"),
            "n_sos": model_info.get("n_sos"),
            "n_gen_constrs": model_info.get("n_gen_constrs"),
            "gen_constraints": model_info.get("gen_constraints"),
            "matrix_extremes": model_info.get("matrix_extremes"),
            "big_m_constraints": model_info.get("big_m_constraints"),
            "scan_capped": model_info.get("scan_capped"),
        } if model_info else {},
        "presolve": parsed.get("presolve") or {},
        "root_relaxation": parsed.get("root_relaxation"),
        "cutting_planes": parsed.get("cutting_planes") or {},
        "termination": parsed.get("termination") or {},
        "warnings": parsed.get("warnings") or [],
        "non_default_parameters": parsed.get("set_parameters") or {},
        "findings": assessment.get("findings", []),
        "healthy": assessment.get("healthy", False),
    }
