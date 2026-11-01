"""Loading and checking project files and themes.

A project TOML says what the page shows (the models, the parts, the steps); a
theme TOML says how the page around it looks. Both load into the dataclasses
below. The project file is written by the designer and edited by hand, so every
mistake must read as a message naming where it is: problems that stop a page
from rendering raise ``ValueError("<file>: <table>: <message>")``, and problems
that do not are collected in ``Project.warnings`` / ``Theme.warnings``, which
the command line prints and the designer shows.
"""
from __future__ import annotations

import base64
import difflib
import math
import re
import sys
from dataclasses import dataclass, field, fields
from pathlib import Path, PurePosixPath, PureWindowsPath

if sys.version_info >= (3, 11):
    import tomllib
else:
    try:
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib  # type: ignore[no-redef]


# ── Project ──────────────────────────────────────────────────────────

@dataclass
class Assembly:
    title: str
    models: list[str]
    description: str = ""
    theme: str = "default"
    theme_dir: str = "./themes"
    style: str = "lineart"
    up: str = "z"
    start: str = "visible"


@dataclass
class CameraSpec:
    """A camera: the home view (``[camera]``) or a step's own (``[step.camera]``).

    The home view always has a position, a target, a fov and a projection. A
    step camera states only what it changes: position and target together, or
    ``fit`` (ids to frame from the inherited direction) instead; ``fov`` and
    ``projection`` are None when the step inherits them.
    """
    position: list[float] | None = None
    target: list[float] | None = None
    fov: float | None = None
    projection: str | None = None
    fit: list[str] | None = None


@dataclass
class PartMeta:
    """A ``[[part]]`` table: display metadata for a node of a model."""
    id: str
    name: str = ""
    color: str = ""


@dataclass
class Move:
    """Where parts sit in one step, relative to their assembled pose."""
    parts: list[str]
    offset: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    rotate: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    arrow: bool = True


@dataclass
class Arrow:
    from_: list[float]          # `from` in the TOML, a keyword in Python
    to: list[float]
    kind: str = "straight"
    turns: float = 0.75
    radius: float = 4.0
    color: str = ""
    label: str = ""
    attach: str = ""


@dataclass
class Label:
    text: str
    at: list[float]
    side: str = "auto"
    attach: str = ""


@dataclass
class Step:
    """One instruction. ``id`` and ``title`` hold their defaults ("step-N",
    "Step N") when the TOML leaves them out."""
    id: str
    title: str
    text: str = ""
    note: str = ""
    show: list[str] = field(default_factory=list)
    hide: list[str] = field(default_factory=list)
    highlight: list[str] = field(default_factory=list)
    ghost: list[str] = field(default_factory=list)
    camera: CameraSpec | None = None
    moves: list[Move] = field(default_factory=list)
    arrows: list[Arrow] = field(default_factory=list)
    labels: list[Label] = field(default_factory=list)


@dataclass
class Project:
    assembly: Assembly
    camera: CameraSpec | None = None
    parts: list[PartMeta] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)
    path: Path = field(default_factory=lambda: Path("project.toml"))
    # Non-fatal complaints: from loading, then from check_ids. The CLI prints
    # these; the designer shows them in the Generate dialog.
    warnings: list[str] = field(default_factory=list)


# ── Project: loading ─────────────────────────────────────────────────

# Every key a table may hold, in the order the docs list them. Anything else is
# an error: a misspelled key would otherwise be dropped, and the page would
# quietly show something other than what the author wrote.
_TOP_KEYS = ("assembly", "camera", "part", "step")
_ASSEMBLY_KEYS = ("title", "description", "models", "theme", "theme_dir", "style", "up", "start")
_CAMERA_KEYS = ("position", "target", "fov", "projection")
_STEP_CAMERA_KEYS = ("position", "target", "fov", "projection", "fit")
_PART_KEYS = ("id", "name", "color")
_STEP_KEYS = ("id", "title", "text", "note", "show", "hide", "highlight", "ghost",
              "camera", "move", "arrow", "label")
_MOVE_KEYS = ("parts", "offset", "rotate", "arrow")
_ARROW_KEYS = ("from", "to", "kind", "turns", "radius", "color", "label", "attach")
_LABEL_KEYS = ("text", "at", "side", "attach")

_STYLES = ("lineart", "shaded")
_UP_AXES = ("z", "y")
_STARTS = ("visible", "hidden")
_PROJECTIONS = ("orthographic", "perspective")
_ARROW_KINDS = ("straight", "rotate")
_LABEL_SIDES = ("auto", "left", "right", "top", "bottom")

# Node names in the GLB files, and so every part reference in the TOML.
_ID_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*")
_HEX_COLOR_RE = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})")
_ID_HINT = "ids are node names like fan_holder: letters, digits, '_', '.' and '-', not starting with '.' or '-'"


def _fail(where: str, message: str):
    raise ValueError(f"{where}: {message}")


def _check_keys(table: dict, allowed: tuple[str, ...], where: str) -> None:
    unknown = sorted(str(k) for k in table if k not in allowed)
    if unknown:
        _fail(where, f"unknown key(s): {', '.join(unknown)} (valid: {', '.join(allowed)})")


def _table(value: object, where: str, written: str) -> dict:
    if not isinstance(value, dict):
        _fail(where, f"must be a table, written as '{written}'")
    return value


def _tables(value: object, where: str, name: str) -> list[dict]:
    """An array of tables such as ``[[step]]``.

    A single ``[step]`` instead of ``[[step]]`` is a classic TOML slip, which
    tomllib parses as one dict rather than a list of them.
    """
    if isinstance(value, dict):
        _fail(where, f"write '[[{name}]]' (an array of tables), not '[{name}]'")
    if not isinstance(value, list) or not all(isinstance(t, dict) for t in value):
        _fail(where, f"'{name.rsplit('.', 1)[-1]}' must be written as [[{name}]] tables")
    return value


