"""The designer's bridge into threedstep, running under Pyodide.

Everything crossing into JavaScript is a JSON string or plain text, so the
browser side never holds a Python proxy it has to free.  This module is the
only Python the designer adds; it is a thin shim over the package so the
renderer itself stays the command line's code.
"""
from __future__ import annotations

import json
import shutil
from dataclasses import asdict
from pathlib import Path, PurePosixPath

import threedstep
import threedstep.config as _config
from threedstep.config import check_ids, load_project, load_theme, tomllib
from threedstep.renderer import build_page

_PKG = Path(_config.__file__).resolve().parent
_BUNDLED_THEMES = _PKG / "themes"

# Where the project TOML and its models are written before loading. The theme
# files opened with the project are written where its theme_dir points from
# here (above it, for a docs site's theme_dir = ".."), and nothing else is, so
# a theme resolves as it does for the saved project on disk: from those files,
# else from the bundled themes.
WORK = Path("/threedstep/work")
PROJECT_PATH = WORK / "project.toml"

_DEFAULT_THEME_DIR = "./themes"
_FONT_SUFFIXES = (".woff2", ".woff", ".ttf", ".otf")

# The theme files opened with the project, by file name: theme TOMLs (a docs
# site's own theme) and the font files they name. set_theme_files replaces
# them; every call that resolves a theme first writes them where the
# project's theme_dir points (_place_themes), and _placed lists what it wrote.
_opened: dict[str, bytes] = {}
_placed: list[Path] = []


def version() -> str:
    """The package version, for the About box."""
    return threedstep.__version__


# ── Themes ───────────────────────────────────────────────────────────

def _slugs(directory: Path) -> list[str]:
    """TOML stems in a stable, human order.

    Sorting Path objects is not portable: Windows compares them case-insensitively
    and other platforms do not, so the designer's dropdowns would be ordered one
    way locally and another way on the hosted site.
    """
    return sorted((p.stem for p in directory.glob("*.toml")), key=str.lower)


def _file_bytes(files) -> dict[str, bytes]:
    """A files argument as plain bytes: a dict of bytes-likes from Python, or
    a JS object or Map of Uint8Arrays from the designer."""
    if hasattr(files, "to_py"):
        files = files.to_py()
    return {str(name): bytes(data) for name, data in (files or {}).items()}


def _toml(data: bytes) -> dict:
    """An opened theme file's tables, or nothing when it does not parse:
    load_theme reports that when the theme is used."""
    try:
        return tomllib.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        return {}


def _opened_themes() -> dict[str, bytes]:
    """The opened theme TOMLs by theme name: the file name without .toml."""
    return {name[:-5]: data for name, data in _opened.items() if name.lower().endswith(".toml") and name[:-5]}


def _font_files(data: bytes) -> list[str]:
    """The font files a theme's [font] and [font.label] name, as written."""
    font = _toml(data).get("font")
    tables = [font, font.get("label")] if isinstance(font, dict) else []
    return [t["file"] for t in tables if isinstance(t, dict) and isinstance(t.get("file"), str) and t["file"]]


def _unplace() -> None:
    while _placed:
        _placed.pop().unlink(missing_ok=True)


def _put(path: Path, data: bytes) -> None:
    # Never replace a file this module did not write (the project, a model, a
    # bundled theme), nor write into the package.
    path = path.resolve()
    if path.exists() or _PKG.parent in path.parents:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    _placed.append(path)


def _place_themes(theme_dir: str) -> None:
    """Write the opened theme files where ``theme_dir`` points from the
    project, each font beside its theme as the theme names it, and remove what
    the previous call wrote."""
    _unplace()
    folder = (PROJECT_PATH.parent / theme_dir).resolve()
    fonts = {name.lower(): data for name, data in _opened.items() if name.lower().endswith(_FONT_SUFFIXES)}
    for name, data in _opened_themes().items():
        _put(folder / f"{name}.toml", data)
        for rel in _font_files(data):
            font = fonts.get(PurePosixPath(rel.replace("\\", "/")).name.lower())
            if font is not None:
                _put(folder / rel, font)


