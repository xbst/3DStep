"""STEP to GLB conversion on a machine: the optional ``3dstep[step]`` extra.

``3dstep model.step`` converts a STEP assembly to a GLB with 3DStep's
conventions, for pipelines that keep only the STEP in their repository. It
needs OCP, OpenCascade's Python bindings, from the ``cadquery-ocp-novtk``
wheels (``pip install "3dstep[step]"``, Python 3.11 or later). This module
imports OCP at the top, so importing it fails without the extra; the command
line imports it lazily and says what to install.

The designer imports STEP files in the browser with occt-import-js 0.0.23,
OpenCascade compiled to WebAssembly. :func:`read_step` walks the file the way
that library does (its ``importer-xcaf.cpp`` and ``importer-utils.cpp``) and
returns a result of the same shape; :func:`build_model` maps it to a model
the way ``buildModel`` in the designer's ``step-import.js`` does. So one file
gives the same tree, ids, labels, colors and primitives in both. The
triangles can differ: occt-import-js is built on OpenCascade 7.6 and these
wheels on 8.0, and the two meshers do not always split a face the same way.
A project TOML works with either GLB, but the bytes are not the same.

``3dstep split assembly.step`` (:func:`split`) cuts an assembly too big for
the designer's reader into several STEP files by top-level component, each
one assembly holding its components where the source has them, so the
designer imports the files as models of one project that line up.
"""
from __future__ import annotations

import difflib
import io
import math
import os
import re
import tempfile
import tomllib
from array import array
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.Interface import Interface_Static
from OCP.Message import Message, Message_Gravity, Message_PrinterOStream
from OCP.OCP.collections import Sequence_TDF_Label
from OCP.Precision import Precision
from OCP.Quantity import Quantity_Color
from OCP.STEPCAFControl import STEPCAFControl_Reader, STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_StepModelType
from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_ChildIterator, TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Shape
from OCP.UnitsMethods import UnitsMethods_LengthUnit
from OCP.XCAFDoc import (XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_DocumentTool, XCAFDoc_Editor,
                         XCAFDoc_ShapeTool)

from . import __version__, config, glb

GENERATOR = f"stepconv {__version__}"

# Tessellation presets, the designer's (SPEC 11.3): the linear deflection is a
# ratio of the mean bounding-box extent of each top-level shape, the angular
# deflection is in radians. "normal" is occt-import-js's default.
QUALITY = {
    "fine": (0.0005, 0.3),
    "normal": (0.001, 0.5),
    "coarse": (0.003, 0.8),
}

_DEFAULT_COLOR = (0.8, 0.8, 0.8, 1.0)
_COLOR_TYPES = (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorCurv,
                XCAFDoc_ColorType.XCAFDoc_ColorGen)
# OCP 8 binds OpenCascade's TopoDS namespace as a module; OCP 7 had a class
# with static methods.
_as_face = getattr(TopoDS, "Face_s", None) or TopoDS.Face


@dataclass
class ConvertResult:
    """What :func:`write` wrote: parts, triangles, and the GLB's size in bytes."""
    parts: int
    triangles: int
    size: int


def tessellation(quality: str | None = None, deflection: float | None = None,
                 angle: float | None = None) -> dict:
    """The keyword arguments of :func:`convert_step` for a quality preset, as
    the designer's import dialog sets them: an explicit ``deflection`` (mm)
    or ``angle`` (degrees) wins over the preset's (``normal`` by default)."""
    linear, angular = QUALITY.get(quality or "normal", QUALITY["normal"])
    options = {"linear_deflection": linear, "angular_deflection": angular,
               "linear_deflection_type": "bounding_box_ratio"}
    if deflection is not None and deflection > 0:
        options.update(linear_deflection=deflection, linear_deflection_type="absolute_value")
    if angle is not None and angle > 0:
        options["angular_deflection"] = angle * math.pi / 180
    return options


def glb_name_for(path: str | Path) -> str:
    """The GLB file name the designer gives an imported file: its stem by the
    id rule (``ToqueCAN 2.step`` is ``toquecan_2.glb``), so a project TOML
    written by the designer finds the GLB the command line writes."""
    stem = re.sub(r"\.[^.]*$", "", Path(path).name)
    return f"{glb.slugify(stem) if stem else 'model'}.glb"


# ── Reading (occt-import-js's traversal) ─────────────────────────────

def _children(label):
    it = TDF_ChildIterator(label)
    while it.More():
        yield it.Value()
        it.Next()


def _label_name(label) -> str:
    """A label's ``TDataStd_Name``, following a reference to the shape it
    refers to: a component is named after its product, not its instance."""
    if XCAFDoc_ShapeTool.IsReference_s(label):
        referred = TDF_Label()
        XCAFDoc_ShapeTool.GetReferredShape_s(label, referred)
        return _label_name(referred)
    attribute = TDataStd_Name()
    if not label.FindAttribute(TDataStd_Name.GetID_s(), attribute):
        return ""
    # UTF-8, as occt-import-js's ToUTF8CString.
    return TCollection_AsciiString(attribute.Get()).ToCString()


