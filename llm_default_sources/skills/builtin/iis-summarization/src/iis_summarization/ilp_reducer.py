"""
ilp_reducer.py
──────────────
Helpers for producing a compact reduced ``.ilp`` file for the
summarizer subagent:

* :func:`family_collapse` — groups IIS constraint names by a template
  key (the name with trailing ``(i_t)`` / ``(i,t)`` indexing stripped)
  and returns a small set of representative names.
* :func:`write_subset_ilp` — serialises a chosen subset of the parsed
  IIS into a minimal ``.ilp`` file.
* :func:`verify_subset_infeasible` — solver-backed check that a chosen
  constraint subset of the original model is genuinely infeasible
  (used as Phase 5 of the large-model fast filter).

The first two are text-level operations with no Gurobi dependency;
:func:`verify_subset_infeasible` requires gurobipy.
"""

from __future__ import annotations

import contextlib
import logging
import re
from collections import OrderedDict
from pathlib import Path

from iis_summarization.models import ParsedILP

logger = logging.getLogger(__name__)

# Matches the last ``(…)`` or ``[…]`` group in a constraint name. We use
# this to strip index decorations like ``(0_0)``, ``(3__24)``, or
# ``(1, 26)`` when grouping constraints into families.
_LAST_INDEX_RE = re.compile(r"[\(\[][^()\[\]]*[\)\]]\s*$")

# Matches a variable token inside a constraint body. Accepts identifiers
# optionally followed by ``(…)`` indexing (e.g. ``v_p_hg(0_26)``). We use
# this to find which variables each kept constraint actually references,
# so we can filter the emitted ``Bounds`` section to only the relevant
# rows.
_VAR_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\([^()]*\))?")
_NON_VAR_TOKENS = frozenset({"inf", "infinity", "free"})


def family_key(name: str) -> str:
    """Return a template key for *name* with its trailing index stripped.

    ``c_e_FOO_bar(3__24)_`` → ``c_e_FOO_bar``
    ``c_u_BAZ(1, 26)``      → ``c_u_BAZ``
    ``noindex_name``        → ``noindex_name``
    """
    trimmed = name.rstrip("_ ")
    stripped = _LAST_INDEX_RE.sub("", trimmed)
    return stripped.rstrip("_ ") or name


def family_collapse(names: list[str], *, max_reps_per_family: int = 1) -> list[str]:
    """Group *names* by :func:`family_key` and keep at most N per family.

    Result is ordered: first-seen family first, first-seen instance
    first. Designed to produce a small, diverse set of constraint names
    that covers every name template present in the IIS.
    """
    by_family: OrderedDict[str, list[str]] = OrderedDict()
    for n in names:
        k = family_key(n)
        by_family.setdefault(k, []).append(n)

    out: list[str] = []
    for _, members in by_family.items():
        out.extend(members[:max_reps_per_family])
    return out


def _referenced_variables(bodies: list[str]) -> set[str]:
    """Return the set of variable tokens referenced in any of *bodies*.

    Numeric literals, the sense keywords (``<=`` / ``>=`` / ``=``) and
    the ``inf`` / ``free`` tokens are excluded. Matching is permissive:
    a variable with indexing like ``v_p_hg(0_26)`` is kept as a single
    token so it lines up with bound keys written as
    ``v_p_hg(0_26) free``.
    """
    referenced: set[str] = set()
    for body in bodies:
        for tok in _VAR_TOKEN_RE.findall(body):
            low = tok.lower()
            if low in _NON_VAR_TOKENS:
                continue
            try:
                float(tok)
                continue
            except ValueError:
                pass
            referenced.add(tok)
    return referenced


def write_subset_ilp(
    parsed_ilp: ParsedILP,
    keep_names: list[str],
    out_path: Path,
    header: str | None = None,
) -> Path:
    """Write a minimal ``.ilp`` containing only *keep_names* constraints.

    The resulting file is valid Gurobi LP-format for the summarizer
    agent: a ``Subject To`` section listing each retained constraint
    body, followed by a filtered ``Bounds`` section (only bounds whose
    variable actually appears in one of the kept bodies) and a filtered
    ``Binaries`` / ``Generals`` section (same filter).

    Filtering bounds is important on models with 100k+ IIS rows and
    tens of thousands of declared bounds — keeping the Bounds section
    verbatim would dominate the output file (~10k lines) and drown the
    actual infeasible structure for the summarizer.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)

    kept_bodies = [parsed_ilp.constraints.get(name, "") for name in keep_names]
    referenced_vars = _referenced_variables(kept_bodies)

    lines: list[str] = []
    if header:
        # `.ilp` and `.lp` use ``\`` to start comments.
        for comment_line in header.splitlines():
            lines.append(f"\\ {comment_line}")
    lines.append("\\ Minimal subset emitted by iis_summarization.ilp_reducer.")
    lines.append("Minimize")
    lines.append(" obj:")
    lines.append("Subject To")
    for name, body in zip(keep_names, kept_bodies, strict=True):
        lines.append(f" {name}: {body or '(body not available)'}")

    filtered_bounds = [
        bound_expr
        for var_name, bound_expr in parsed_ilp.bounds.items()
        if var_name in referenced_vars
    ]
    if filtered_bounds:
        lines.append("Bounds")
        for bound_expr in filtered_bounds:
            lines.append(f" {bound_expr}")

    filtered_binaries = [v for v in parsed_ilp.binary_vars if v in referenced_vars]
    if filtered_binaries:
        lines.append("Binaries")
        lines.append(" " + " ".join(filtered_binaries))

    filtered_integers = [v for v in parsed_ilp.integer_vars if v in referenced_vars]
    if filtered_integers:
        lines.append("Generals")
        lines.append(" " + " ".join(filtered_integers))

    lines.append("End")

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out_path


def verify_subset_infeasible(
    lp_file: Path,
    constraint_names: list[str],
    timeout: int = 30,
) -> bool:
    """Return True iff keeping only *constraint_names* leaves the model infeasible.

    Loads *lp_file*, removes every constraint not in *constraint_names*
    (variable bounds are kept — they are part of any IIS context), and
    optimizes. Only a definitive INFEASIBLE status returns True;
    feasible, time-limit, or error outcomes all return False so callers
    treat an unverifiable subset as "not proven infeasible".
    """
    if not constraint_names:
        return False

    from iis_summarization._gurobi import import_gurobi
    from iis_summarization.errors import GurobiUnavailableError

    try:
        gp, GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        logger.warning("verify_subset_infeasible: %s", exc)
        return False

    model = None
    try:
        model = gp.read(str(lp_file))
        model.setParam("OutputFlag", 0)
        model.setParam("TimeLimit", timeout)
        # Commit to INFEASIBLE vs UNBOUNDED instead of INF_OR_UNBD.
        model.setParam("DualReductions", 0)

        keep = set(constraint_names)
        for c in list(model.getConstrs()):
            if c.ConstrName not in keep:
                model.remove(c)
        model.update()
        model.optimize()
        return model.status == GRB.INFEASIBLE
    except gp.GurobiError as exc:
        logger.warning("verify_subset_infeasible: Gurobi error: %s", exc)
        return False
    finally:
        if model is not None:
            with contextlib.suppress(Exception):
                model.dispose()
