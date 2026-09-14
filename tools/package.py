#!/usr/bin/env python3
"""Builds the distributable zip.

Run it the way everything else in this repo runs — inside a container:

    docker run --rm -v "$PWD":/work -w /work python:3.12-slim python tools/package.py

The archive holds the CONTENTS of `extension/`, with `manifest.json` at the root, which
is what both "Load unpacked" (after unzipping) and the Chrome Web Store expect. Nothing
outside `extension/` goes in: no tests, no specs, no `.agent/` notes, no logs.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import zipfile

REPO = pathlib.Path(__file__).resolve().parent.parent
EXT = REPO / "extension"
DIST = REPO / "dist"
SLUG = "vertical-tabs"

# Anything matching these never belongs in a published extension.
EXCLUDED_NAMES = {".DS_Store", "Thumbs.db", ".gitkeep"}
EXCLUDED_SUFFIXES = {".log", ".map", ".orig", ".rej", ".bak"}


def collect() -> list[pathlib.Path]:
    files = []
    for path in sorted(EXT.rglob("*")):
        if not path.is_file():
            continue
        if path.name in EXCLUDED_NAMES or path.suffix in EXCLUDED_SUFFIXES:
            continue
        if any(part.startswith(".") for part in path.relative_to(EXT).parts):
            continue
        files.append(path)
    return files


def check(files: list[pathlib.Path], manifest: dict) -> list[str]:
    """Things that would be found by a reviewer, or by the user, instead of by us."""
    problems = []

    if not (EXT / "manifest.json").exists():
        problems.append("extension/manifest.json is missing")

    default_locale = manifest.get("default_locale")
    if default_locale and not (EXT / "_locales" / default_locale / "messages.json").exists():
        problems.append(f"default_locale is {default_locale!r} but _locales/{default_locale} is not there")

    # Every path the manifest names must exist, or Chrome refuses the package.
    named = []
    for key in ("icons", "action"):
        block = manifest.get(key) or {}
        icons = block.get("default_icon") if key == "action" else block
        if isinstance(icons, dict):
            named.extend(icons.values())
    side_panel = (manifest.get("side_panel") or {}).get("default_path")
    if side_panel:
        named.append(side_panel)
    background = (manifest.get("background") or {}).get("service_worker")
    if background:
        named.append(background)
    options = (manifest.get("options_ui") or {}).get("page")
    if options:
        named.append(options)
    for rel in named:
        if not (EXT / rel).exists():
            problems.append(f"manifest names {rel}, which is not in extension/")

    if not files:
        problems.append("nothing to package")
    return problems


def main() -> int:
    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    files = collect()

    problems = check(files, manifest)
    if problems:
        for problem in problems:
            print(f"  ✘ {problem}")
        return 1

    DIST.mkdir(exist_ok=True)
    out = DIST / f"{SLUG}-{version}.zip"
    # Deterministic: a fixed timestamp and sorted entries, so rebuilding the same commit
    # produces the same bytes and a checksum means something.
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            info = zipfile.ZipInfo(str(path.relative_to(EXT)), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())

    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"  {out.relative_to(REPO)}")
    print(f"  {len(files)} files, {out.stat().st_size / 1024:.0f} KB")
    print(f"  sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