def _label_color(label):
    """The label's surface, curve or generic color (in that order), else the
    color of the shape it refers to; linear RGB from 0 to 1, or None."""
    color = Quantity_Color()
    for kind in _COLOR_TYPES:
        if XCAFDoc_ColorTool.GetColor_s(label, kind, color):
            return (color.Red(), color.Green(), color.Blue())
    if XCAFDoc_ShapeTool.IsReference_s(label):
        referred = TDF_Label()
        XCAFDoc_ShapeTool.GetReferredShape_s(label, referred)
        return _label_color(referred)
    return None


def _is_free_shape(label) -> bool:
    return XCAFDoc_ShapeTool.GetShape_s(label, TopoDS_Shape()) and XCAFDoc_ShapeTool.IsFree_s(label)


def _is_mesh_node(label) -> bool:
    """occt-import-js's ``IsMeshNode``: a label without children, with a
    sub-shape child, or without a free-shape child holds bodies; any other
    label is a group of its free-shape children. A component has no children,
    so everything below the first level of components is flattened into the
    component's bodies."""
    if not label.HasChild():
        return True
    if any(XCAFDoc_ShapeTool.IsSubShape_s(child) for child in _children(label)):
        return True
    return not any(_is_free_shape(child) for child in _children(label))


def _body_shapes(shape):
    """A mesh node's bodies, as occt-import-js finds them in its located
    shape: its solids, then its shells outside a solid, then None for the
    faces outside a shell, if any (one body, read from the shape itself)."""
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        yield explorer.Current()
        explorer.Next()
    explorer = TopExp_Explorer(shape, TopAbs_SHELL, TopAbs_SOLID)
    while explorer.More():
        yield explorer.Current()
        explorer.Next()
    if TopExp_Explorer(shape, TopAbs_FACE, TopAbs_SHELL).More():
        yield None


class _Reader:
    """One read: the document's shape tool and the bodies found so far."""

    def __init__(self, shape_tool):
        self.shape_tool = shape_tool
        self.meshes: list[dict] = []

    def search(self, shape):
        label = TDF_Label()
        return label if self.shape_tool.Search(shape, label) else None

    def node(self, label) -> dict:
        node = {"name": _label_name(label), "meshes": [], "children": []}
        if _is_mesh_node(label):
            # The located shape, so every body arrives in world coordinates.
            shape = XCAFDoc_ShapeTool.GetShape_s(label)
            for body in _body_shapes(shape):
                node["meshes"].append(self.body(shape, standalone=True) if body is None else self.body(body))
        else:
            node["children"] = [self.node(child) for child in _children(label)
                                if _is_free_shape(child)]
        return node

    def body(self, shape, standalone: bool = False) -> int:
        """Append one body and return its index. Its name and color are the
        label ``Search`` finds for it (none for the standalone faces)."""
        found = None if standalone else self.search(shape)
        positions, normals, indices = array("f"), array("f"), array("I")
        explorer = (TopExp_Explorer(shape, TopAbs_FACE, TopAbs_SHELL) if standalone
                    else TopExp_Explorer(shape, TopAbs_FACE))
        while explorer.More():
            _add_face(_as_face(explorer.Current()), positions, normals, indices)
            explorer.Next()
        self.meshes.append({
            "name": _label_name(found) if found is not None else "",
            "color": _label_color(found) if found is not None else None,
            "positions": positions,
            "normals": normals,
            "indices": indices,
        })
        return len(self.meshes) - 1


def _add_face(face, positions, normals, indices) -> None:
    """Append a face's triangulation: its own vertices (faces never share
    them), transformed by the face's location; normals computed by OCCT,
    negated for a reversed face, whose triangles also turn the other way."""
    location = TopLoc_Location()
    triangulation = BRep_Tool.Triangulation_s(face, location)
    if triangulation is None or triangulation.NbNodes() == 0 or triangulation.NbTriangles() == 0:
        return
    triangulation.ComputeNormals()
    reversed_ = face.Orientation() == TopAbs_REVERSED
    base = len(positions) // 3
    count = triangulation.NbNodes()
    if location.IsIdentity():
        for i in range(1, count + 1):
            p = triangulation.Node(i)
            positions.extend((p.X(), p.Y(), p.Z()))
            n = triangulation.Normal(i)
            normals.extend((-n.X(), -n.Y(), -n.Z()) if reversed_ else (n.X(), n.Y(), n.Z()))
    else:
        trsf = location.Transformation()
        (m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23) = (
            trsf.Value(r, c) for r in (1, 2, 3) for c in (1, 2, 3, 4))
        for i in range(1, count + 1):
            p = triangulation.Node(i)
            x, y, z = p.X(), p.Y(), p.Z()
            positions.extend((m00 * x + m01 * y + m02 * z + m03,
                              m10 * x + m11 * y + m12 * z + m13,
                              m20 * x + m21 * y + m22 * z + m23))
            n = triangulation.Normal(i)
            n.Transform(trsf)
            normals.extend((-n.X(), -n.Y(), -n.Z()) if reversed_ else (n.X(), n.Y(), n.Z()))
    for t in range(1, triangulation.NbTriangles() + 1):
        a, b, c = triangulation.Triangle(t).Get()
        if reversed_:
            indices.extend((base + a - 1, base + c - 1, base + b - 1))
        else:
            indices.extend((base + a - 1, base + b - 1, base + c - 1))


