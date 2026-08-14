"""
models.py
─────────
Typed dataclasses shared across the IIS analysis pipeline.

These are data containers only (exempt from the interface-implementation
rule per the project design guidelines).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

ProblemType = Literal["data", "structure", "unknown"]


# ─────────────────────────────────────────────────────────────
# Step 1 — IIS runner
# ─────────────────────────────────────────────────────────────


@dataclass
class IISBoundInfo:
    """A variable bound that participates in the IIS."""

    varname: str
    bound_type: str  # "lb" or "ub"
    bound_value: float
    range_of: str = ""
    """Non-empty when *varname* is the internal slack Gurobi adds for a
    ranged constraint (``addRange`` stores ``L <= a'x <= U`` as an
    equality plus a slack named ``Rg<constrname>`` bounded by the range
    width). Holds the originating ranged constraint's name so reports
    never surface a variable the user did not create."""


@dataclass
class IISConstrInfo:
    """A constraint that participates in the IIS (queried via attributes)."""

    name: str
    sense: str
    rhs: float
    expr: str


@dataclass
class IISRunResult:
    """Outcome of ``computeIIS`` on an infeasible model."""

    success: bool
    ilp_file: Path | None = None
    elapsed_seconds: float = 0.0
    model_status: int = -1
    error_message: str = ""
    timed_out: bool = False
    iis_constraints: list[IISConstrInfo] = field(default_factory=list)
    """Constraints in the IIS, queried via ``IISConstr`` attribute."""
    iis_bounds: list[IISBoundInfo] = field(default_factory=list)
    """Variable bounds in the IIS, queried via ``IISLB``/``IISUB``."""
    has_default_lb_issues: list[str] = field(default_factory=list)
    """Variables with LB=0 in the IIS — Gurobi defaults LB to 0, which
    can cause unintentional infeasibility if the variable should be free."""
    iis_is_minimal: bool | None = None
    """True if Gurobi confirmed the IIS is irreducible (IISMinimal=1),
    False if it may contain redundant constraints, None if the attribute
    was unavailable."""
    used_lp_relaxation: bool = False
    """True when the model is a MIP whose LP relaxation was already
    infeasible, so the IIS was computed on the relaxation (every solve
    is an LP — much faster, and the result is a valid infeasible
    subsystem of the original MIP)."""
    has_nonlinear_constraints: bool = False
    """True when the model contains quadratic, SOS, or general/indicator
    constraints. Important caveat: feasRelax relaxes ONLY linear
    constraints and variable bounds (documented Gurobi limitation), so
    remediation amounts cover just the linear side of the conflict."""
    nonlinear_iis_members: list[str] = field(default_factory=list)
    """Quadratic / SOS / general constraints that participate in the IIS,
    queried via ``IISQConstr`` / ``IISSOS`` / ``IISGenConstr``. Each entry
    is prefixed with its type, e.g. ``"indicator: ind"``."""
    numerics_warnings: list[str] = field(default_factory=list)
    """Proactive numerics screen per Gurobi's scaling guidelines:
    non-empty when coefficient / RHS / bound magnitudes are outside the
    recommended ranges, meaning IIS membership may be unreliable and the
    model should be rescaled first."""
    used_seed: bool = False
    """True when a previous run's IIS names were verified still
    infeasible under today's data and used directly as the candidate
    set, skipping computeIIS (daily warm-start path)."""


# ─────────────────────────────────────────────────────────────
# Step 2 — ILP parser
# ─────────────────────────────────────────────────────────────


@dataclass
class ParsedILP:
    """Structured representation of a parsed Gurobi .ilp file."""

    constraints: dict[str, str] = field(default_factory=dict)
    """name → raw constraint text (RHS included)."""

    variable_refs: Counter[str] = field(default_factory=Counter)
    """constraint name → total variable-token count (occurrences, not distinct)."""

    bounds: dict[str, str] = field(default_factory=dict)
    """variable name → bound expression."""

    binary_vars: list[str] = field(default_factory=list)
    integer_vars: list[str] = field(default_factory=list)

    @property
    def constraint_count(self) -> int:
        return len(self.constraints)

    def top_constraints(self, n: int = 10) -> list[tuple[str, int]]:
        """Return the top-N constraints by variable-reference count."""
        return self.variable_refs.most_common(n)


# ─────────────────────────────────────────────────────────────
# Feasibility helper
# ─────────────────────────────────────────────────────────────


@dataclass
class FeasibilityResult:
    is_feasible: bool
    model_status: int
    solve_time: float
    error_message: str = ""


# ─────────────────────────────────────────────────────────────
# Step 3 — Iterative removal
# ─────────────────────────────────────────────────────────────


@dataclass
class RemovalResult:
    """Full outcome of the iterative constraint-removal process."""

    success: bool
    iterations_performed: int
    culprit_constraints: list[str] = field(default_factory=list)
    """Batch that finally made the model feasible (most likely culprits)."""

    all_removed_constraints: list[str] = field(default_factory=list)
    feasible_model_file: Path | None = None
    final_solve_time: float = 0.0
    message: str = ""


# ─────────────────────────────────────────────────────────────
# Step 4 — Deletion filter (Chinneck)
# ─────────────────────────────────────────────────────────────


@dataclass
class DeletionFilterResult:
    success: bool
    minimal_iis: list[str] = field(default_factory=list)
    """Constraints that survived the filter — the minimal blocking set."""

    dropped_as_redundant: list[str] = field(default_factory=list)
    """Constraints dropped because the remaining set was still infeasible."""

    iterations: int = 0
    elapsed_seconds: float = 0.0
    error_message: str = ""
    large_model_pipeline_used: bool = False
    phases_run: list[str] = field(default_factory=list)
    candidate_sizes: dict[str, int] = field(default_factory=dict)

    @property
    def original_count(self) -> int:
        return len(self.minimal_iis) + len(self.dropped_as_redundant)

    @property
    def reduction_ratio(self) -> float:
        if self.original_count == 0:
            return 0.0
        return len(self.dropped_as_redundant) / self.original_count


# ─────────────────────────────────────────────────────────────
# Step 5 — Classifier (data vs structure)
# ─────────────────────────────────────────────────────────────


@dataclass
class ConstraintClassification:
    constraint_name: str
    problem_type: ProblemType
    reason: str
    lhs_bounds: tuple[float, float] | None = None
    rhs_value: float | None = None
    sense: str | None = None


@dataclass
class ClassificationResult:
    success: bool
    classifications: list[ConstraintClassification] = field(default_factory=list)
    error_message: str = ""

    @property
    def data_problems(self) -> list[ConstraintClassification]:
        return [c for c in self.classifications if c.problem_type == "data"]

    @property
    def structure_problems(self) -> list[ConstraintClassification]:
        return [c for c in self.classifications if c.problem_type == "structure"]

    @property
    def counts(self) -> dict[str, int]:
        return {
            "data": len(self.data_problems),
            "structure": len(self.structure_problems),
            "unknown": sum(1 for c in self.classifications if c.problem_type == "unknown"),
        }


# ─────────────────────────────────────────────────────────────
# Step 6 — Semantic grouping
# ─────────────────────────────────────────────────────────────


@dataclass
class ConflictGroup:
    """One connected subsystem of the IIS."""

    group_id: int
    constraints: list[str] = field(default_factory=list)
    variables: list[str] = field(default_factory=list)

    @property
    def size(self) -> int:
        return len(self.constraints)


@dataclass
class SemanticGroupResult:
    success: bool
    groups: list[ConflictGroup] = field(default_factory=list)
    error_message: str = ""

    @property
    def group_count(self) -> int:
        return len(self.groups)

    @property
    def largest_group_size(self) -> int:
        return max((g.size for g in self.groups), default=0)


# ─────────────────────────────────────────────────────────────
# Step 7 — Relaxation (feasRelax)
# ─────────────────────────────────────────────────────────────


@dataclass
class ConstraintRelaxation:
    """Minimum relaxation needed for one constraint to be satisfiable."""

    constraint_name: str
    current_rhs: float
    sense: str
    violation: float
    direction: str

    @property
    def suggested_new_rhs(self) -> float:
        if self.direction.startswith("increase"):
            return self.current_rhs + self.violation
        if self.direction.startswith("decrease"):
            return self.current_rhs - self.violation
        return self.current_rhs


@dataclass
class VariableBoundRelaxation:
    """How much a variable's bounds needed to be relaxed to restore feasibility.

    Populated when :mod:`relaxation` runs ``feasRelax`` with ``vrelax=True``
    as a fallback, typically because the model was diagnosed as unbounded.
    """

    variable_name: str
    current_lb: float
    current_ub: float
    lb_violation: float = 0.0
    ub_violation: float = 0.0
    range_of: str = ""
    """Non-empty when *variable_name* is the internal slack of a ranged
    constraint — loosening its UB WIDENS the range ``[L, U]`` of that
    constraint rather than changing a real variable's bound."""