def _text(value: object, where: str, key: str) -> str:
    if not isinstance(value, str):
        _fail(where, f"{key} must be a string (got {value!r})")
    # tomllib already turns CRLF inside multi-line strings into LF; a stray
    # "\r" escape would still reach the page, which is LF only.
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _get_text(table: dict, key: str, where: str, default: str = "") -> str:
    return _text(table[key], where, key) if key in table else default


def _enum(table: dict, key: str, where: str, choices: tuple[str, ...], default: str) -> str:
    value = table.get(key, default)
    if not isinstance(value, str) or value not in choices:
        _fail(where, f"{key} must be one of {', '.join(repr(c) for c in choices)} (got {value!r})")
    return value


def _finite(value: int | float) -> bool:
    # TOML integers have no size limit, and one past the float range makes
    # math.isfinite raise OverflowError: it is not a finite number either.
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _number(value: object, where: str, key: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(where, f"{key} must be a number (got {value!r})")
    if not _finite(value):
        _fail(where, f"{key} must be a finite number (got {value!r})")
    return float(value)


def _bool(table: dict, key: str, where: str, default: bool) -> bool:
    value = table.get(key, default)
    if not isinstance(value, bool):
        _fail(where, f"{key} must be true or false (got {value!r})")
    return value


def _vector(value: object, where: str, key: str) -> list[float]:
    if (not isinstance(value, list) or len(value) != 3
            or any(isinstance(c, bool) or not isinstance(c, (int, float)) for c in value)):
        _fail(where, f"{key} must be three numbers like [0.0, 0.0, 10.0] (got {value!r})")
    if not all(_finite(c) for c in value):
        _fail(where, f"{key} must be three finite numbers (got {value!r})")
    return [float(c) for c in value]


def _id(value: object, where: str, key: str) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        _fail(where, f"{key}: {value!r} is not a valid id ({_ID_HINT})")
    return value


def _id_list(table: dict, key: str, where: str) -> list[str]:
    if key not in table:
        return []
    value = table[key]
    if not isinstance(value, list):
        _fail(where, f"{key} must be a list of ids like [\"fan\"] (got {value!r})")
    out: list[str] = []
    for item in value:
        _id(item, where, key)
        if item in out:
            _fail(where, f"{key} lists '{item}' twice")
        out.append(item)
    return out


def _attach(table: dict, where: str) -> str:
    value = table.get("attach", "")
    return "" if value == "" else _id(value, where, "attach")


def _is_absolute(name: str) -> bool:
    return PurePosixPath(name).is_absolute() or PureWindowsPath(name).is_absolute() \
        or bool(PureWindowsPath(name).drive)


def _load_assembly(raw: dict, fname: str) -> Assembly:
    if "assembly" not in raw:
        raise ValueError(f"{fname}: missing required [assembly] table")
    where = f"{fname}: [assembly]"
    a = _table(raw["assembly"], where, "[assembly]")
    _check_keys(a, _ASSEMBLY_KEYS, where)

    if "title" not in a:
        _fail(where, "missing required key 'title'")
    title = _text(a["title"], where, "title")
    if not title.strip():
        _fail(where, "title must not be empty")

    if "models" not in a:
        _fail(where, "missing required key 'models' (the .glb files beside this file, "
                     "like [\"assembly.glb\"])")
    models = a["models"]
    if not isinstance(models, list) or not models:
        _fail(where, f"models must list one or more .glb files, like [\"assembly.glb\"] (got {models!r})")
    for m in models:
        if not isinstance(m, str) or not m.strip():
            _fail(where, f"models: {m!r} is not a file name")
        if not m.lower().endswith(".glb"):
            _fail(where, f"models: '{m}' is not a .glb file (a model is the GLB the designer "
                         "or `3dstep model.step` writes)")
        if _is_absolute(m):
            _fail(where, f"models: '{m}' must be a path relative to this file")
        if models.count(m) > 1:
            _fail(where, f"models lists '{m}' twice")

    return Assembly(
        title=title,
        models=list(models),
        description=_get_text(a, "description", where),
        theme=_get_text(a, "theme", where, "default"),
        theme_dir=_get_text(a, "theme_dir", where, "./themes"),
        style=_enum(a, "style", where, _STYLES, "lineart"),
        up=_enum(a, "up", where, _UP_AXES, "z"),
        start=_enum(a, "start", where, _STARTS, "visible"),
    )


def _load_camera(value: object, where: str, *, step: bool) -> CameraSpec | None:
    """``[camera]`` (``step=False``) or ``[step.camera]``. An empty table means
    no camera: the step inherits, or the home view is fitted to the model."""
    c = _table(value, where, "[step.camera]" if step else "[camera]")
    _check_keys(c, _STEP_CAMERA_KEYS if step else _CAMERA_KEYS, where)
    if not c:
        return None

    cam = CameraSpec()
    if ("position" in c) != ("target" in c):
        _fail(where, "position and target go together: give both, or neither")
    if "position" in c:
        cam.position = _vector(c["position"], where, "position")
        cam.target = _vector(c["target"], where, "target")
        if cam.position == cam.target:
            _fail(where, "position and target are the same point, so the camera has no direction")
    if "fov" in c:
        cam.fov = _number(c["fov"], where, "fov")
        if not 0.0 < cam.fov < 180.0:
            _fail(where, f"fov must be between 0 and 180 degrees (got {c['fov']!r})")
    if "projection" in c:
        cam.projection = _enum(c, "projection", where, _PROJECTIONS, "orthographic")

    if step:
        if "fit" in c:
            if cam.position is not None:
                _fail(where, "fit frames the listed ids instead of a position and target: "
                             "give one or the other")
            cam.fit = _id_list(c, "fit", where)
            if not cam.fit:
                _fail(where, "fit must name at least one id")
    else:
        if cam.position is None:
            _fail(where, "missing required keys 'position' and 'target' (leave out [camera] "
                         "to fit the view to the model)")
        cam.fov = 35.0 if cam.fov is None else cam.fov
        cam.projection = cam.projection or "orthographic"
    return cam


def _load_parts(raw: dict, fname: str) -> list[PartMeta]:
    parts: list[PartMeta] = []
    for i, p in enumerate(_tables(raw.get("part", []), fname, "part")):
        where = f"{fname}: [[part]] #{i + 1}"
        _check_keys(p, _PART_KEYS, where)
        if "id" not in p:
            _fail(where, "missing required key 'id'")
        pid = _id(p["id"], where, "id")
        where = f"{fname}: [[part]] '{pid}'"
        if any(q.id == pid for q in parts):
            _fail(where, f"two [[part]] tables have the id '{pid}'")
        color = _get_text(p, "color", where)
        if color and not _HEX_COLOR_RE.fullmatch(color):
            hint = " (it is missing its '#')" if _HEX_COLOR_RE.fullmatch(f"#{color}") else ""
            _fail(where, f"color must be a hex color like \"#3b82f6\" (got {color!r}){hint}")
        parts.append(PartMeta(id=pid, name=_get_text(p, "name", where), color=color))
    return parts


def _load_moves(step: dict, where: str) -> list[Move]:
    moves: list[Move] = []
    moved: set[str] = set()
    for j, m in enumerate(_tables(step.get("move", []), where, "step.move")):
        w = f"{where}: [[step.move]] #{j + 1}"
        _check_keys(m, _MOVE_KEYS, w)
        if "parts" not in m:
            _fail(w, "missing required key 'parts'")
        parts = _id_list(m, "parts", w)
        if not parts:
            _fail(w, "parts must name at least one id")
        for p in parts:
            if p in moved:
                _fail(w, f"'{p}' is already moved by another [[step.move]] in this step")
            moved.add(p)
        moves.append(Move(
            parts=parts,
            offset=_vector(m["offset"], w, "offset") if "offset" in m else [0.0, 0.0, 0.0],
            rotate=_vector(m["rotate"], w, "rotate") if "rotate" in m else [0.0, 0.0, 0.0],
            arrow=_bool(m, "arrow", w, True),
        ))
    return moves


def _load_arrows(step: dict, where: str, warnings: list[str]) -> list[Arrow]:
    arrows: list[Arrow] = []
    for j, a in enumerate(_tables(step.get("arrow", []), where, "step.arrow")):
        w = f"{where}: [[step.arrow]] #{j + 1}"
        _check_keys(a, _ARROW_KEYS, w)
        for key in ("from", "to"):
            if key not in a:
                _fail(w, f"missing required key '{key}'")
        start, end = _vector(a["from"], w, "from"), _vector(a["to"], w, "to")
        if start == end:
            _fail(w, "from and to are the same point, so the arrow has no direction")
        turns = _number(a["turns"], w, "turns") if "turns" in a else 0.75
        if turns == 0:
            _fail(w, "turns must not be 0 (it is the fraction of a turn a rotate arrow "
                     "sweeps; negative turns counterclockwise)")
        radius = _number(a["radius"], w, "radius") if "radius" in a else 4.0
        if radius <= 0:
            _fail(w, f"radius must be greater than 0 (got {a['radius']!r})")
        color = _get_text(a, "color", w)
        if color:
            color = _check_color("color", color, "", True, warnings, where=f"{w}: color")
        arrows.append(Arrow(
            from_=start, to=end,
            kind=_enum(a, "kind", w, _ARROW_KINDS, "straight"),
            turns=turns, radius=radius, color=color,
            label=_get_text(a, "label", w),
            attach=_attach(a, w),
        ))
    return arrows


def _load_labels(step: dict, where: str) -> list[Label]:
    labels: list[Label] = []
    for j, lab in enumerate(_tables(step.get("label", []), where, "step.label")):
        w = f"{where}: [[step.label]] #{j + 1}"
        _check_keys(lab, _LABEL_KEYS, w)
        for key in ("text", "at"):
            if key not in lab:
                _fail(w, f"missing required key '{key}'")
        text = _text(lab["text"], w, "text")
        if not text.strip():
            _fail(w, "text must not be empty")
        labels.append(Label(
            text=text,
            at=_vector(lab["at"], w, "at"),
            side=_enum(lab, "side", w, _LABEL_SIDES, "auto"),
            attach=_attach(lab, w),
        ))
    return labels


def _load_steps(raw: dict, fname: str, warnings: list[str]) -> list[Step]:
    steps: list[Step] = []
    taken: dict[str, int] = {}
    for i, s in enumerate(_tables(raw.get("step", []), fname, "step")):
        n = i + 1
        where = f"{fname}: [[step]] #{n}"
        _check_keys(s, _STEP_KEYS, where)

        if "id" in s:
            sid = _id(s["id"], where, "id")
            if sid.isdigit():
                # ?step=3 means the third step, so a step called "3" could
                # never be linked to by its id.
                _fail(where, f"id '{sid}' is a number, which ?step= would read as a step "
                             "number; use a slug like 'screws'")
        else:
            sid = f"step-{n}"
        if sid in taken:
            unnamed = "" if "id" in s else f" (step #{n} has no id, so it gets '{sid}')"
            _fail(where, f"duplicate step id '{sid}', also used by step #{taken[sid]}{unnamed}")
        taken[sid] = n
        where = f"{fname}: [[step]] #{n} ({sid})"

        title = _get_text(s, "title", where)
        show, hide = _id_list(s, "show", where), _id_list(s, "hide", where)
        both = [x for x in show if x in hide]
        if both:
            _fail(where, f"'{both[0]}' is in both show and hide")
        steps.append(Step(
            id=sid,
            title=title if title.strip() else f"Step {n}",
            text=_get_text(s, "text", where),
            note=_get_text(s, "note", where),
            show=show,
            hide=hide,
            highlight=_id_list(s, "highlight", where),
            ghost=_id_list(s, "ghost", where),
            camera=_load_camera(s["camera"], f"{where}: [step.camera]", step=True)
            if "camera" in s else None,
            moves=_load_moves(s, where),
            arrows=_load_arrows(s, where, warnings),
            labels=_load_labels(s, where),
        ))
    return steps


def load_project(path: Path) -> Project:
    """Load a project TOML and check everything that can be checked without the
    models. Ids are checked against the models by :func:`check_ids`."""
    path = Path(path)
    fname = path.name
    with open(path, "rb") as f:
        data = f.read()
    try:
        # utf-8-sig: Notepad and some Windows tools start the file with a BOM,
        # which TOML does not allow but which carries no meaning either.
        raw = tomllib.loads(data.decode("utf-8-sig"))
    except UnicodeDecodeError as e:
        raise ValueError(f"{fname} is not UTF-8 text: {e}") from None
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"invalid TOML in {fname}: {e}") from None

    unknown = sorted(k for k in raw if k not in _TOP_KEYS)
    if unknown:
        raise ValueError(
            f"{fname}: unknown top-level key(s) or table(s): {', '.join(unknown)} "
            "(valid: [assembly], [camera], [[part]], [[step]])"
        )
    warnings: list[str] = []
    assembly = _load_assembly(raw, fname)
    camera = _load_camera(raw["camera"], f"{fname}: [camera]", step=False) if "camera" in raw else None
    project = Project(
        assembly=assembly,
        camera=camera,
        parts=_load_parts(raw, fname),
        steps=_load_steps(raw, fname, warnings),
        path=path,
        warnings=warnings,
    )
    if not project.steps:
        warnings.append(f"{fname}: the project has no [[step]] tables, so the page shows "
                        "the model with no instructions")
    return project