def _triangulate(shape, linear_deflection: float, angular_deflection: float, ratio: bool) -> bool:
    """Mesh a top-level shape as occt-import-js's ``TriangulateShape`` does.
    With a ratio, the deflection is the mean extent of the shape's bounding
    box times the ratio (1 mm when that is next to nothing), and a shape
    without a bounding box is skipped."""
    deflection = linear_deflection
    if ratio:
        box = Bnd_Box()
        BRepBndLib.Add_s(shape, box, False)
        if box.IsVoid():
            return False
        low, high = box.CornerMin(), box.CornerMax()
        mean = ((high.X() - low.X()) + (high.Y() - low.Y()) + (high.Z() - low.Z())) / 3.0
        deflection = mean * linear_deflection
        if deflection < Precision.Confusion_s():
            deflection = 1.0
    BRepMesh_IncrementalMesh(shape, deflection, False, angular_deflection, False)
    return True


class _Unreadable(Exception):
    """The file is not a STEP file OpenCascade can read; the message says why, if known."""


@contextmanager
def _quiet_messages():
    """Collect OpenCascade's messages instead of letting its default printer
    write them to stdout, where they would mix with the command's output.
    Yields a list that holds the warnings and failures once the block ends."""
    messenger = Message.DefaultMessenger_s()
    printers = messenger.Printers()
    saved = [printers.Value(i) for i in range(1, printers.Length() + 1)]
    handle, log = tempfile.mkstemp(prefix="3dstep-", suffix=".log")
    os.close(handle)
    printer = Message_PrinterOStream(log, False, Message_Gravity.Message_Warning)
    messenger.ChangePrinters().Clear()
    messenger.AddPrinter(printer)
    said: list[str] = []
    try:
        yield said
    finally:
        messenger.ChangePrinters().Clear()
        for p in saved:
            messenger.AddPrinter(p)
        printer.Close()
        del printer
        try:
            text = Path(log).read_text(encoding="utf-8", errors="replace")
            os.unlink(log)
        except OSError:
            text = ""
        for line in text.splitlines():
            line = line.strip(" *\t")
            # Skip the progress lines ("...    Step File Reading : 'stp'") and repeats.
            if line and not line.startswith("...") and (not said or said[-1] != line):
                said.append(line)


@contextmanager
def _reading(path: Path):
    """Collect OpenCascade's messages while the block reads ``path``, and
    raise a ValueError naming the file, with why when that is known, for a
    file it cannot read."""
    with _quiet_messages() as said:
        try:
            yield
            return
        except _Unreadable as e:
            reason = str(e)
        except Exception as e:
            # OpenCascade can also fail while meshing or walking the document.
            # OCP raises its failures as classes of its own modules, each
            # deriving from Exception directly (not from Standard_Failure).
            if type(e).__module__.split(".")[0] != "OCP":
                raise
            reason = str(e) or type(e).__name__
    reason = reason or " ".join(said[-3:])
    raise ValueError(f"{path.name} could not be read as a STEP file" + (f": {reason}" if reason else ""))


def _read_document(data: bytes):
    """A STEP file's bytes as a new XCAF document in millimeters, with the
    file's names, colors and layers."""
    document = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    # Millimeters, whatever unit the file uses.
    XCAFDoc_DocumentTool.SetLengthUnit_s(document, 1.0, UnitsMethods_LengthUnit.UnitsMethods_LengthUnit_Millimeter)
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    try:
        read = reader.ChangeReader().ReadStream("stp", io.BytesIO(data)) == IFSelect_ReturnStatus.IFSelect_RetDone
        transferred = read and reader.Transfer(document)
    except Exception as e:
        # OpenCascade's failures (Standard_Failure) arrive as Python exceptions.
        raise _Unreadable(str(e)) from None
    if not transferred:
        raise _Unreadable("")
    return document


def _read(data: bytes, linear_deflection: float, angular_deflection: float, ratio: bool) -> dict:
    document = _read_document(data)
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    free = [label for label in _children(shape_tool.Label()) if _is_free_shape(label)]
    if not free:
        raise _Unreadable("it holds no shapes")
    # Every top-level shape is meshed before any body is read, as the library
    # does when it lists the root's children.
    tops = [label for label in free if _triangulate(
        XCAFDoc_ShapeTool.GetShape_s(label), linear_deflection, angular_deflection, ratio)]
    reader_ = _Reader(shape_tool)
    root = {"name": "", "meshes": [], "children": [reader_.node(label) for label in tops]}
    return {"root": root, "meshes": reader_.meshes}


