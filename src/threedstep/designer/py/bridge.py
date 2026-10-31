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
from pathlib import Path

import threedstep
import threedstep.config as _config
from threedstep.config import check_ids, load_project, load_theme
from threedstep.renderer import build_page

_PKG = Path(_config.__file__).resolve().parent
_BUNDLED_THEMES = _PKG / "themes"

# Where the project TOML and its models are written before loading. Nothing
# else lives here, so the project's default relative theme_dir resolves to
# nothing and falls through to the bundled themes, exactly as it does for a
# project file saved somewhere with no sibling themes directory.
WORK = Path("/threedstep/work")
PROJECT_PATH = WORK / "project.toml"

_DEFAULT_THEME_DIR = "./themes"

_CUSTOM_DIR_HINT = (
    "The designer can only use the themes bundled with 3DStep. A project that "
    "points theme_dir at its own files has to be rendered with the 3dstep "
    "command line tool."
)


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


def theme_catalog() -> str:
    """Bundled theme names and display names, default first."""
    themes = []
    for slug in _slugs(_BUNDLED_THEMES):
        theme = load_theme(slug, PROJECT_PATH)
        themes.append({"name": slug, "display": theme.name or slug})
    themes.sort(key=lambda t: (t["name"] != "default", t["display"].lower()))
    return json.dumps(themes)


def theme_tokens(name: str) -> str:
    """A bundled theme's resolved palettes and behaviors, so the designer can
    style its viewport preview like the generated page: ``{name, light, dark,
    behavior, warnings}``. Token names are the CSS variables without ``--``;
    behavior keys are the ``[behavior]`` keys."""
    theme = load_theme(name or "default", PROJECT_PATH)
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


def _local_dir_warnings(theme_dir: str) -> list[str]:
    """Warn when the project points at theme files the browser cannot read.

    A project-local theme silently loses to the bundled theme of the same name
    here, because nothing was copied into the virtual filesystem beside the
    project. The CLI, which can read the directory, would produce a different
    file. Say so rather than hand back output that quietly disagrees with it.
    """
    if theme_dir and theme_dir != _DEFAULT_THEME_DIR:
        return [
            f"This project reads themes from '{theme_dir}', which the designer "
            "cannot open. A theme defined there was replaced by the bundled theme "
            "of the same name, or by the default."
        ]
    return []


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
    trees = json.loads(model_trees_json or "{}")
    missing = [m for m in project.assembly.models if m not in trees]
    errors = [f"The project names {m}, which is not loaded in the designer." for m in missing]
    if not missing:
        try:
            check_ids(project, trees)
        except ValueError as e:
            errors.extend(str(e).splitlines())
    return json.dumps({
        "errors": errors,
        "warnings": project.warnings + _local_dir_warnings(project.assembly.theme_dir),
    })


def _model_bytes(models) -> dict[str, bytes]:
    """The models argument as plain bytes: a dict of bytes-likes from Python,
    or a JS object of Uint8Arrays from the designer."""
    if hasattr(models, "to_py"):
        models = models.to_py()
    return {str(name): bytes(data) for name, data in (models or {}).items()}


def generate(project_toml: str, models=None, theme_name: str = "") -> str:
    """Render a project to a finished page.

    Writes the TOML and the models (``{file name: bytes}``) where the loaders
    expect them and runs the command line's own sequence, so the result matches
    ``3dstep`` byte for byte for the same files. Returns JSON holding the page,
    its size in bytes, and every warning, including any about input the browser
    cannot honor.
    """
    data = _model_bytes(models)
    _write_project(project_toml)
    project = load_project(PROJECT_PATH)
    for name in project.assembly.models:
        if name not in data:
            raise RuntimeError(f"The project names {name}, which is not loaded in the designer.")
        target = WORK / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data[name])
    try:
        page = build_page(PROJECT_PATH, theme_name=theme_name)
    except FileNotFoundError as e:
        raise RuntimeError(f"{e}\n\n{_CUSTOM_DIR_HINT}") from None
    return json.dumps({
        "html": page.html,
        "warnings": _local_dir_warnings(project.assembly.theme_dir) + page.warnings,
        "size": len(page.html.encode("utf-8")),
    })