def load_models(project: Project) -> dict[str, bytes]:
    """The bytes of every model the project names, read from beside its file."""
    models: dict[str, bytes] = {}
    for name in project.assembly.models:
        path = (project.path.parent / name).resolve()
        try:
            models[name] = path.read_bytes()
        except FileNotFoundError:
            raise ValueError(
                f"model file not found: {path} (named in {project.path.name} [assembly] models)"
            ) from None
        except OSError as e:
            raise ValueError(f"cannot read model file: {path}: {e}") from None
    return models


# ── Project: ids against the models ──────────────────────────────────

class _Nodes:
    """The node ids of a project's models, with the hierarchy when it is known."""

    def __init__(self, trees: dict[str, list], models: list[str]) -> None:
        self.order: list[str] = []                  # document order, models in project order
        self.children: dict[str, list[str]] = {}
        self.has_mesh: dict[str, bool] = {}
        self.owners: dict[str, list[str]] = {}      # id -> the models that have it
        for model in models:
            for node in trees.get(model, []):
                self._add(node, model)

    def _add(self, root: object, model: str) -> None:
        # Depth first with an explicit stack, so no hierarchy is too deep.
        stack = [root]
        while stack:
            node = stack.pop()
            # A flat list of ids carries no hierarchy, so each id counts as a part.
            if isinstance(node, str):
                nid, kids, mesh = node, [], True
            else:
                nid = str(node.get("id", ""))
                kids = list(node.get("children") or [])
                mesh = bool(node.get("has_mesh", not kids))
            self.owners.setdefault(nid, []).append(model)
            if nid not in self.has_mesh:            # a duplicate is reported; the first wins
                self.order.append(nid)
                self.has_mesh[nid] = mesh
                self.children[nid] = [k if isinstance(k, str) else str(k.get("id", "")) for k in kids]
            stack.extend(reversed(kids))

    def parts_under(self, nid: str) -> list[str]:
        """The parts (nodes with a mesh) a reference means: the node itself, or
        every part in a group's subtree."""
        out: list[str] = []
        stack, seen = [nid], set()
        while stack:
            cur = stack.pop()
            if cur in seen or cur not in self.has_mesh:
                continue
            seen.add(cur)
            if self.has_mesh[cur]:
                out.append(cur)
            stack.extend(reversed(self.children.get(cur, [])))
        return out