def read_step(path: str | Path, *, linear_deflection: float = 0.001, angular_deflection: float = 0.5,
              linear_deflection_type: str = "bounding_box_ratio") -> dict:
    """Read and tessellate a STEP file as occt-import-js's ``ReadStepFile`` does.

    Returns its result's shape: ``{"root": node, "meshes": [body, ...]}``. A
    node is ``{"name", "meshes": [indices into meshes], "children": [nodes]}``
    and the root is unnamed. A body (a solid, a shell outside any solid, or
    the faces outside any shell) is ``{"name", "color", "positions",
    "normals", "indices"}``: positions and normals are ``array('f')`` in model
    space (millimeters, the assembly placement applied), indices an
    ``array('I')``, the color linear RGB from 0 to 1 or None.

    ``linear_deflection_type`` is ``"bounding_box_ratio"`` (the deflection is
    a ratio of each top-level shape's size) or ``"absolute_value"`` (mm).
    Raises ValueError when the file is not a readable STEP file, with what
    OpenCascade said about it.
    """
    path = Path(path)
    data = path.read_bytes()
    with _reading(path):
        return _read(data, linear_deflection, angular_deflection,
                     ratio=linear_deflection_type != "absolute_value")


# ── Building the model (the designer's buildModel) ───────────────────

@dataclass
class _Prim:
    positions: array
    normals: array
    indices: array
    color: tuple


def _clamp_color(color) -> tuple:
    c = color if color is not None and len(color) >= 3 else _DEFAULT_COLOR

    def clamp(v):
        return min(1.0, max(0.0, v)) if math.isfinite(v) else 0.0
    return (clamp(c[0]), clamp(c[1]), clamp(c[2]), clamp(c[3]) if len(c) > 3 else 1.0)


def _color_key(color) -> tuple:
    # Rounded to four decimals with JavaScript's Math.round, as model.js's colorKey.
    return tuple(math.floor(v * 10000 + 0.5) / 10000 for v in _clamp_color(color))


def _compute_normals(positions, indices) -> array:
    """Area-weighted vertex normals, as model.js's computeNormals."""
    n = [0.0] * len(positions)
    for t in range(0, len(indices) - 2, 3):
        a, b, c = indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3
        ux, uy, uz = positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]
        vx, vy, vz = positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        for v in (a, b, c):
            n[v] += nx
            n[v + 1] += ny
            n[v + 2] += nz
    for i in range(0, len(n), 3):
        length = math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2])
        if length > 0:
            n[i], n[i + 1], n[i + 2] = n[i] / length, n[i + 1] / length, n[i + 2] / length
        else:
            n[i], n[i + 1], n[i + 2] = 0.0, 0.0, 1.0
    return array("f", n)


def _body_primitive(mesh: dict) -> _Prim | None:
    """A body as a primitive, or None when it has no triangles."""
    positions, indices = mesh["positions"], mesh["indices"]
    if len(positions) < 9 or len(indices) < 3:
        return None
    normals = mesh.get("normals")
    if normals is None or len(normals) != len(positions):
        normals = _compute_normals(positions, indices)
    color = mesh.get("color")
    if color is not None and len(color) >= 3:
        # Linear RGB from 0 to 1; anything above 1 would be a 0-255 color.
        scale = 1 / 255 if max(color[0], color[1], color[2]) > 1 else 1
        color = _clamp_color((color[0] * scale, color[1] * scale, color[2] * scale, 1.0))
    else:
        color = _DEFAULT_COLOR
    return _Prim(positions, normals, indices, color)


def _diagonal(positions) -> float:
    lo = [min(positions[k::3]) for k in range(3)]
    hi = [max(positions[k::3]) for k in range(3)]
    dx, dy, dz = hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def _merge_primitives(prims: list[_Prim]) -> list[_Prim]:
    """Primitives of one color joined, in the order each color first appears."""
    groups: dict[tuple, list[_Prim]] = {}
    for prim in prims:
        groups.setdefault(_color_key(prim.color), []).append(prim)
    out = []
    for group in groups.values():
        if len(group) == 1:
            out.append(group[0])
            continue
        positions, normals, indices = array("f"), array("f"), array("I")
        for prim in group:
            base = len(positions) // 3
            positions.extend(prim.positions)
            normals.extend(prim.normals)
            indices.extend(i + base for i in prim.indices)
        out.append(_Prim(positions, normals, indices, _clamp_color(group[0].color)))
    return out


