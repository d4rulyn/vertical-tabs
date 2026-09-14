#!/usr/bin/env python3
"""Static integration checks for the unpacked extension.

Five independent implementer agents wrote disjoint file groups, so the highest
risk is a module-boundary mismatch: an import that names an export nobody wrote,
an i18n key referenced but not defined, a DOM id used by a script but absent from
the HTML, or a manifest entry pointing at a missing file.

Pure stdlib, read-only. Run inside Docker:
  docker run --rm -v "$PWD":/work -w /work python:3.12-slim python tools/check_integration.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"

problems: list[tuple[str, str]] = []


def err(kind: str, msg: str) -> None:
    problems.append((kind, msg))


def js_files() -> list[Path]:
    return sorted(EXT.rglob("*.js"))


# --- 1. import specifiers resolve, and named imports exist as exports ---------

IMPORT_RE = re.compile(
    r"import\s+(?P<clause>[^'\"]*?)\s*from\s*['\"](?P<spec>[^'\"]+)['\"]", re.S
)
BARE_IMPORT_RE = re.compile(r"import\s*['\"](?P<spec>[^'\"]+)['\"]")
EXPORT_NAMED_RE = re.compile(
    r"^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)",
    re.M,
)
EXPORT_LIST_RE = re.compile(r"export\s*\{([^}]*)\}(?!\s*from)", re.M)
EXPORT_FROM_RE = re.compile(r"export\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]", re.M)
EXPORT_STAR_RE = re.compile(r"export\s*\*\s*from\s*['\"]([^'\"]+)['\"]", re.M)
EXPORT_DEFAULT_RE = re.compile(r"^\s*export\s+default\b", re.M)


def exports_of(path: Path, _seen: set[Path] | None = None) -> set[str]:
    """Named exports of a module, following `export ... from` re-exports."""
    seen = _seen or set()
    if path in seen or not path.exists():
        return set()
    seen.add(path)
    src = path.read_text(encoding="utf-8", errors="replace")
    names = set(EXPORT_NAMED_RE.findall(src))
    for block in EXPORT_LIST_RE.findall(src):
        for item in block.split(","):
            item = item.strip()
            if not item:
                continue
            names.add(item.split(" as ")[-1].strip())
    for block, spec in EXPORT_FROM_RE.findall(src):
        for item in block.split(","):
            item = item.strip()
            if item:
                names.add(item.split(" as ")[-1].strip())
    for spec in EXPORT_STAR_RE.findall(src):
        target = (path.parent / spec).resolve()
        names |= exports_of(target, seen)
    if EXPORT_DEFAULT_RE.search(src):
        names.add("default")
    return names


def parse_clause(clause: str) -> tuple[set[str], bool]:
    """Return (named imports, imports_namespace_or_default)."""
    named: set[str] = set()
    wildcard = False
    clause = clause.strip()
    if not clause:
        return named, wildcard
    brace = re.search(r"\{([^}]*)\}", clause)
    if brace:
        for item in brace.group(1).split(","):
            item = item.strip()
            if item:
                named.add(item.split(" as ")[0].strip())
        clause = clause[: brace.start()] + clause[brace.end():]
    if "*" in clause or clause.strip().strip(","):
        wildcard = True
    return named, wildcard


def check_imports() -> None:
    for f in js_files():
        src = f.read_text(encoding="utf-8", errors="replace")
        specs = [(m.group("spec"), m.group("clause")) for m in IMPORT_RE.finditer(src)]
        specs += [(m.group("spec"), "") for m in BARE_IMPORT_RE.finditer(src)]
        for spec, clause in specs:
            if not spec.startswith("."):
                err("import", f"{f.relative_to(ROOT)}: non-relative import {spec!r}")
                continue
            target = (f.parent / spec).resolve()
            if not target.exists():
                err("import", f"{f.relative_to(ROOT)}: imports missing file {spec!r}")
                continue
            named, wildcard = parse_clause(clause)
            if not named:
                continue
            available = exports_of(target)
            missing = named - available
            if missing:
                err(
                    "import",
                    f"{f.relative_to(ROOT)}: {spec!r} does not export "
                    + ", ".join(sorted(missing)),
                )


# --- 2. i18n: every referenced key is defined in en and ja -------------------

MSG_RE = re.compile(r"""(?:getMessage|\bt)\(\s*['"]([\w@]+)['"]""")
MSG_ATTR_RE = re.compile(r"""data-i18n(?:-[a-z]+)?=["']([\w@]+)["']""")
MANIFEST_MSG_RE = re.compile(r"__MSG_(\w+)__")


def check_i18n() -> None:
    locales = {}
    for lang in ("en", "ja"):
        p = EXT / "_locales" / lang / "messages.json"
        if not p.exists():
            err("i18n", f"missing {p.relative_to(ROOT)}")
            return
        locales[lang] = json.loads(p.read_text(encoding="utf-8"))

    only_en = set(locales["en"]) - set(locales["ja"])
    only_ja = set(locales["ja"]) - set(locales["en"])
    for k in sorted(only_en):
        err("i18n", f"key {k!r} present in en but not ja")
    for k in sorted(only_ja):
        err("i18n", f"key {k!r} present in ja but not en")

    used: set[str] = set()
    for f in list(js_files()) + list(EXT.rglob("*.html")):
        src = f.read_text(encoding="utf-8", errors="replace")
        used |= set(MSG_RE.findall(src))
        used |= set(MSG_ATTR_RE.findall(src))
    manifest = (EXT / "manifest.json").read_text(encoding="utf-8")
    used |= set(MANIFEST_MSG_RE.findall(manifest))

    for key in sorted(used):
        if key.startswith("@@"):
            continue
        if key not in locales["en"]:
            err("i18n", f"key {key!r} used in code but missing from _locales/en")

    unused = sorted(set(locales["en"]) - used)
    if unused:
        err("i18n-warn", f"{len(unused)} defined-but-unreferenced keys: {unused[:12]}")


# --- 3. manifest paths exist -------------------------------------------------

def check_manifest() -> None:
    m = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    paths: list[str] = []
    for key in ("icons",):
        paths += list(m.get(key, {}).values())
    action = m.get("action", {})
    paths += list(action.get("default_icon", {}).values())
    if "default_popup" in action:
        paths.append(action["default_popup"])
    if "side_panel" in m:
        paths.append(m["side_panel"]["default_path"])
    if "options_ui" in m:
        paths.append(m["options_ui"]["page"])
    if "background" in m:
        paths.append(m["background"]["service_worker"])
    for res in m.get("web_accessible_resources", []):
        paths += res.get("resources", [])
    for p in paths:
        if "*" in p:
            continue
        if not (EXT / p).exists():
            err("manifest", f"path {p!r} does not exist")
    if m.get("background", {}).get("type") != "module":
        err("manifest", 'background.type should be "module" (ES imports are used)')


# --- 4. DOM ids referenced by scripts exist in the HTML ----------------------

GETID_RE = re.compile(r"""getElementById\(\s*['"]([\w-]+)['"]""")
QUERY_ID_RE = re.compile(r"""querySelector(?:All)?\(\s*['"]#([\w-]+)""")
HTML_ID_RE = re.compile(r"""\bid=["']([\w-]+)["']""")


def check_dom_ids() -> None:
    for html in EXT.rglob("*.html"):
        ids = set(HTML_ID_RE.findall(html.read_text(encoding="utf-8", errors="replace")))
        folder = html.parent
        for js in sorted(folder.glob("*.js")):
            src = js.read_text(encoding="utf-8", errors="replace")
            referenced = set(GETID_RE.findall(src)) | set(QUERY_ID_RE.findall(src))
            for rid in sorted(referenced):
                if rid not in ids:
                    err(
                        "dom",
                        f"{js.relative_to(ROOT)}: #{rid} not in "
                        f"{html.relative_to(ROOT)} (may be created dynamically)",
                    )


# --- 5. accidental leftovers -------------------------------------------------

def check_leftovers() -> None:
    pat = re.compile(r"\bTODO\b|\bFIXME\b|\bXXX\b|NotImplemented|throw new Error\(['\"]not implemented")
    for f in js_files():
        for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if pat.search(line):
                err("leftover", f"{f.relative_to(ROOT)}:{n}: {line.strip()[:100]}")


def main() -> int:
    if not EXT.exists():
        print("extension/ not found", file=sys.stderr)
        return 2
    check_imports()
    check_i18n()
    check_manifest()
    check_dom_ids()
    check_leftovers()

    hard = [p for p in problems if p[0] not in ("i18n-warn", "dom")]
    by_kind: dict[str, list[str]] = {}
    for kind, msg in problems:
        by_kind.setdefault(kind, []).append(msg)
    for kind in sorted(by_kind):
        print(f"\n## {kind}  ({len(by_kind[kind])})")
        for msg in by_kind[kind][:40]:
            print("  -", msg)
        if len(by_kind[kind]) > 40:
            print(f"  … {len(by_kind[kind]) - 40} more")
    print(f"\nTotal: {len(problems)} findings ({len(hard)} hard)")
    return 1 if hard else 0


if __name__ == "__main__":
    raise SystemExit(main())
