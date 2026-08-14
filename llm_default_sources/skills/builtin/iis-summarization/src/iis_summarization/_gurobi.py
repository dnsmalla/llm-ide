"""
_gurobi.py
──────────
Private helper for lazily importing :mod:`gurobipy`.

Importing at module load time would force every consumer of this package
to have gurobipy installed, even in tests that don't touch the solver.
Step modules call :func:`import_gurobi` inside their public entry points.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from iis_summarization.errors import GurobiUnavailableError

if TYPE_CHECKING:  # pragma: no cover - only for type-checkers
    pass


def import_gurobi() -> tuple[Any, Any]:
    """
    Return ``(gurobipy, gurobipy.GRB)`` or raise :class:`GurobiUnavailableError`.
    """
    try:
        import gurobipy as gp  # noqa: PLC0415 - lazy import is intentional
        from gurobipy import GRB  # noqa: PLC0415
    except ImportError as exc:
        raise GurobiUnavailableError(f"gurobipy is not available: {exc}") from exc
    return gp, GRB