def _build(result: dict, *, name: str, merge_bodies, min_size: float,
           id_prefix: str = "") -> tuple[glb.Model, dict]:
    merges = merge_bodies if callable(merge_bodies) else (lambda info: merge_bodies is not False)
    min_size = min_size if min_size and min_size > 0 else 0.0
    meshes = result.get("meshes") or []
    root = result.get("root") or {"name": "", "meshes": [], "children": []}

    geometry: dict[int, bool] = {}

    def has_geometry(node: dict) -> bool:
        key = id(node)
        if key not in geometry:
            own = any(0 <= i < len(meshes) for i in node.get("meshes") or [])
            geometry[key] = own or any(has_geometry(c) for c in node.get("children") or [])
        return geometry[key]

    # {label, parent, bodies: [mesh indices] or None for a group, src}
    entries: list[dict] = []

    def merged(label, src, own) -> bool:
        return len(own) == 1 or bool(merges({
            "label": label, "src": src, "bodies": len(own),
            "names": [meshes[i]["name"] or "" for i in own]}))

    def push_bodies(label, parent, own, src):
        for k, m in enumerate(own):
            entries.append({"label": meshes[m]["name"] or f"{label}_body{k + 1}",
                            "parent": parent, "bodies": [m], "src": f"{src}#{k + 1}"})

    def visit(node, parent, src):
        if not has_geometry(node):
            return
        own = [i for i in node.get("meshes") or [] if 0 <= i < len(meshes)]
        kids = node.get("children") or []
        label = node.get("name") or (meshes[own[0]]["name"] if own else "") or "part"
        if own and not any(has_geometry(k) for k in kids):
            if merged(label, src, own):
                entries.append({"label": label, "parent": parent, "bodies": own, "src": src})
            else:
                entries.append({"label": label, "parent": parent, "bodies": None, "src": src})
                push_bodies(label, len(entries) - 1, own, src)
            return
        entries.append({"label": label, "parent": parent, "bodies": None, "src": src})
        self_index = len(entries) - 1
        if own:
            if merged(label, f"{src}#own", own):
                entries.append({"label": label, "parent": self_index, "bodies": own, "src": f"{src}#own"})
            else:
                push_bodies(label, self_index, own, f"{src}#own")
        for k, child in enumerate(kids):
            visit(child, self_index, f"{src}/{k}")

    for k, child in enumerate(root.get("children") or []):
        visit(child, -1, str(k))
    # occt-import-js never puts bodies on the root itself; any would be one more part.
    if root.get("meshes"):
        visit({"name": "", "meshes": root["meshes"], "children": []}, -1, "root")

    # Ids from every label before any body is dropped, so a part keeps its id
    # whatever the quality and the size filter.
    ids = glb.assign_ids([e["label"] for e in entries], prefix=id_prefix)

    bodies = empty = dropped = 0
    prims: list[list[_Prim] | None] = []
    for entry in entries:
        if entry["bodies"] is None:
            prims.append(None)
            continue
        kept = []
        for i in entry["bodies"]:
            bodies += 1
            prim = _body_primitive(meshes[i])
            if prim is None:
                empty += 1
            elif min_size and _diagonal(prim.positions) < min_size:
                dropped += 1
            else:
                kept.append(prim)
        prims.append(kept)

    # Parts with bodies, and groups with parts left; a child comes after its
    # parent, so one pass from the end settles every group.
    alive = [bool(prims[k]) if e["bodies"] is not None else False for k, e in enumerate(entries)]
    for k in range(len(entries) - 1, -1, -1):
        if alive[k] and entries[k]["parent"] >= 0:
            alive[entries[k]["parent"]] = True

    model = glb.Model(name=name, units="mm", up="z", generator=GENERATOR)
    remap: dict[int, int] = {}
    for k, entry in enumerate(entries):
        if not alive[k]:
            continue
        index = len(model.nodes)
        remap[k] = index
        parent = remap[entry["parent"]] if entry["parent"] >= 0 else -1
        node = glb.Node(id=ids[k], label=entry["label"], parent=parent, src=entry["src"])
        if entry["bodies"] is not None:
            node.mesh = len(model.meshes)
            model.meshes.append(glb.Mesh([
                glb.Primitive(positions=p.positions.tolist(), indices=p.indices.tolist(),
                              normals=p.normals.tolist(), color=p.color)
                for p in _merge_primitives(prims[k])]))
        model.nodes.append(node)
        if parent >= 0:
            model.nodes[parent].children.append(index)
    counts = {"bodies": bodies, "empty_bodies": empty, "dropped_bodies": dropped}
    return model, counts


def build_model(result: dict, *, name: str = "model.glb", merge_bodies=True, min_size: float = 0.0,
                id_prefix: str = "") -> glb.Model:
    """A :func:`read_step` result as a model, by the designer's tree mapping
    (SPEC 13.2). For each node under the unnamed root, in document order:

    - children and no bodies: a group;
    - bodies and no children: a part whose bodies are its primitives, or, when
      its bodies are not merged and it has several, a group of one part per
      body labeled with the body's name, else ``<label>_body<N>``;
    - both: a group with a part ``<label>`` (or its body parts) first, then
      its children;
    - no bodies anywhere below: skipped.

    A node's label is its name, else its first body's name, else ``part``.
    Ids come from every label in document order (:func:`glb.assign_ids`)
    before bodies without triangles or with a bounding-box diagonal under
    ``min_size`` mm are dropped, then parts without bodies, then groups
    without parts. Bodies of one color within a part are one primitive.
    ``merge_bodies`` is True, False, or a function given ``{"label", "src",
    "bodies", "names"}`` for each node with several bodies. An ``id_prefix``
    goes in front of every id (:func:`glb.assign_ids`), as the designer puts
    one on a model whose ids another model of its project already uses.

    The model keeps the file's axes and says Z-up: nothing here knows which
    axis the CAD tool had up, nor a project's, so it is never rotated as the
    designer rotates a model added to a project with the other up axis.
    """
    return _build(result, name=name, merge_bodies=merge_bodies, min_size=min_size, id_prefix=id_prefix)[0]