def _references(project: Project, fname: str):
    """Every id the project's steps name, as (where, id)."""
    for i, step in enumerate(project.steps):
        where = f"{fname}: [[step]] #{i + 1} ({step.id})"
        for key in ("show", "hide", "highlight", "ghost"):
            for nid in getattr(step, key):
                yield f"{where}: {key}", nid
        if step.camera is not None and step.camera.fit:
            for nid in step.camera.fit:
                yield f"{where}: [step.camera] fit", nid
        for j, move in enumerate(step.moves):
            for nid in move.parts:
                yield f"{where}: [[step.move]] #{j + 1} parts", nid
        for j, arrow in enumerate(step.arrows):
            if arrow.attach:
                yield f"{where}: [[step.arrow]] #{j + 1} attach", arrow.attach
        for j, label in enumerate(step.labels):
            if label.attach:
                yield f"{where}: [[step.label]] #{j + 1} attach", label.attach


def check_ids(project: Project, trees: dict[str, list]) -> None:
    """Check every id the project names against the nodes of its models.

    ``trees`` maps each model file name to its nodes: either the nested nodes
    :func:`threedstep.glb.tree` returns (``{"id", "children", "has_mesh", ...}``)
    or a flat list of ids (which carries no hierarchy, so a group id is then
    treated as a part). Raises ValueError with one line per unknown id, each
    listing the nearest existing ids, or one line per part that two
    ``[[step.move]]`` tables of a step reach (through a group). Appends warnings to ``project.warnings``:
    ``[[part]]`` tables for ids no model has, ids two models share, and steps
    that highlight, ghost, move or fit a part that is hidden in that step, or
    attach an arrow or label to one.
    """
    fname = project.path.name
    missing = [m for m in project.assembly.models if m not in trees]
    if missing:
        raise ValueError(f"{fname}: [assembly]: models: '{missing[0]}' has not been read")
    nodes = _Nodes(trees, project.assembly.models)
    known = nodes.has_mesh

    def nearest(nid: str) -> str:
        near = difflib.get_close_matches(nid, nodes.order, n=3, cutoff=0.6)
        if near:
            return f"nearest: {', '.join(near)}"
        return f"no node in {', '.join(project.assembly.models)} has this id"

    errors = [f"{where}: unknown id '{nid}' ({nearest(nid)})"
              for where, nid in _references(project, fname) if nid not in known]
    if errors:
        raise ValueError("\n".join(errors))

    # One part in two [[step.move]] of a step is an error. The loader catches an
    # id written twice; this catches a part reached through a group as well.
    for i, step in enumerate(project.steps):
        mover: dict[str, tuple[int, str]] = {}      # part -> (move number, id that named it)
        for j, move in enumerate(step.moves):
            reached: dict[str, str] = {}            # part -> the id of this move that reaches it
            for nid in move.parts:
                for part in nodes.parts_under(nid):
                    reached.setdefault(part, nid)
            for part, nid in reached.items():
                if part in mover:
                    k, other = mover[part]
                    here = f" (through '{nid}')" if nid != part else ""
                    there = f" (through '{other}')" if other != part else ""
                    errors.append(f"{fname}: [[step]] #{i + 1} ({step.id}): [[step.move]] #{j + 1}: "
                                  f"'{part}'{here} is already moved by [[step.move]] #{k}{there} "
                                  "in this step")
                else:
                    mover[part] = (j + 1, nid)
    if errors:
        raise ValueError("\n".join(errors))

    warnings = project.warnings
    for part in project.parts:
        if part.id not in known:
            warnings.append(f"{fname}: [[part]] '{part.id}': no model has this id, so its "
                            f"name and color are unused ({nearest(part.id)})")
    for nid in nodes.order:
        owners = nodes.owners[nid]
        if len(owners) > 1:
            places = f"twice in {owners[0]}" if owners[0] == owners[1] \
                else f"in both {owners[0]} and {owners[1]}"
            warnings.append(f"{fname}: the id '{nid}' is {places}, so the page cannot "
                            "tell those nodes apart")

    # Fold the visibility of every step, as the viewer does, to find references
    # that will not be seen.
    all_parts = [nid for nid in nodes.order if nodes.has_mesh[nid]]
    visible = set(all_parts) if project.assembly.start == "visible" else set()
    for i, step in enumerate(project.steps):
        for nid in step.hide:
            visible.difference_update(nodes.parts_under(nid))
        for nid in step.show:
            visible.update(nodes.parts_under(nid))
        where = f"{fname}: [[step]] #{i + 1} ({step.id})"
        named = [("highlight", nid) for nid in step.highlight] \
            + [("ghost", nid) for nid in step.ghost] \
            + [("move", nid) for move in step.moves for nid in move.parts] \
            + [(f"[[step.arrow]] #{j + 1} attach", a.attach) for j, a in enumerate(step.arrows) if a.attach] \
            + [(f"[[step.label]] #{j + 1} attach", lb.attach) for j, lb in enumerate(step.labels) if lb.attach]
        for key, nid in named:
            parts = nodes.parts_under(nid)
            if parts and not visible.intersection(parts):
                warnings.append(f"{where}: {key} names '{nid}', which is hidden in this "
                                "step, so it will not be seen")
        # The viewer's fit frames only the parts the step shows.
        for nid in (step.camera.fit or []) if step.camera else []:
            parts = nodes.parts_under(nid)
            if parts and not visible.intersection(parts):
                warnings.append(f"{where}: [step.camera] fit names '{nid}', which is hidden in "
                                "this step, so the camera does not frame it")