def set_theme_files(files) -> str:
    """Keep the theme files opened with the project (``{file name: bytes}``),
    replacing those opened before: ``.toml`` themes, and the font files their
    ``[font]`` tables name. Nothing else is kept. Returns the names of the
    themes they hold, as JSON."""
    global _opened
    _unplace()
    _opened = {name: data for name, data in _file_bytes(files).items()
               if name.lower().endswith((".toml",) + _FONT_SUFFIXES)}
    return json.dumps(sorted(_opened_themes(), key=str.lower))


def theme_catalog() -> str:
    """Theme names and display names for the designer's selectors: the bundled
    themes, default first, then the themes opened with the project, marked as
    the project's. An opened theme takes the place of a bundled one of the
    same name, as a file in theme_dir does for the 3dstep command."""
    opened = _opened_themes()
    themes = []
    for slug in _slugs(_BUNDLED_THEMES):
        if slug not in opened:
            theme = load_theme(slug, _BUNDLED_THEMES / "catalog.toml", ".")
            themes.append({"name": slug, "display": theme.name or slug})
    themes.sort(key=lambda t: (t["name"] != "default", t["display"].lower()))
    mine = []
    for slug, data in opened.items():
        t = _toml(data).get("theme")
        display = str(t.get("name", slug)) if isinstance(t, dict) else slug
        mine.append({"name": slug, "display": f"{display or slug} (project)", "project": True})
    mine.sort(key=lambda t: t["display"].lower())
    return json.dumps(themes + mine)


def theme_tokens(name: str, theme_dir: str = _DEFAULT_THEME_DIR) -> str:
    """A theme's resolved palettes and behaviors, so the designer can style its
    viewport preview like the generated page: ``{name, light, dark, behavior,
    warnings}``. The name resolves as for a project reading ``theme_dir``: a
    theme opened with the project first, then a bundled one. Token names are
    the CSS variables without ``--``; behavior keys are the ``[behavior]``
    keys."""
    _place_themes(theme_dir)
    theme = load_theme(name or "default", PROJECT_PATH, theme_dir)
    return json.dumps({
        "name": theme.name,
        "light": theme.colors_light,
        "dark": theme.colors_dark,
        "behavior": asdict(theme.behavior),
        "warnings": theme.warnings,
    })


# ── Validation and Generate ──────────────────────────────────────────

def _write_project(project_toml: str) -> None:
    # A fresh directory per call, so a model left from an earlier Generate can
    # never stand in for one this project names but the designer did not pass.
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True, exist_ok=True)
    PROJECT_PATH.write_text(project_toml, encoding="utf-8")


def _custom_dir(theme_dir: str) -> bool:
    return bool(theme_dir) and theme_dir != _DEFAULT_THEME_DIR


def _in_theme_dir(name: str, theme_dir: str) -> Path:
    return (PROJECT_PATH.parent / theme_dir).resolve() / f"{name}.toml"


def _theme_file(name: str, theme_dir: str) -> Path | None:
    """The file load_theme reads for a theme: theme_dir's, else the bundled one."""
    for path in (_in_theme_dir(name, theme_dir), _BUNDLED_THEMES / f"{name}.toml"):
        if path.is_file():
            return path
    return None


def _unknown_theme(name: str, theme_dir: str) -> str:
    """Explain a theme the designer cannot find, and how to give it one: the
    3dstep command reads the project's theme_dir on disk, the designer only
    the theme files opened with the project."""
    bundled = ", ".join(_slugs(_BUNDLED_THEMES))
    where = (f"from '{theme_dir}', the project's theme_dir" if _custom_dir(theme_dir)
             else f"only as themes/{name}.toml beside the saved project")
    return (f"Theme '{name}' is not one of the themes bundled with 3DStep ({bundled}), and no "
            f"{name}.toml was opened with the project. The 3dstep command reads it {where}: "
            f"open {name}.toml together with the project to use it here.")


def _theme_not_found(name: str, theme_dir: str, error: OSError) -> str:
    """Explain a FileNotFoundError from load_theme: the theme, or a font file it names."""
    path = _theme_file(name, theme_dir)
    if path is None:
        return _unknown_theme(name, theme_dir)
    missing = [f for f in _font_files(path.read_bytes()) if not (path.parent / f).resolve().is_file()]
    if not missing:
        return str(error)
    return (f"{path.name}: [font]: font file not found: {missing[0]}. The 3dstep command reads it "
            f"beside the theme file: open it together with {path.name} to use the theme here.")