def convert_step(path: str | Path, *, linear_deflection: float = 0.001, angular_deflection: float = 0.5,
                 linear_deflection_type: str = "bounding_box_ratio", min_size: float = 0.0,
                 merge_bodies=True, name: str = "", id_prefix: str = "") -> glb.Model:
    """A STEP file as a model, as the designer imports it: :func:`read_step`
    then :func:`build_model`. Raises ValueError for a file that cannot be
    read or leaves nothing to show, or for an ``id_prefix`` that would make
    invalid ids (checked before the file is read)."""
    path = Path(path)
    glb.assign_ids([], prefix=id_prefix)   # refuses a bad prefix now, not after the slow read
    result = read_step(path, linear_deflection=linear_deflection, angular_deflection=angular_deflection,
                       linear_deflection_type=linear_deflection_type)
    model, counts = _build(result, name=name or glb_name_for(path), merge_bodies=merge_bodies,
                           min_size=min_size, id_prefix=id_prefix)
    if not model.nodes:
        if counts["bodies"] > counts["empty_bodies"]:
            raise ValueError(f"{path.name} has no bodies of {min_size:g} mm or larger; lower the size filter")
        raise ValueError(f"{path.name} has no solids or surfaces to show")
    return model


def write(path_in: str | Path, path_out: str | Path, **options) -> ConvertResult:
    """Convert ``path_in`` (STEP) to ``path_out`` (GLB) with :func:`convert_step`'s
    keyword options. OSError for a file that cannot be read or written;
    ValueError when ``path_out`` names the STEP file itself, which the write
    would otherwise destroy."""
    path_out = Path(path_out)
    try:
        # samefile, not a path comparison: it also catches a case variant, a
        # short name or a link on Windows.
        same = os.path.samefile(path_in, path_out)
    except OSError:
        same = False
    if same:
        raise ValueError(f"the output would overwrite the STEP file: {path_in}")
    model = convert_step(path_in, name=path_out.name, **options)
    data = glb.write_glb(model, generator=GENERATOR)
    try:
        path_out.write_bytes(data)
    except OSError as e:
        raise OSError(f"cannot write output file: {path_out}: {e.strerror or e}") from None
    return ConvertResult(parts=len(model.meshes), triangles=sum(m.triangles for m in model.meshes),
                         size=len(data))


# ── Splitting (3dstep split) ─────────────────────────────────────────

_SPLIT_KEYS = ("file",)
_SPLIT_FILE_KEYS = ("name", "assembly", "take")


@dataclass
class Component:
    """A product among an assembly's top-level components, as ``3dstep split
    --list`` prints it: its name, its instances, and the bodies they hold."""
    name: str
    instances: int
    bodies: int


@dataclass
class SplitFile:
    """A ``[[file]]`` of a split spec: the STEP file to write, the name of the
    assembly written into it, and the products it takes (``"*"``: every
    product no other file names). ``spec`` and ``index`` place it in messages."""
    name: str
    assembly: str
    take: list[str]
    spec: str = ""
    index: int = 0

    @property
    def where(self) -> str:
        return f"{self.spec}: [[file]] #{self.index}"


@dataclass
class SplitResult:
    """A file :func:`split` wrote: its path, its assembly's name, the
    component instances it holds, and its size in bytes."""
    path: Path
    assembly: str
    components: int
    size: int


def load_split_spec(path: str | Path) -> list[SplitFile]:
    """Load a split spec: a TOML file of ``[[file]]`` tables, each with a
    ``name`` (the STEP file to write), an ``assembly`` (the name of the
    assembly written into it, which the designer's ids come from) and a
    ``take`` list (product names, or ``"*"`` for the rest).

    Checks what can be checked without the assembly and raises
    ``ValueError("<file>: [[file]] #N: <message>")``, as the project loader
    does: unknown keys, missing ones, two files with one name, two assemblies
    whose names give one id, a product taken twice. :func:`split` checks the
    names against the assembly's components.
    """
    path = Path(path)
    fname = path.name
    with open(path, "rb") as f:
        data = f.read()
    try:
        raw = tomllib.loads(data.decode("utf-8-sig"))
    except UnicodeDecodeError as e:
        raise ValueError(f"{fname} is not UTF-8 text: {e}") from None
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"invalid TOML in {fname}: {e}") from None
    unknown = sorted(k for k in raw if k not in _SPLIT_KEYS)
    if unknown:
        raise ValueError(f"{fname}: unknown top-level key(s) or table(s): {', '.join(unknown)} "
                         "(valid: [[file]])")
    tables = config._tables(raw.get("file", []), fname, "file")
    if not tables:
        raise ValueError(f"{fname}: no [[file]] tables: write one for each STEP file to make")

    files: list[SplitFile] = []
    names: dict[str, int] = {}          # file name, lowercased -> its [[file]]
    ids: dict[str, int] = {}            # the id an assembly name gives -> its [[file]]
    taken: dict[str, int] = {}          # product -> the [[file]] that takes it
    for i, table in enumerate(tables):
        n = i + 1
        where = f"{fname}: [[file]] #{n}"
        config._check_keys(table, _SPLIT_FILE_KEYS, where)
        for key in _SPLIT_FILE_KEYS:
            if key not in table:
                config._fail(where, f"missing required key '{key}'")

        name = config._text(table["name"], where, "name")
        if "/" in name or "\\" in name or Path(name).suffix.lower() not in (".step", ".stp"):
            config._fail(where, f"name must be a file name ending in .step or .stp, without a folder "
                                f"(got {name!r}; -o gives the folder)")
        # Lowercased: Windows and macOS would write both names to one file.
        if name.lower() in names:
            config._fail(where, f"name '{name}' is also the name of [[file]] #{names[name.lower()]}")
        names[name.lower()] = n

        assembly = config._text(table["assembly"], where, "assembly")
        if not assembly.strip():
            config._fail(where, "assembly must not be empty: the designer's ids come from it")
        # The designer names a model's root node after its assembly, so two
        # files with one assembly name would give their models one root id,
        # and the designer would prefix every id of the later one.
        root_id = glb.slugify(assembly)
        if root_id in ids:
            config._fail(where, f"assembly '{assembly}' gives the id '{root_id}', as the assembly of "
                                f"[[file]] #{ids[root_id]} does: give each file its own assembly name "
                                "(the designer would prefix every id of the later model)")
        ids[root_id] = n

        take = table["take"]
        if not isinstance(take, list) or not take or not all(isinstance(t, str) for t in take):
            config._fail(where, "take must be a list of component names like [\"Fan\"], or [\"*\"] "
                                f"for every component no other file takes (got {take!r})")
        for product in take:
            if take.count(product) > 1:
                config._fail(where, f"take lists '{product}' twice")
            if product in taken:
                if product == "*":
                    config._fail(where, f"take: '*' is also in [[file]] #{taken[product]}: one file "
                                        "takes the rest")
                config._fail(where, f"take: '{product}' is already taken by [[file]] #{taken[product]}")
        taken.update((product, n) for product in take)
        files.append(SplitFile(name=name, assembly=assembly, take=list(take), spec=fname, index=n))
    return files