# ── Theme ────────────────────────────────────────────────────────────

# Built-in default palette. A theme TOML overrides only the tokens it names;
# unnamed tokens fall back here, so a project with no theme (or a minimal one)
# renders with these. The first group is shared with PinConnect: same names,
# same meanings, same defaults.
_DEFAULT_COLORS_LIGHT: dict[str, str] = {
    "bg": "#ffffff", "text": "#1a1a1a",
    "tip-bg": "#ffffff", "tip-border": "#d0d0d0", "tip-shadow": "rgba(0,0,0,.12)",
    "hint-bg": "rgba(30,30,30,.75)", "hint-text": "#fff",
    "divider": "#e5e5e5", "desc-color": "#555",
    "scroll-thumb": "rgba(0,0,0,.22)", "scroll-track": "transparent",
    "accent": "#2563eb", "view-bg": "#ffffff",
    "part-fill": "#ffffff", "part-edge": "#3a3a3a",
    "highlight-fill": "#b8cff5", "highlight-edge": "#2f5fb3",
    "arrow": "#2563eb", "arrow-edge": "#1e3a8a",
    "label-bg": "rgba(255,255,255,.92)", "label-text": "#1a1a1a", "label-line": "#3a3a3a",
    "ghost-opacity": "0.25",
}
_DEFAULT_COLORS_DARK: dict[str, str] = {
    "bg": "#131313", "text": "#e0e0e0",
    "tip-bg": "#1e1e1e", "tip-border": "#3a3a3a", "tip-shadow": "rgba(0,0,0,.4)",
    "hint-bg": "rgba(240,240,240,.85)", "hint-text": "#131313",
    "divider": "#333", "desc-color": "#aaa",
    "scroll-thumb": "rgba(255,255,255,.20)", "scroll-track": "transparent",
    "accent": "#60a5fa", "view-bg": "#1a1a1a",
    "part-fill": "#2a2a2a", "part-edge": "#d0d0d0",
    "highlight-fill": "#2f4f8f", "highlight-edge": "#9cc0ff",
    "arrow": "#60a5fa", "arrow-edge": "#cfe2ff",
    "label-bg": "rgba(30,30,30,.92)", "label-text": "#e0e0e0", "label-line": "#bbbbbb",
    "ghost-opacity": "0.3",
}

