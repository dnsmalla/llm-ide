"""
_helpers.py
───────────
Shared pytest helpers for the iis_summarization test suite.
"""

from __future__ import annotations

import pytest

try:
    import gurobipy  # noqa: F401

    GUROBI_AVAILABLE = True
except ImportError:
    GUROBI_AVAILABLE = False

requires_gurobi = pytest.mark.skipif(
    not GUROBI_AVAILABLE,
    reason="gurobipy not installed or no valid license",
)