def _component_name(label) -> str:
    """What a split calls a top-level component: its product's name, else
    the instance's own."""
    name = _label_name(label)
    if not name and XCAFDoc_ShapeTool.IsReference_s(label):
        attribute = TDataStd_Name()
        if label.FindAttribute(TDataStd_Name.GetID_s(), attribute):
            name = TCollection_AsciiString(attribute.Get()).ToCString()
    return name


def _read_components(path: Path):
    """Read a STEP assembly to split it: (the document, the root assembly's
    name, its top-level components as (name, label) in document order). A
    file of several top-level shapes has no root: its shapes are the
    components and the name is None; a file of one part has none. The
    labels live in the document, so keep it while they are used."""
    data = path.read_bytes()
    with _reading(path):
        document = _read_document(data)
        shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
        free = [label for label in _children(shape_tool.Label()) if _is_free_shape(label)]
        if not free:
            raise _Unreadable("it holds no shapes")
    if len(free) > 1:
        return document, None, [(_component_name(label), label) for label in free]
    labels = Sequence_TDF_Label()
    XCAFDoc_ShapeTool.GetComponents_s(free[0], labels, False)
    components = [labels.Value(i) for i in range(1, labels.Length() + 1)]
    return document, _label_name(free[0]), [(_component_name(label), label) for label in components]


def list_components(path: str | Path) -> tuple[str | None, list[Component]]:
    """The products among a STEP assembly's top-level components, in document
    order, with their instances and bodies: the names a split spec's
    ``take`` lists. Returned with the root assembly's name, which is None for
    a file of several top-level shapes (its shapes are the components); a
    file of one part has no components. Raises ValueError for a file
    OpenCascade cannot read."""
    # The labels live in the document, which stays referenced until this returns.
    document, root, components = _read_components(Path(path))
    products: dict[str, Component] = {}
    for name, label in components:
        product = products.setdefault(name, Component(name=name, instances=0, bodies=0))
        product.instances += 1
        product.bodies += sum(1 for _ in _body_shapes(XCAFDoc_ShapeTool.GetShape_s(label)))
    return root, list(products.values())


def _default_files(products: list[str]) -> list[SplitFile]:
    """One file per product, named by the id rule (``Fan Shroud`` gives
    ``fan_shroud.step``) and holding an assembly named after the product, so
    no two files' ids collide: a product whose id another one has gets the
    same numbered suffix in its file and assembly names."""
    files = []
    for name, file_id in zip(products, glb.assign_ids(products)):
        base = name or "part"
        slug = glb.slugify(base)
        assembly = base if slug == file_id else f"{base} {file_id[len(slug) + 1:]}"
        files.append(SplitFile(name=f"{file_id}.step", assembly=assembly, take=[name]))
    return files


