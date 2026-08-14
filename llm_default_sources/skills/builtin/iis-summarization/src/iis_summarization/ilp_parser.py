"""
ilp_parser.py
─────────────
Step 2 of the IIS analysis pipeline.

Parses a Gurobi .ilp file and returns a :class:`ParsedILP` together
with a variable-reference frequency counter for each constraint.

The parser is purely text-based and has no gurobipy dependency.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from iis_summarization.interfaces import IILPParser
from iis_summarization.models import ParsedILP

logger = logging.getLogger(__name__)


_VARIABLE_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_()\[\].,_]*")

_BOUND_NON_VARIABLE_TOKENS = frozenset(
    {
        "inf",
        "infinity",
        "-inf",
        "+inf",
        "free",
        "=",
        "<=",
        ">=",
        "<",
        ">",
    }
)

_CONSTRAINT_KEYWORDS = frozenset({"inf", "infinity"})


class ILPParser(IILPParser):
    """Default implementation of :class:`IILPParser`."""

    @classmethod
    def create(cls) -> IILPParser:
        """Factory returning an :class:`IILPParser`."""
        return cls()

    def parse(self, ilp_file: Path) -> ParsedILP:
        return _parse_ilp_impl(ilp_file)


def parse_ilp(ilp_file: str | Path) -> ParsedILP:
    """
    Functional convenience wrapper for :class:`ILPParser`.

    Parameters
    ----------
    ilp_file
        Path to a Gurobi .ilp file.

    Returns
    -------
    ParsedILP
    """
    return ILPParser.create().parse(Path(ilp_file))


def _extract_bound_variable(line: str) -> str | None:
    """
    Return the variable name in a bound-declaration line, or ``None``.

    Strategy: tokenize the line, drop operators / numeric literals, and
    return the first remaining identifier.
    """
    normalized = line.replace("<=", " ").replace(">=", " ").replace("=", " ")
    for tok in normalized.split():
        low = tok.lower()
        if low in _BOUND_NON_VARIABLE_TOKENS:
            continue
        try:
            float(tok)
            continue
        except ValueError:
            pass
        if _VARIABLE_PATTERN.fullmatch(tok):
            return tok
    return None


def _parse_ilp_impl(ilp_file: Path) -> ParsedILP:
    if not ilp_file.exists():
        raise FileNotFoundError(f"ILP file not found: {ilp_file}")

    raw_text = ilp_file.read_text(encoding="utf-8")
    lines = raw_text.splitlines()

    parsed = ParsedILP()
    section: str | None = None
    current_name: str | None = None
    current_body: list[str] = []

    def flush_constraint() -> None:
        nonlocal current_name, current_body
        if current_name and current_body:
            body = " ".join(current_body).strip()
            parsed.constraints[current_name] = body
            tokens = _VARIABLE_PATTERN.findall(body)
            real_vars = [t for t in tokens if t.lower() not in _CONSTRAINT_KEYWORDS]
            parsed.variable_refs[current_name] = len(real_vars)
        current_name = None
        current_body = []

    for raw_line in lines:
        line = raw_line.strip()
        lower = line.lower()

        if not line or line.startswith("\\"):
            continue

        if lower in ("subject to", "s.t.", "st"):
            flush_constraint()
            section = "constraints"
            continue

        if lower == "bounds":
            flush_constraint()
            section = "bounds"
            continue

        if lower in ("binary", "binaries"):
            flush_constraint()
            section = "binary"
            continue

        if lower in ("general", "generals", "integer", "integers"):
            flush_constraint()
            section = "integer"
            continue

        if lower == "end":
            flush_constraint()
            section = None
            continue

        if section == "constraints":
            if ":" in line:
                flush_constraint()
                colon_idx = line.index(":")
                current_name = line[:colon_idx].strip()
                rest = line[colon_idx + 1 :].strip()
                if rest:
                    current_body.append(rest)
            elif current_name:
                current_body.append(line)

        elif section == "bounds":
            var_name = _extract_bound_variable(line)
            if var_name:
                parsed.bounds[var_name] = line

        elif section == "binary":
            parsed.binary_vars.extend(line.split())

        elif section == "integer":
            parsed.integer_vars.extend(line.split())

    flush_constraint()
    return parsed
