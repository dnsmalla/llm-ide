"""Encoding-safe text reader for solver logs.

Logs from Japanese Windows environments may be CP932 / Shift-JIS rather than
UTF-8. Reading must never crash on an odd encoding, so several are tried in
order; ``latin-1`` always decodes and is the final fallback.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)

_TEXT_ENCODINGS: tuple[str, ...] = ("utf-8-sig", "utf-8", "cp932", "shift_jis", "latin-1")


def read_text_safe(path: str | Path) -> str | None:
    """Read a text file trying several encodings; return ``None`` on failure."""
    p = Path(path)
    try:
        data = p.read_bytes()
    except OSError as exc:
        log.warning("could not read %s: %s", p, exc)
        return None
    for enc in _TEXT_ENCODINGS:
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    log.warning("could not decode %s with any known encoding", p)
    return None