def _plan(files: list[SplitFile], components: list) -> tuple[list, list[str]]:
    """Each file with the labels of the components it takes, in document
    order, and the warnings (products no file takes). Raises ValueError for
    a name ``take`` lists that is not a top-level component, one line each,
    and for a ``"*"`` left with nothing to take."""
    products = list(dict.fromkeys(name for name, _ in components))
    known = set(products)
    errors = []
    for f in files:
        for name in f.take:
            if name != "*" and name not in known:
                near = difflib.get_close_matches(name, products, n=3, cutoff=0.6)
                hint = f"nearest: {', '.join(near)}" if near else "3dstep split --list names them"
                errors.append(f"{f.where}: take: '{name}' is not a top-level component ({hint})")
    if errors:
        raise ValueError("\n".join(errors))

    named = {name for f in files for name in f.take if name != "*"}
    plan = []
    for f in files:
        rest = "*" in f.take
        labels = [label for name, label in components if name in f.take or (rest and name not in named)]
        if not labels:
            raise ValueError(f"{f.where}: take: '*' takes nothing: the other files take every component")
        plan.append((f, labels))
    warnings = []
    left = [name for name in products if name not in named]
    if left and not any("*" in f.take for f in files):
        warnings.append(f"{files[0].spec}: no [[file]] takes {', '.join(repr(n) for n in left)}, so the "
                        "split leaves " + ("it" if len(left) == 1 else "them") + " out (add \"*\" to a "
                        "file's take to keep every component no other file takes)")
    return plan, warnings


def _write_assembly(labels, assembly: str) -> bytes:
    """A STEP file holding the components ``labels`` as the components of one
    new assembly named ``assembly``, each at its place in the source (its
    location under the source's root), with its names, colors and layers."""
    document = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    XCAFDoc_DocumentTool.SetLengthUnit_s(document, 1.0, UnitsMethods_LengthUnit.UnitsMethods_LengthUnit_Millimeter)
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    root = shape_tool.NewShape()
    # isMultiByte: the name arrives as UTF-8.
    TDataStd_Name.Set_s(root, TCollection_ExtendedString(assembly, True))
    sequence = Sequence_TDF_Label()
    for label in labels:
        sequence.Append(label)
    # One assembly for them all, not a file per part: the designer meshes each
    # top-level shape with a deflection relative to its size, so the parts
    # are meshed as in the source, where a small part alone would be meshed
    # far finer.
    if not XCAFDoc_Editor.Extract_s(sequence, root, False):
        raise ValueError(f"the components of '{assembly}' could not be copied")
    shape_tool.UpdateAssemblies()

    saved = Interface_Static.IVal_s("write.surfacecurve.mode")
    # No 2D curves (PCURVEs) on the edges: the reader computes them where a
    # file has none (Fusion's exports have none), and they would double the
    # entities the designer's reader must hold.
    Interface_Static.SetIVal_s("write.surfacecurve.mode", 0)
    try:
        writer = STEPCAFControl_Writer()
        writer.SetColorMode(True)
        writer.SetNameMode(True)
        writer.SetLayerMode(True)
        stream = io.BytesIO()
        written = (writer.Transfer(document, STEPControl_StepModelType.STEPControl_AsIs)
                   and writer.ChangeWriter().WriteStream(stream) == IFSelect_ReturnStatus.IFSelect_RetDone)
    finally:
        Interface_Static.SetIVal_s("write.surfacecurve.mode", saved)
    if not written:
        raise ValueError(f"the assembly '{assembly}' could not be written as STEP")
    return stream.getvalue()


def split(path_in: str | Path, out_dir: str | Path, spec: list[SplitFile] | None = None
          ) -> tuple[list[SplitResult], list[str]]:
    """Split a STEP assembly into several STEP files by top-level component.

    Each ``[[file]]`` of ``spec`` (from :func:`load_split_spec`) gets every
    instance of the products it takes, in document order, as the components
    of one new assembly named by its ``assembly``, each where the source has
    it and with its names and colors; without a spec, each product gets a
    file of its own. The designer then imports the files as models of one
    project that line up, with ids that do not collide. The edges are
    written without their 2D curves, so a file is about its share of the
    source's size.

    Returns the files written, in the spec's order, and warnings (products
    no file takes). Raises ValueError for a file that cannot be read or has
    no components, for names ``take`` lists that are not components, and
    for an output that would overwrite ``path_in``; OSError for a file or
    folder that cannot be written.
    """
    path_in, out_dir = Path(path_in), Path(out_dir)
    # The labels live in the document, which stays referenced until this returns.
    document, _root, components = _read_components(path_in)
    if not components:
        raise ValueError(f"{path_in.name} has no components to split: it holds one part")
    files = spec if spec is not None else _default_files(list(dict.fromkeys(n for n, _ in components)))
    plan, warnings = _plan(files, components)
    for f, _labels in plan:
        try:
            # samefile, as write() does: a case variant or a short name is the same file.
            same = os.path.samefile(path_in, out_dir / f.name)
        except OSError:
            same = False
        if same:
            where = f"{f.where}: " if f.spec else ""
            raise ValueError(f"{where}the output would overwrite the STEP file: {path_in}")
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise OSError(f"cannot create the output folder: {out_dir}: {e.strerror or e}") from None

    results = []
    with _quiet_messages():
        for f, labels in plan:
            try:
                data = _write_assembly(labels, f.assembly)
            except Exception as e:
                if type(e).__module__.split(".")[0] != "OCP":
                    raise
                raise ValueError(f"{f.name} could not be written: {str(e) or type(e).__name__}") from None
            out = out_dir / f.name
            try:
                out.write_bytes(data)
            except OSError as e:
                raise OSError(f"cannot write output file: {out}: {e.strerror or e}") from None
            results.append(SplitResult(path=out, assembly=f.assembly, components=len(labels), size=len(data)))
    return results, warnings
