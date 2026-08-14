"""
license_resolver.py
───────────────────
Discover a usable Gurobi license file at runtime so the skill works on any
host without the user having to hard-code a path.

Search order (first hit wins):

1. ``$GRB_LICENSE_FILE`` if it points to an existing file.
2. ``$HOME/gurobi.lic``
3. ``$GUROBI_HOME/gurobi.lic`` (e.g. ``/opt/gurobi1202/linux64/gurobi.lic``)
4. ``/opt/gurobi/gurobi.lic``
5. ``/opt/gurobi*/linux64/gurobi.lic`` — glob fallback, highest version wins.

This mirrors Gurobi's own lookup, but also recovers when
``GRB_LICENSE_FILE`` is unset and ``GUROBI_HOME`` only points to the
distribution root.

On success the resolver exports ``GRB_LICENSE_FILE`` into the current
process environment so ``gurobipy`` picks the same file up when imported.
The resolution result is cached for the lifetime of the process.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LicenseInfo:
    """Where the license came from and what it points to."""

    path: Path
    source: str  # one of: GRB_LICENSE_FILE, HOME, GUROBI_HOME, /opt/gurobi, /opt/gurobi*


_cached: LicenseInfo | None = None
_cache_set = False


def _version_key(p: Path) -> tuple[int, ...]:
    """Sort key that prefers the highest /opt/gurobiNNNN install."""
    match = re.search(r"gurobi(\d+)", str(p))
    return (int(match.group(1)),) if match else (0,)


def _candidates() -> list[tuple[Path, str]]:
    paths: list[tuple[Path, str]] = []

    env_lic = os.environ.get("GRB_LICENSE_FILE")
    if env_lic:
        paths.append((Path(env_lic), "GRB_LICENSE_FILE"))

    home = os.environ.get("HOME")
    if home:
        paths.append((Path(home) / "gurobi.lic", "HOME"))

    gurobi_home = os.environ.get("GUROBI_HOME")
    if gurobi_home:
        paths.append((Path(gurobi_home) / "gurobi.lic", "GUROBI_HOME"))

    paths.append((Path("/opt/gurobi/gurobi.lic"), "/opt/gurobi"))

    # Glob fallback — pick the highest installed version.
    glob_hits = sorted(
        Path("/opt").glob("gurobi*/linux64/gurobi.lic"),
        key=_version_key,
        reverse=True,
    )
    for hit in glob_hits:
        paths.append((hit, "/opt/gurobi*"))

    return paths


def resolve_license(*, force: bool = False) -> LicenseInfo | None:
    """
    Find a Gurobi license on this host and export ``GRB_LICENSE_FILE``.

    Returns the resolved :class:`LicenseInfo`, or ``None`` if no license
    file exists anywhere in the search path. ``None`` is **not** an error
    — the caller may still attempt to import ``gurobipy`` (a token-server
    or cloud license may be configured via other means), but a clear log
    line will have been emitted.

    Parameters
    ----------
    force : bool
        Bypass the in-process cache and re-scan. Useful in tests.
    """
    global _cached, _cache_set
    if _cache_set and not force:
        return _cached

    seen: set[Path] = set()
    for path, source in _candidates():
        resolved = path.expanduser()
        if resolved in seen:
            continue
        seen.add(resolved)
        if not resolved.is_file():
            continue

        info = LicenseInfo(path=resolved, source=source)
        # Export so gurobipy and any child processes inherit the choice.
        os.environ["GRB_LICENSE_FILE"] = str(resolved)
        logger.info(
            "Gurobi license resolved from %s: %s",
            info.source,
            info.path,
        )
        _cached = info
        _cache_set = True
        return info

    logger.warning(
        "No Gurobi license file found in $GRB_LICENSE_FILE, $HOME/gurobi.lic, "
        "$GUROBI_HOME/gurobi.lic, /opt/gurobi/gurobi.lic, or /opt/gurobi*/linux64/gurobi.lic. "
        "Gurobi calls will fail unless a token-server / cloud license is configured. "
        "See README — Gurobi license setup & troubleshooting."
    )
    _cached = None
    _cache_set = True
    return None