@dataclass
class RelaxationResult:
    success: bool
    constraint_relaxations: list[ConstraintRelaxation] = field(default_factory=list)
    variable_bound_relaxations: list[VariableBoundRelaxation] = field(default_factory=list)
    total_violation: float = 0.0
    unbounded_detected: bool = False
    """True when feasRelax initially returned UNBOUNDED, triggering the
    variable-bound-relaxation fallback. Signals that the model is unbounded
    rather than classically infeasible."""

    fix_verified: bool | None = None
    """True when applying the suggested RHS/bound changes to a fresh copy
    of the model and re-optimizing produced a FEASIBLE model — i.e. the
    recommendation is certified, not just computed. False when the
    verification solve did NOT reach feasibility; None when verification
    was skipped (e.g. no relaxations to apply)."""

    fix_verification_message: str = ""

    indicator_relaxations: list[ConstraintRelaxation] = field(default_factory=list)
    """Minimum RHS deltas for INDICATOR constraints in the IIS, computed
    via slack injection (feasRelax cannot relax general constraints).
    These are an ALTERNATIVE fix to the linear changes, not additive."""

    indicator_fix_verified: bool | None = None
    indicator_fix_message: str = ""

    error_message: str = ""


# ─────────────────────────────────────────────────────────────
# Step 3.5 — Batch refinement (add-back isolation)
# ─────────────────────────────────────────────────────────────