# Tokens that hold a number rather than a color. They are emitted as CSS
# variables like the rest but never color-checked.
_NUMBER_TOKENS = frozenset({"ghost-opacity"})


# ── Theme colors ─────────────────────────────────────────────────────

# The CSS named colors, plus the keywords a color token may legitimately hold.
# Used only to tell a real color from a typo: a value that matches nothing here
# and is not a hex or a function gets a warning, not an error.
_CSS_COLOR_KEYWORDS: frozenset[str] = frozenset("""
aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod
gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod
palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon
sandybrown seagreen seashell sienna silver skyblue slateblue slategray
slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet
wheat white whitesmoke yellow yellowgreen
transparent currentcolor inherit initial unset revert
""".split())

_BARE_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")
_HEX_RE = re.compile(r"^#[0-9a-fA-F]+$")
# rgb(), hsl(), oklch(), color-mix(), var(), linear-gradient() and friends.
_FUNC_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9-]*\(.*\)$", re.DOTALL)
# A numeric string a number token accepts: ASCII digits only, so float()'s
# extras (underscores, non-ASCII digits, "inf", "nan") never reach the CSS.
# _CSS_NUMBER_RE is the subset CSS itself reads, emitted as written; the rest
# ("1.", "2.e-1") is emitted normalized.
_NUMBER_RE = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", re.ASCII)
_CSS_NUMBER_RE = re.compile(r"[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?", re.ASCII)


def _check_color(token: str, value: str, scope: str, known: bool,
                 warnings: list[str], *, where: str = "") -> str:
    """Sanity-check one ``[colors.*]`` value, returning the value to emit.

    Colors reach the stylesheet verbatim, and CSS drops a custom property that
    does not parse only where it is *used* -- so a malformed color does not
    fail, it silently turns the element it paints transparent/unstyled.  Two
    checks, both non-fatal, because unknown tokens are a documented extension
    point and the color syntax keeps growing:

    * A bare hex (``f8f8f8``) is never valid CSS in any position, so it is
      unambiguously a missing ``#``: fix it and say so.
    * Anything else that looks like no color at all is reported only for the
      built-in tokens, whose meaning we know.  A custom token may legitimately
      hold any CSS the theme's ``[extra_css]`` cares to use.

    ``where`` names the value in messages; it defaults to the theme token.
    The project's arrow colors are checked the same way.
    """
    where = where or f"[colors.{scope}] {token}"
    if not isinstance(value, str):
        warnings.append(f"{where} = {value!r} is not a string; ignoring it.")
        return ""
    v = value.strip()
    if not v:
        # The caller drops an empty value, so the default color stays.
        if known:
            warnings.append(f"{where} is empty; using the default color.")
        return ""
    if v.lower() in _CSS_COLOR_KEYWORDS or _FUNC_RE.match(v):
        return v
    if _BARE_HEX_RE.match(v) and len(v) in (3, 4, 6, 8):
        warnings.append(
            f"{where} = \"{v}\" is missing its '#', which makes it invalid CSS "
            f"(the element would render transparent); using \"#{v}\"."
        )
        return f"#{v}"
    if _HEX_RE.match(v):
        if len(v) - 1 in (3, 4, 6, 8):
            return v
        warnings.append(
            f"{where} = \"{v}\" is not a valid hex color "
            "(it needs 3, 4, 6 or 8 digits)."
        )
        return v
    if known:
        warnings.append(
            f"{where} = \"{v}\" is not a recognized CSS color, so the element "
            "it paints will render unstyled."
        )
    return v


def _check_number_token(token: str, value: object, scope: str, warnings: list[str]) -> str:
    """A number token such as ``ghost-opacity``: a number or a numeric string
    from 0 to 1, emitted as written when CSS reads it as written."""
    where = f"[colors.{scope}] {token}"
    try:
        if isinstance(value, bool):
            raise ValueError
        if isinstance(value, str) and not _NUMBER_RE.fullmatch(value.strip()):
            raise ValueError
        number = float(value.strip() if isinstance(value, str) else value)
    except OverflowError:
        # An integer past the float range: as far outside 0 to 1 as infinity.
        number = math.inf if value > 0 else -math.inf
    except (TypeError, ValueError):
        warnings.append(f"{where} = {value!r} is not a number; ignoring it.")
        return ""
    if not 0.0 <= number <= 1.0:
        warnings.append(f"{where} = {value!r} is outside 0 to 1; using {min(1.0, max(0.0, number)):g}.")
        return f"{min(1.0, max(0.0, number)):g}"
    if isinstance(value, str) and _CSS_NUMBER_RE.fullmatch(value.strip()):
        return value.strip()
    return f"{number:g}"