def _theme_problems(project, theme_name: str = "") -> tuple[list[str], list[str]]:
    """Resolve the project's theme as the 3dstep command does: (errors, warnings).

    A theme the designer was not given is only a warning when the command line
    may find it where the designer cannot look (a custom theme_dir, or a font
    beside the theme file); a theme missing from the default theme_dir is most
    likely a typo, so it is an error.
    """
    a = project.assembly
    name = theme_name or a.theme
    try:
        theme = load_theme(name, PROJECT_PATH, a.theme_dir)
    except FileNotFoundError as e:
        note = _theme_not_found(name, a.theme_dir, e)
        found = _theme_file(name, a.theme_dir) is not None
        return ([], [note]) if found or _custom_dir(a.theme_dir) else ([note], [])
    except ValueError as e:
        return str(e).splitlines(), []
    return [], _theme_dir_warnings(name, a.theme_dir) + theme.warnings


def _theme_dir_warnings(name: str, theme_dir: str) -> list[str]:
    """Warn when the project reads its themes from a folder of its own and its
    theme was not opened with it: the designer renders the bundled theme of
    that name, while the 3dstep command uses a file of that name in the folder
    if there is one. Say so rather than hand back output that may quietly
    disagree with it."""
    if not _custom_dir(theme_dir) or _in_theme_dir(name, theme_dir).is_file():
        return []
    return [f"This project reads its themes from '{theme_dir}', and no {name}.toml was opened "
            f"with it: the designer uses the bundled '{name}' theme, the 3dstep command the "
            f"{name}.toml in '{theme_dir}' if there is one."]


def validate(project_toml: str, model_trees_json: str) -> str:
    """Check a project against the models the designer has loaded.

    ``model_trees_json`` maps each model file name to its nodes, nested as
    ``threedstep.glb.tree`` returns them (``[{"id", "label", "children",
    "has_mesh"}]``) or as a flat list of ids. No model bytes cross the bridge.
    Returns ``{"errors": [...], "warnings": [...]}``, one line per problem.
    """
    _write_project(project_toml)
    try:
        project = load_project(PROJECT_PATH)
    except ValueError as e:
        return json.dumps({"errors": str(e).splitlines(), "warnings": []})
    _place_themes(project.assembly.theme_dir)
    trees = json.loads(model_trees_json or "{}")
    missing = [m for m in project.assembly.models if m not in trees]
    errors = [f"The project names {m}, which is not loaded in the designer." for m in missing]
    if not missing:
        try:
            check_ids(project, trees)
        except ValueError as e:
            errors.extend(str(e).splitlines())
    theme_errors, theme_warnings = _theme_problems(project)
    return json.dumps({
        "errors": errors + theme_errors,
        "warnings": project.warnings + theme_warnings,
    })


def generate(project_toml: str, models=None, theme_name: str = "") -> str:
    """Render a project to a finished page.

    Writes the TOML, the models (``{file name: bytes}``) and the theme files
    opened with the project where the loaders expect them and runs the
    command line's own sequence, so the result matches ``3dstep`` byte for
    byte for the same files. Returns JSON holding the page, its size in bytes,
    and every warning, including any about input the browser cannot honor.
    """
    data = _file_bytes(models)
    _write_project(project_toml)
    project = load_project(PROJECT_PATH)
    for name in project.assembly.models:
        if name not in data:
            raise RuntimeError(f"The project names {name}, which is not loaded in the designer.")
        target = WORK / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data[name])
    theme_dir = project.assembly.theme_dir
    _place_themes(theme_dir)
    name = theme_name or project.assembly.theme
    try:
        page = build_page(PROJECT_PATH, theme_name=theme_name)
    except FileNotFoundError as e:
        raise RuntimeError(_theme_not_found(name, theme_dir, e)) from None
    return json.dumps({
        "html": page.html,
        "warnings": _theme_dir_warnings(name, theme_dir) + page.warnings,
        "size": len(page.html.encode("utf-8")),
    })