@dataclass
class AddBackStep:
    """One step of the add-back trace: a constraint was re-introduced
    into the feasible probe LP and the feasibility result was recorded."""

    constraint_name: str
    is_feasible: bool
    solve_time: float = 0.0


@dataclass
class BatchRefinementResult:
    """Outcome of isolating the root-cause constraint from a feasible-making batch."""

    success: bool
    root_cause: str | None = None
    """Single constraint whose re-addition flipped the model back to infeasible."""

    joint_culprits: list[str] = field(default_factory=list)
    """Populated when no single add-back caused infeasibility — the batch is
    jointly required (multiple constraints together cause the conflict)."""

    add_back_trace: list[AddBackStep] = field(default_factory=list)
    """Ordered log of each add-back attempt and its feasibility result."""

    elapsed_seconds: float = 0.0
    error_message: str = ""

    @property
    def has_root_cause(self) -> bool:
        return self.success and self.root_cause is not None


# ─────────────────────────────────────────────────────────────
# Step 5.5 — value-propagation forcing chain
# ─────────────────────────────────────────────────────────────


@dataclass
class TraceStep:
    """One forced implication discovered by bound propagation.

    Records that *constraint_name*, given the domains known so far,
    tightened *variable* from *old_domain* to *new_domain*. The
    ``explanation`` is a one-line human-readable rendering with numbers.
    """

    constraint_name: str
    variable: str
    old_domain: tuple[float, float]
    new_domain: tuple[float, float]
    explanation: str


@dataclass
class Contradiction:
    """The first point where propagation produced an empty domain.

    A variable was driven to require ``lower <= variable <= upper`` with
    ``lower > upper`` — no feasible value exists. *constraint_name* is the
    constraint whose implication closed the gap. This contradiction is
    sound (real), but propagation is order-dependent: it is the first
    empty domain reached, not provably the only or root-most one.
    """

    variable: str
    constraint_name: str
    lower: float
    upper: float
    detail: str
    lb_is_default: bool = False
    """True when the conflicting lower bound is Gurobi's default 0 on a
    continuous variable — a common unintentional source of infeasibility."""


@dataclass
class PropagationTrace:
    """Result of Step 5.5 feasibility-based bound tightening.

    ``reached_contradiction`` is True when propagation isolated an empty
    domain (a fully numeric "why"). When False the conflict is
    combinatorial — beyond what bound propagation alone can prove — and
    the report falls back to the constraint list.
    """

    success: bool = False
    steps: list[TraceStep] = field(default_factory=list)
    contradiction: Contradiction | None = None
    reached_contradiction: bool = False
    error_message: str = ""