def _theme_colors(raw: object, scope: str, warnings: list[str]) -> dict[str, str]:
    """Check and normalize one ``[colors.light]`` / ``[colors.dark]`` table."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for token, value in raw.items():
        if token in _NUMBER_TOKENS:
            checked = _check_number_token(token, value, scope, warnings)
        else:
            known = token in _DEFAULT_COLORS_LIGHT
            checked = _check_color(str(token), value, scope, known, warnings)
        if checked:
            out[str(token)] = checked
    return out


@dataclass
class ThemeFont:
    """A font a theme uses.  ``source`` is ``google`` (loaded via a Fonts <link>),
    ``bundled`` (a font file embedded as a base64 @font-face, so output stays
    self-contained), or ``system`` (``family`` is used verbatim as a CSS stack).
    ``data_uri``/``fmt`` are filled in by :func:`_parse_font` for bundled fonts."""
    family: str = "Roboto"
    source: str = "google"
    weights: str = "400;500;600"
    data_uri: str = ""
    fmt: str = ""

    def css_family(self, generic: str = "system-ui,sans-serif") -> str:
        """The CSS ``font-family`` value: a system stack verbatim, otherwise the
        quoted family followed by a generic fallback."""
        if self.source == "system":
            return self.family
        return f"'{self.family}',{generic}"


@dataclass
class ThemeBehavior:
    """How the viewer's chrome behaves. The defaults are the built-in look."""
    panel_placement: str = "right"         # "right": beside the view, below it when narrow;
                                           # "below": always below; "overlay": over the view's bottom
    panel_stack_breakpoint: int = 760      # px width at/under which "right" stacks the panel
    panel_max_width: int = 360             # px, also capped at 40vw
    step_list: bool = True                 # list every step in the panel
    show_title: bool = True                # assembly title and description at the top of the panel
    show_parts: bool = True                # list the highlighted parts' names under the step title
    viewport_aspect: float = 1.6           # width / height of the 3D area
    viewport_min_height: int = 320         # px
    viewport_max_height: int = 720         # px
    font_scale: float = 1.0                # scales the panel, HUD and label text
    controls: str = "full"                 # "full", "minimal" (no panel) or "none" (view only)
    edge_width: float = 1.0                # line-art edge width in device pixels
    edge_angle: float = 35.0               # degrees; creases sharper than this get an edge
    arrow_scale: float = 1.0               # multiplies the arrow sizes
    transition_ms: int = 600               # step transition and camera flight; 0 snaps
    play_ms: int = 900                     # duration of Play
    autoplay: bool = False                 # play each step's moves after the transition
    fullscreen_button: bool = True         # fullscreen button in the HUD (a new tab where unavailable)
    style_toggle: bool = False             # HUD button to switch line art / shaded
    projection_toggle: bool = False        # HUD button to switch orthographic / perspective


_BEHAVIOR_CHOICES: dict[str, tuple[str, ...]] = {
    "panel_placement": ("right", "below", "overlay"),
    "controls": ("full", "minimal", "none"),
}
# Inclusive (low, high) clamps; None is unbounded. Values outside are pulled in
# rather than rejected, as PinConnect does: nothing here is worth failing a
# render over, but a negative duration or a zero aspect ratio would break the
# layout.
_BEHAVIOR_CLAMPS: dict[str, tuple[float | None, float | None]] = {
    "panel_stack_breakpoint": (0, None),
    "panel_max_width": (0, None),
    "viewport_aspect": (0.1, 10.0),
    "viewport_min_height": (0, None),
    "viewport_max_height": (0, None),
    "font_scale": (0.1, None),
    "edge_width": (0.0, None),
    "edge_angle": (0.0, 180.0),
    "arrow_scale": (0.0, None),
    "transition_ms": (0, None),
    "play_ms": (0, None),
}


def _coerce_behavior(key: str, value: object, kind: type, where: str):
    """Coerce one ``[behavior]`` value to its field's type, then clamp it."""
    def bad(expected: str):
        _fail(where, f"{key} must be {expected} (got {value!r})")

    if kind is bool:
        if not isinstance(value, bool):
            bad("true or false")
        return value
    if kind is str:
        choices = _BEHAVIOR_CHOICES[key]
        if not isinstance(value, str) or value not in choices:
            bad(f"one of {', '.join(repr(c) for c in choices)}")
        return value
    if isinstance(value, bool):
        bad("a number")
    try:
        number = float(value.strip()) if isinstance(value, str) else float(value)
    except OverflowError:
        bad("a finite number")
    except (TypeError, ValueError):
        bad("a number")
    if not math.isfinite(number):
        bad("a finite number")
    low, high = _BEHAVIOR_CLAMPS.get(key, (None, None))
    if low is not None:
        number = max(low, number)
    if high is not None:
        number = min(high, number)
    return int(round(number)) if kind is int else number


def _load_behavior(raw: object, fname: str, warnings: list[str]) -> ThemeBehavior:
    behavior = ThemeBehavior()
    if not isinstance(raw, dict):
        return behavior
    where = f"{fname}: [behavior]"
    kinds = {f.name: type(f.default) for f in fields(ThemeBehavior)}
    for key, value in raw.items():
        if key not in kinds:
            # A warning rather than an error, so a theme written for another
            # tool (a PinConnect theme, say) still loads.
            warnings.append(f"[behavior] {key} is not a 3DStep behavior; ignoring it.")
            continue
        setattr(behavior, key, _coerce_behavior(key, value, kinds[key], where))
    if behavior.viewport_max_height < behavior.viewport_min_height:
        behavior.viewport_max_height = behavior.viewport_min_height
    return behavior


