"""
iis_summarization
─────────────────
Diagnose infeasible Gurobi LP/MIP models and produce an actionable
remediation report (minimal IIS, data-vs-structure classification,
conflict subsystems, minimum relaxation amounts, ranked fix plan).

Public API
──────────
High-level entry point::

    from iis_summarization import Analyzer, run_analysis

Pipeline functions::

    from iis_summarization import (
        run_iis,
        parse_ilp,
        test_feasibility,
        iterative_removal,
        minimize_iis,
        classify_iis_constraints,
        group_by_shared_variables,
        compute_relaxations,
        generate_report,
    )

Result dataclasses (re-exported from ``iis_summarization.models``)::

    from iis_summarization import (
        IISRunResult,
        ParsedILP,
        FeasibilityResult,
        RemovalResult,
        DeletionFilterResult,
        ClassificationResult,
        SemanticGroupResult,
        RelaxationResult,
    )
"""

from __future__ import annotations

from iis_summarization.analyzer import Analyzer, run_analysis
from iis_summarization.classifier import classify_iis_constraints
from iis_summarization.constraint_remover import iterative_removal
from iis_summarization.deletion_filter import minimize_iis
from iis_summarization.feasibility import test_feasibility
from iis_summarization.iis_runner import run_iis
from iis_summarization.ilp_parser import parse_ilp
from iis_summarization.models import (
    ClassificationResult,
    ConflictGroup,
    ConstraintClassification,
    ConstraintRelaxation,
    DeletionFilterResult,
    FeasibilityResult,
    IISRunResult,
    ParsedILP,
    RelaxationResult,
    RemovalResult,
    SemanticGroupResult,
)
from iis_summarization.relaxation import compute_relaxations
from iis_summarization.report_generator import generate_report
from iis_summarization.semantic_groups import group_by_shared_variables

__version__ = "1.0.0"

__all__ = [
    "Analyzer",
    "ClassificationResult",
    "ConflictGroup",
    "ConstraintClassification",
    "ConstraintRelaxation",
    "DeletionFilterResult",
    "FeasibilityResult",
    "IISRunResult",
    "ParsedILP",
    "RelaxationResult",
    "RemovalResult",
    "SemanticGroupResult",
    "__version__",
    "classify_iis_constraints",
    "compute_relaxations",
    "generate_report",
    "group_by_shared_variables",
    "iterative_removal",
    "minimize_iis",
    "parse_ilp",
    "run_analysis",
    "run_iis",
    "test_feasibility",
]
