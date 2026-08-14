"""Compare two parsed Gurobi logs (baseline vs current) on headline metrics.

Used to show whether a parameter / formulation change actually helped: did the
gap close, did runtime / nodes drop, did the status reach OPTIMAL?
"""

from __future__ import annotations

from typing import Any

# Metric → (label, lower_is_better). best_objective has no universal direction.
_METRICS: list[tuple[str, str, bool | None]] = [
    ("status", "Status", None),
    ("gap_pct", "Gap %", True),
    ("runtime_sec", "Runtime (s)", True),
    ("work_units", "Work units", True),
    ("nodes", "Nodes", True),
    ("best_objective", "Best objective", None),
    ("best_bound", "Best bound", None),
]


def compare(baseline: dict[str, Any], current: dict[str, Any], baseline_file: str) -> dict[str, Any]:
    bt = baseline.get("termination") or {}
    ct = current.get("termination") or {}
    rows: list[dict[str, Any]] = []
    for key, label, lower_better in _METRICS:
        b, c = bt.get(key), ct.get(key)
        if b is None and c is None:
            continue
        row: dict[str, Any] = {"metric": label, "baseline": b, "current": c}
        if lower_better is not None and isinstance(b, int | float) and isinstance(c, int | float):
            delta = c - b
            row["delta"] = delta
            row["pct"] = (100.0 * delta / b) if b else None
            # None when unchanged → neutral; else direction by lower_is_better.
            row["better"] = None if delta == 0 else ((c < b) if lower_better else (c > b))
        rows.append(row)
    return {"baseline_file": baseline_file, "metrics": rows}
