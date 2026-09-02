#!/usr/bin/env python3
"""Spawn a plugin's graph-engine.json the way the Mac app does, and check it
produces canonical graph JSON.

Why this exists: the app's `PluginGraphEngine` resolves a bare command name
through `/usr/bin/env`, which needs the program as its FIRST ARGUMENT. That was
omitted, so `{"command": "node", "args": ["cli.js", ...]}` ran as
`env cli.js ...` — the interpreter silently dropped, and every plugin using the
documented bare-name form could never run. Nothing caught it because no test
ever spawned a real manifest. This does.

Usage:
    scripts/verify-graph-engine-manifest.py <plugin-dir> [--docs <dir>]

Exits non-zero on any failure, so it can gate a commit.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile

import logging
from logging import getLogger
from pathlib import Path

logger = getLogger(__name__)

# Must stay in step with `GraphEngineManifest.supportedSchemaVersion`.
SUPPORTED_SCHEMA_VERSION = 1
REQUIRED_COMMANDS = ("scanCode", "docMemory")


def resolve_invocation(command: str, args: list[str], plugin_root: Path) -> tuple[str, list[str]]:
    """Mirror `PluginGraphEngine.resolveExecutable`.

    A bare name goes through `env` WITH the command prepended; an absolute or
    relative path is executed directly. A relative path must stay inside the
    plugin directory.
    """
    if command.startswith("/"):
        return command, args
    if "/" in command:
        candidate = (plugin_root / command).resolve()
        base = plugin_root.resolve()
        if candidate != base and base not in candidate.parents:
            raise ValueError(f"command escapes the plugin directory: {command}")
        return str(candidate), args
    return "/usr/bin/env", [command] + args


def substitute(args: list[str], values: dict[str, str]) -> list[str]:
    out = []
    for arg in args:
        for key, value in values.items():
            arg = arg.replace(key, value)
        out.append(arg)
    return out


def check_command(
    name: str, spec: dict, plugin_root: Path, repo: Path, docs: Path, out_dir: Path
) -> bool:
    out_path = out_dir / f"{name}.json"
    values = {
        "{repo}": str(repo),
        "{root}": str(docs),
        "{roots}": str(docs),
        "{out}": str(out_path),
    }
    try:
        executable, args = resolve_invocation(
            spec["command"], substitute(spec.get("args", []), values), plugin_root
        )
    except ValueError as error:
        logger.info(f"  FAIL {name}: {error}")
        return False

    try:
        completed = subprocess.run(
            [executable] + args,
            cwd=plugin_root,
            capture_output=True,
            text=True,
            timeout=spec.get("timeoutSeconds", 300),
        )
    except FileNotFoundError as error:
        logger.info(f"  FAIL {name}: could not start — {error}")
        return False
    except subprocess.TimeoutExpired:
        logger.info(f"  FAIL {name}: timed out")
        return False

    if completed.returncode != 0:
        detail = (completed.stderr or "").strip().splitlines()
        logger.info(
            f"  FAIL {name}: exited {completed.returncode}" + (f" — {detail[-1]}" if detail else "")
        )
        return False
    if not out_path.exists():
        logger.info(f"  FAIL {name}: wrote no graph to {out_path.name}")
        return False

    try:
        document = json.loads(out_path.read_text())
    except json.JSONDecodeError as error:
        logger.info(f"  FAIL {name}: output is not JSON — {error}")
        return False

    for field in ("nodes", "edges"):
        if not isinstance(document.get(field), list):
            logger.info(
                f"  FAIL {name}: output has no '{field}' array " "(not the canonical graph schema)"
            )
            return False

    extra = ""
    if "chunks" in document:
        chunks = document["chunks"]
        extra = f", {len(chunks)} chunks"
        # The app needs chunk bodies to resolve doc->code links at all.
        if name == "docMemory" and chunks and not any(c.get("body") for c in chunks):
            logger.info(
                f"  FAIL {name}: every chunk has an empty body, so no "
                "doc->code link can ever be resolved"
            )
            return False
    logger.info(
        f"  ok   {name}: {len(document['nodes'])} nodes, " f"{len(document['edges'])} edges{extra}"
    )
    return True


def main() -> int:
    # Bare messages on stdout: this is a gate, so its output is the report.
    # Without a handler the logger swallows everything and the script exits 0
    # silently, which is exactly the kind of quiet pass it exists to prevent.
    logging.basicConfig(level=logging.INFO, format="%(message)s",
                        stream=sys.stdout)
    parser = argparse.ArgumentParser()
    parser.add_argument("plugin_dir", type=Path)
    parser.add_argument(
        "--docs",
        type=Path,
        default=None,
        help="folder of documents for docMemory (default: the "
        "plugin's own docs/, else the plugin root)",
    )
    options = parser.parse_args()

    plugin_root = options.plugin_dir.resolve()
    manifest_path = plugin_root / "graph-engine.json"
    if not manifest_path.exists():
        logger.info(f"no graph-engine.json in {plugin_root}")
        return 2

    manifest = json.loads(manifest_path.read_text())
    logger.info(
        f"graph-engine.json: {manifest.get('name')} "
        f"(schemaVersion {manifest.get('schemaVersion')})"
    )

    if manifest.get("schemaVersion") != SUPPORTED_SCHEMA_VERSION:
        logger.info(
            f"  FAIL unsupported schemaVersion "
            f"(this checker understands {SUPPORTED_SCHEMA_VERSION})"
        )
        return 1

    commands = manifest.get("commands") or {}
    missing = [name for name in REQUIRED_COMMANDS if name not in commands]
    if missing:
        logger.info(f"  FAIL missing required command(s): {', '.join(missing)}")
        return 1

    docs = options.docs or (
        plugin_root / "docs" if (plugin_root / "docs").is_dir() else plugin_root
    )
    out_dir = Path(tempfile.mkdtemp(prefix="graph-engine-check-", dir=Path.cwd()))
    try:
        ok = all(
            check_command(name, spec, plugin_root, plugin_root, docs.resolve(), out_dir)
            for name, spec in commands.items()
            if name in REQUIRED_COMMANDS or name == "merge"
        )
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    logger.info("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