@dataclass
class Theme:
    """A resolved theme.  Field defaults reproduce 3DStep's built-in look, so
    ``Theme()`` == no theme."""
    name: str = "Default"
    colors_light: dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_COLORS_LIGHT))
    colors_dark: dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_COLORS_DARK))
    font: ThemeFont = field(default_factory=ThemeFont)
    label_font: ThemeFont | None = None
    behavior: ThemeBehavior = field(default_factory=ThemeBehavior)
    extra_css: str = ""
    # Non-fatal complaints from loading, e.g. a color that will not parse as CSS.
    # The CLI prints these; the designer shows them in the Generate dialog.
    warnings: list[str] = field(default_factory=list)


_BUNDLED_THEMES = Path(__file__).parent / "themes"

_THEME_TABLES = ("theme", "font", "behavior", "colors", "extra_css")
_FONT_KEYS = ("family", "source", "weights", "file", "label")

_FONT_MIME = {"woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf"}
_FONT_FORMAT = {"woff2": "woff2", "woff": "woff", "ttf": "truetype", "otf": "opentype"}


def _parse_font(d: dict, base_dir: Path) -> ThemeFont:
    """Build a ThemeFont from a theme's [font] (or [font.label]) table.  For a
    bundled font, read the file (relative to the theme file) and embed it as a
    base64 data URI so the generated HTML stays self-contained."""
    source = d.get("source", "google")
    if source not in ("google", "bundled", "system"):
        raise ValueError(f"font source must be google|bundled|system, got '{source}'")
    for key in ("family", "weights", "file"):
        if key in d and not isinstance(d[key], str):
            hint = ' like "400;700"' if key == "weights" else ""
            raise ValueError(f"{key} must be a string{hint}, got {d[key]!r}")
    font = ThemeFont(
        family=d.get("family", "Roboto"),
        source=source,
        weights=d.get("weights", "400;500;600"),
    )
    # A google or bundled family is written inside single quotes in the CSS.
    if source != "system" and any(c in font.family for c in "'\\\n"):
        raise ValueError(f"font family must not contain a quote, a backslash or a line break, "
                         f"got {font.family!r}")
    if source == "bundled":
        fname = d.get("file", "")
        if not fname:
            raise ValueError(f"bundled font '{font.family}' needs a 'file' path")
        fpath = (base_dir / fname).resolve()
        if not fpath.exists():
            raise FileNotFoundError(f"font file not found: {fpath}")
        ext = fpath.suffix.lower().lstrip(".")
        mime = _FONT_MIME.get(ext, "font/woff2")
        font.fmt = _FONT_FORMAT.get(ext, "woff2")
        b64 = base64.b64encode(fpath.read_bytes()).decode("ascii")
        font.data_uri = f"data:{mime};base64,{b64}"
    return font


def _unknown(table: object, allowed: tuple[str, ...], label: str, warnings: list[str]) -> None:
    if isinstance(table, dict):
        for key in table:
            if key not in allowed:
                warnings.append(f"{label} {key} is not a theme setting; ignoring it.")


def load_theme(name: str, project_path: Path, theme_dir: str = "./themes") -> Theme:
    """Resolve a theme by name.

    Looks in the project-local ``theme_dir`` first, then the themes bundled with
    the package.  Tokens the file omits fall back to the built-in default
    palette, so a minimal theme only needs to state what differs.  The built-in
    ``default`` needs no file; any other unknown name is an error.
    """
    theme = Theme()
    search = [
        (Path(project_path).parent / theme_dir).resolve() / f"{name}.toml",
        _BUNDLED_THEMES / f"{name}.toml",
    ]
    toml_path = next((p for p in search if p.is_file()), None)
    if toml_path is None:
        if name and name != "default":
            raise FileNotFoundError(
                f"Theme '{name}' not found in {search[0].parent} or {_BUNDLED_THEMES}"
            )
        return theme

    try:
        raw = tomllib.loads(toml_path.read_bytes().decode("utf-8-sig"))
    except UnicodeDecodeError as e:
        raise ValueError(f"{toml_path.name} is not UTF-8 text: {e}") from None
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"invalid TOML in {toml_path.name}: {e}") from None

    warnings = theme.warnings
    for key in raw:
        if key not in _THEME_TABLES:
            warnings.append(f"[{key}] is not a theme table; ignoring it.")
    t = raw.get("theme", {})
    _unknown(t, ("name",), "[theme]", warnings)
    theme.name = str(t.get("name", name)) if isinstance(t, dict) else name

    colors = raw.get("colors", {}) if isinstance(raw.get("colors"), dict) else {}
    _unknown(colors, ("light", "dark"), "[colors]", warnings)
    theme.colors_light.update(_theme_colors(colors.get("light"), "light", warnings))
    theme.colors_dark.update(_theme_colors(colors.get("dark"), "dark", warnings))

    fdict = raw.get("font", {})
    if isinstance(fdict, dict) and fdict:
        _unknown(fdict, _FONT_KEYS, "[font]", warnings)
        label = fdict.get("label")
        try:
            theme.font = _parse_font(fdict, toml_path.parent)
            if isinstance(label, dict):
                _unknown(label, _FONT_KEYS[:-1], "[font.label]", warnings)
                theme.label_font = _parse_font(label, toml_path.parent)
        except ValueError as e:
            raise ValueError(f"{toml_path.name}: [font]: {e}") from None

    theme.behavior = _load_behavior(raw.get("behavior", {}), toml_path.name, warnings)

    extra = raw.get("extra_css", {})
    if isinstance(extra, dict):
        theme.extra_css = str(extra.get("css", ""))
    elif isinstance(extra, str):
        theme.extra_css = extra
    theme.extra_css = theme.extra_css.replace("\r\n", "\n").replace("\r", "\n")

    theme.warnings = [f"{toml_path.name}: {w}" for w in warnings]
    return theme
