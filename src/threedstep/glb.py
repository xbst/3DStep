"""Reading and writing GLB models (glTF 2.0 binary), one per imported model.

The reader inspects a model's JSON chunk: the node ids and their tree, the
triangle count, the bounding box and the 3DStep metadata, so a project's ids
can be checked and its size reported. It never decodes the meshes: the viewer
does that, with Three.js.

The writer turns a :class:`Model` (the same shape the designer's importer
builds) into a GLB with 3DStep's conventions: one node per part, named by its
id; positions in model space (millimeters, the CAD file's axes) quantized with
``KHR_mesh_quantization``; one material per color. The designer has its own
writer in JavaScript (``designer/js/import/glb-writer.js``) that follows the
same conventions; the two need not produce the same bytes, only the same ids
and tree.

Everything is packed with explicit little-endian ``struct`` formats and nothing
is compressed, so a model written twice is the same bytes on every platform.
"""
from __future__ import annotations

import json
import math
import re
import struct
import unicodedata
from dataclasses import dataclass, field

from . import __version__

_MAGIC = 0x46546C67           # "glTF"
_CHUNK_JSON = 0x4E4F534A      # "JSON"
_CHUNK_BIN = 0x004E4942       # "BIN\0"

_ARRAY_BUFFER = 34962
_ELEMENT_ARRAY_BUFFER = 34963

_BYTE, _UNSIGNED_BYTE, _SHORT, _UNSIGNED_SHORT, _UNSIGNED_INT, _FLOAT = \
    5120, 5121, 5122, 5123, 5125, 5126
# componentType -> (byte size, divisor that maps a normalized integer to -1..1)
_COMPONENTS: dict[int, tuple[int, float]] = {
    _BYTE: (1, 127.0), _UNSIGNED_BYTE: (1, 255.0),
    _SHORT: (2, 32767.0), _UNSIGNED_SHORT: (2, 65535.0),
    _UNSIGNED_INT: (4, 4294967295.0), _FLOAT: (4, 1.0),
}
_TYPE_SIZES = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}

# The only extension 3DStep's GLBs need, and the only one the viewer handles
# beyond what Three.js's GLTFLoader reads without a decoder.
_QUANTIZATION = "KHR_mesh_quantization"

# What a node name must look like for a project to refer to it (config.py
# checks the references with the same pattern).
_ID_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*")


# ── Reading ──────────────────────────────────────────────────────────

@dataclass
class GlbDoc:
    """A parsed GLB: its JSON chunk, and its binary chunk (empty if none)."""
    json: dict
    bin: bytes


def read_glb(data: bytes) -> GlbDoc:
    """Parse a GLB, strict about the container and the references in it.

    Raises ValueError for anything Three.js would fail to load: a bad magic,
    version or length, a missing or unparsable JSON chunk, and indices or
    byte ranges that point past what the file holds. Conventions that only
    3DStep cares about are :func:`validate`'s business, as warnings.
    """
    data = bytes(data)
    if len(data) < 12:
        raise ValueError("not a GLB file (it is too short)")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != _MAGIC:
        raise ValueError("not a GLB file (it does not start with 'glTF')")
    if version != 2:
        raise ValueError(f"GLB version {version} is not supported (3DStep reads glTF 2.0)")
    if length != len(data):
        raise ValueError(f"the GLB header says {length} bytes, but the file has {len(data)}")

    doc_json: dict | None = None
    bin_chunk: bytes | None = None
    offset = 12
    while offset < length:
        if offset + 8 > length:
            raise ValueError("a GLB chunk header runs past the end of the file")
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        start, end = offset + 8, offset + 8 + chunk_length
        if end > length:
            raise ValueError("a GLB chunk runs past the end of the file")
        if doc_json is None:
            if chunk_type != _CHUNK_JSON:
                raise ValueError("the first GLB chunk is not JSON")
            try:
                # Padding is spaces by the spec; some writers use zeros.
                parsed = json.loads(data[start:end].rstrip(b" \x00").decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as e:
                raise ValueError(f"the GLB's JSON chunk does not parse: {e}") from None
            if not isinstance(parsed, dict):
                raise ValueError("the GLB's JSON chunk is not an object")
            doc_json = parsed
        elif chunk_type == _CHUNK_BIN:
            if bin_chunk is not None:
                raise ValueError("the GLB has more than one BIN chunk")
            bin_chunk = data[start:end]
        # Chunks of other types may be ignored, by the spec.
        offset = end
    if doc_json is None:
        raise ValueError("the GLB has no JSON chunk")
    doc = GlbDoc(json=doc_json, bin=bin_chunk or b"")
    _check_structure(doc)
    return doc


def _list(doc: GlbDoc, key: str) -> list:
    value = doc.json.get(key, [])
    if not isinstance(value, list):
        raise ValueError(f"the GLB's '{key}' is not an array")
    return value


def _index(value: object, size: int, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < size:
        raise ValueError(f"{what} {value!r} does not exist")
    return value


def _check_structure(doc: GlbDoc) -> None:
    """Raise ValueError for references a loader would trip over."""
    asset = doc.json.get("asset")
    if not isinstance(asset, dict) or not str(asset.get("version", "")).startswith("2."):
        raise ValueError("the GLB's asset.version is not 2.0")
    nodes, meshes = _list(doc, "nodes"), _list(doc, "meshes")
    accessors, views, buffers = _list(doc, "accessors"), _list(doc, "bufferViews"), _list(doc, "buffers")

    buffer_sizes = []
    for i, buf in enumerate(buffers):
        size = buf.get("byteLength") if isinstance(buf, dict) else None
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError(f"buffer {i} has no valid byteLength")
        if "uri" not in buf:
            if i != 0:
                raise ValueError(f"buffer {i} has no uri, and only buffer 0 can be the BIN chunk")
            if size > len(doc.bin):
                raise ValueError(f"buffer 0 is {size} bytes, but the BIN chunk has {len(doc.bin)}")
        buffer_sizes.append(size)

    for i, view in enumerate(views):
        if not isinstance(view, dict):
            raise ValueError(f"bufferView {i} is not an object")
        b = _index(view.get("buffer"), len(buffers), f"bufferView {i} names buffer")
        start, size = view.get("byteOffset", 0), view.get("byteLength")
        if not isinstance(start, int) or not isinstance(size, int) or start < 0 or size < 1 \
                or start + size > buffer_sizes[b]:
            raise ValueError(f"bufferView {i} runs past the end of buffer {b}")

    for i, acc in enumerate(accessors):
        if not isinstance(acc, dict):
            raise ValueError(f"accessor {i} is not an object")
        component = acc.get("componentType")
        if component not in _COMPONENTS or acc.get("type") not in _TYPE_SIZES:
            raise ValueError(f"accessor {i} has an unknown componentType or type")
        count = acc.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            raise ValueError(f"accessor {i} has no valid count")
        if "bufferView" in acc:
            view = views[_index(acc["bufferView"], len(views), f"accessor {i} names bufferView")]
            element = _COMPONENTS[component][0] * _TYPE_SIZES[acc["type"]]
            stride = view.get("byteStride") or element
            offset = acc.get("byteOffset", 0)
            if not isinstance(offset, int) or offset < 0 \
                    or offset + stride * (count - 1) + element > view["byteLength"]:
                raise ValueError(f"accessor {i} runs past the end of its bufferView")

    for i, mesh in enumerate(meshes):
        prims = mesh.get("primitives") if isinstance(mesh, dict) else None
        if not isinstance(prims, list) or not prims:
            raise ValueError(f"mesh {i} has no primitives")
        for prim in prims:
            attrs = prim.get("attributes") if isinstance(prim, dict) else None
            if not isinstance(attrs, dict):
                raise ValueError(f"a primitive of mesh {i} has no attributes")
            for name, acc in attrs.items():
                _index(acc, len(accessors), f"mesh {i} attribute {name} names accessor")
            if "indices" in prim:
                _index(prim["indices"], len(accessors), f"mesh {i} indices name accessor")

    parent: dict[int, int] = {}
    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise ValueError(f"node {i} is not an object")
        if "mesh" in node:
            _index(node["mesh"], len(meshes), f"node {i} names mesh")
        children = node.get("children", [])
        if not isinstance(children, list):
            raise ValueError(f"node {i} has children that are not an array")
        for c in children:
            _index(c, len(nodes), f"node {i} names child node")
            if c in parent or c == i:
                raise ValueError(f"node {c} has more than one parent")
            parent[c] = i
    for r in _roots(doc):
        _index(r, len(nodes), "the scene names node")
        if r in parent:
            raise ValueError(f"node {r} is a scene root and also a child")


def _roots(doc: GlbDoc) -> list[int]:
    """The root nodes of the scene a viewer shows (``scene``, else the first)."""
    scenes = doc.json.get("scenes")
    if isinstance(scenes, list) and scenes:
        index = doc.json.get("scene", 0)
        scene = scenes[index] if isinstance(index, int) and 0 <= index < len(scenes) else scenes[0]
        roots = scene.get("nodes", []) if isinstance(scene, dict) else []
        return list(roots) if isinstance(roots, list) else []
    # No scenes: every node that is nobody's child.
    nodes = doc.json.get("nodes", [])
    children = {c for n in nodes for c in n.get("children", [])}
    return [i for i in range(len(nodes)) if i not in children]


def _walk(doc: GlbDoc):
    """Node indices in document order: depth first from the scene's roots."""
    nodes = doc.json.get("nodes", [])
    stack = list(reversed(_roots(doc)))
    while stack:
        i = stack.pop()
        yield i
        stack.extend(reversed(nodes[i].get("children", [])))


def _name(node: dict) -> str:
    name = node.get("name")
    return name if isinstance(name, str) else ""


def node_ids(doc: GlbDoc) -> list[str]:
    """Every node's id (its name), in document order. Unnamed nodes have none."""
    nodes = doc.json.get("nodes", [])
    return [_name(nodes[i]) for i in _walk(doc) if _name(nodes[i])]


def tree(doc: GlbDoc) -> list[dict]:
    """The node hierarchy as nested dicts: ``{"id", "label", "children",
    "has_mesh"}`` per node, roots in scene order. ``label`` is the CAD name the
    importer read (``extras.label``), else the id."""
    nodes = doc.json.get("nodes", [])

    def build(i: int) -> dict:
        node = nodes[i]
        extras = node.get("extras") if isinstance(node.get("extras"), dict) else {}
        label = extras.get("label")
        return {
            "id": _name(node),
            "label": label if isinstance(label, str) and label else _name(node),
            "children": [build(c) for c in node.get("children", [])],
            "has_mesh": "mesh" in node,
        }

    return [build(r) for r in _roots(doc)]


def triangle_count(doc: GlbDoc) -> int:
    """Triangles drawn by the scene, counting a mesh once per node using it."""
    nodes, meshes = doc.json.get("nodes", []), doc.json.get("meshes", [])
    accessors = doc.json.get("accessors", [])
    total = 0
    for i in _walk(doc):
        if "mesh" not in nodes[i]:
            continue
        for prim in meshes[nodes[i]["mesh"]]["primitives"]:
            source = prim.get("indices", prim["attributes"].get("POSITION"))
            if source is None:
                continue
            count = accessors[source]["count"]
            mode = prim.get("mode", 4)
            if mode == 4:                       # TRIANGLES
                total += count // 3
            elif mode in (5, 6):                # TRIANGLE_STRIP, TRIANGLE_FAN
                total += max(0, count - 2)
    return total


def _local_matrix(node: dict) -> list[float]:
    """A node's local transform as a column-major 4x4 matrix."""
    m = node.get("matrix")
    if isinstance(m, list) and len(m) == 16:
        return [float(v) for v in m]
    tx, ty, tz = node.get("translation", [0.0, 0.0, 0.0])
    qx, qy, qz, qw = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    sx, sy, sz = node.get("scale", [1.0, 1.0, 1.0])
    # Rotation matrix of a unit quaternion, scaled per axis, translated.
    return [
        (1 - 2 * (qy * qy + qz * qz)) * sx, (2 * (qx * qy + qz * qw)) * sx, (2 * (qx * qz - qy * qw)) * sx, 0.0,
        (2 * (qx * qy - qz * qw)) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, (2 * (qy * qz + qx * qw)) * sy, 0.0,
        (2 * (qx * qz + qy * qw)) * sz, (2 * (qy * qz - qx * qw)) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0.0,
        float(tx), float(ty), float(tz), 1.0,
    ]


def _multiply(a: list[float], b: list[float]) -> list[float]:
    """a × b for column-major 4x4 matrices."""
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def _bound(acc: dict, key: str) -> list[float] | None:
    values = acc.get(key)
    if not isinstance(values, list) or len(values) < 3:
        return None
    size, divisor = _COMPONENTS[acc["componentType"]]
    if acc.get("normalized") and acc["componentType"] != _FLOAT:
        # Quantized units, per KHR_mesh_quantization; signed types floor at -1.
        return [max(-1.0, v / divisor) for v in values[:3]]
    return [float(v) for v in values[:3]]


def bbox(doc: GlbDoc) -> dict | None:
    """The scene's bounding box in model units, ``{"min": [x, y, z], "max": [...]}``.

    Built from each POSITION accessor's min/max and the node transforms, so it
    is exact for the boxes glTF stores and never reads the vertices. None when
    the model draws nothing.
    """
    nodes, meshes = doc.json.get("nodes", []), doc.json.get("meshes", [])
    accessors = doc.json.get("accessors", [])
    identity = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
    world: dict[int, list[float]] = {}
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for root in _roots(doc):
        stack = [(root, identity)]
        while stack:
            i, parent_matrix = stack.pop()
            world[i] = _multiply(parent_matrix, _local_matrix(nodes[i]))
            stack.extend((c, world[i]) for c in nodes[i].get("children", []))
            if "mesh" not in nodes[i]:
                continue
            m = world[i]
            for prim in meshes[nodes[i]["mesh"]]["primitives"]:
                acc_index = prim["attributes"].get("POSITION")
                if acc_index is None:
                    continue
                low, high = _bound(accessors[acc_index], "min"), _bound(accessors[acc_index], "max")
                if low is None or high is None:
                    continue
                for corner in ((x, y, z) for x in (low[0], high[0])
                               for y in (low[1], high[1]) for z in (low[2], high[2])):
                    for r in range(3):
                        v = m[r] * corner[0] + m[4 + r] * corner[1] + m[8 + r] * corner[2] + m[12 + r]
                        lo[r], hi[r] = min(lo[r], v), max(hi[r], v)
    if lo[0] == math.inf:
        return None
    return {"min": lo, "max": hi}


def metadata(doc: GlbDoc) -> dict | None:
    """The ``threedstep`` metadata in ``asset.extras``, or None for a foreign GLB."""
    extras = doc.json.get("asset", {}).get("extras")
    meta = extras.get("threedstep") if isinstance(extras, dict) else None
    return meta if isinstance(meta, dict) else None


def validate(doc: GlbDoc) -> list[str]:
    """Warnings about 3DStep's conventions. Nothing here stops a page rendering,
    but each one is something the author should know about."""
    warnings: list[str] = []
    meta = metadata(doc)
    if meta is None:
        warnings.append("model has no 3DStep metadata; assuming millimeters, Z-up")
    else:
        if meta.get("units", "mm") != "mm":
            warnings.append(f"model units are {meta.get('units')!r}, but 3DStep works in "
                            "millimeters; import the model through the designer to convert it")
        if meta.get("up", "z") not in ("z", "y"):
            warnings.append(f"model up axis {meta.get('up')!r} is neither 'z' nor 'y'")
        version = meta.get("version", 1)
        if isinstance(version, int) and version > 1:
            warnings.append(f"model was written by a newer 3DStep (metadata version {version})")

    for ext in doc.json.get("extensionsRequired", []) or []:
        if ext != _QUANTIZATION:
            warnings.append(f"model requires the glTF extension {ext}, which the viewer "
                            "cannot load; the page will not show this model")

    nodes = doc.json.get("nodes", [])
    seen: set[str] = set()
    for i in _walk(doc):
        node, name = nodes[i], _name(nodes[i])
        if not name:
            warnings.append(f"node #{i} has no name, so no step can refer to it")
            continue
        if name in seen:
            warnings.append(f"two nodes are named '{name}'; ids must be unique")
        elif not _ID_RE.fullmatch(name):
            warnings.append(f"node name '{name}' is not a valid id, so no step can refer to it")
        seen.add(name)
        if "mesh" in node and node.get("children"):
            warnings.append(f"node '{name}' has both a mesh and children; 3DStep expects a "
                            "part (a mesh) or a group (children)")
    return warnings


# ── Writing ──────────────────────────────────────────────────────────

_DEFAULT_COLOR = (0.8, 0.8, 0.8, 1.0)


@dataclass
class Primitive:
    """One body or color run of a part. ``positions`` and ``normals`` are flat
    ``x, y, z, x, y, z, ...`` lists in model space (the assembly's world
    coordinates, millimeters); ``indices`` has three entries per triangle;
    ``color`` is RGBA from 0 to 1."""
    positions: list[float]
    indices: list[int]
    normals: list[float] | None = None
    color: tuple[float, float, float, float] = _DEFAULT_COLOR


@dataclass
class Mesh:
    """A part's geometry: one primitive per body or color."""
    primitives: list[Primitive] = field(default_factory=list)

    @property
    def bbox(self) -> dict | None:
        """``{"min": [x, y, z], "max": [x, y, z]}`` over every primitive."""
        lo, hi = [math.inf] * 3, [-math.inf] * 3
        for prim in self.primitives:
            for k in range(3):
                axis = prim.positions[k::3]
                if axis:
                    lo[k], hi[k] = min(lo[k], min(axis)), max(hi[k], max(axis))
        return None if lo[0] == math.inf else {"min": lo, "max": hi}

    @property
    def triangles(self) -> int:
        return sum(len(p.indices) // 3 for p in self.primitives)


@dataclass
class Node:
    """A part (``mesh`` is an index into ``Model.meshes``) or a group
    (``children`` are indices into ``Model.nodes``), never both. ``parent`` is
    -1 for a root. ``label`` is the CAD name the id was made from; ``src`` is
    free-form debugging information from the import."""
    id: str
    label: str = ""
    parent: int = -1
    children: list[int] = field(default_factory=list)
    mesh: int = -1
    src: str = ""


@dataclass
class Model:
    """An imported model, as the designer holds it (SPEC 13.1): nodes in
    document order, meshes referenced by index."""
    name: str = ""
    units: str = "mm"
    up: str = "z"
    generator: str = ""
    nodes: list[Node] = field(default_factory=list)
    meshes: list[Mesh] = field(default_factory=list)


def slugify(label: object) -> str:
    """The id rule: a CAD name to a slug.

    NFKD-normalize and drop what is not ASCII, lowercase, collapse every run
    of characters outside ``[a-z0-9]`` into one ``_``, strip ``_`` from both
    ends; an empty result is ``part``. ``designer/js/import/ids.js`` implements
    the same rule, so the designer and ``3dstep model.step`` agree on ids.
    """
    text = label if isinstance(label, str) else ""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_") or "part"


def assign_ids(labels) -> list[str]:
    """Unique ids for labels in document order.

    The first label with a given slug keeps it; later ones get ``slug_N`` with
    the smallest ``N >= 2`` not already taken, whether by a suffixed id or by
    another label's bare slug (``m3x12``, ``m3x12_2``, ``m3x12_3``).
    """
    taken: set[str] = set()
    next_suffix: dict[str, int] = {}
    ids: list[str] = []
    for label in labels:
        slug = candidate = slugify(label)
        if candidate in taken:
            # Every suffix below next_suffix[slug] is taken already, so the
            # search can resume there instead of at 2.
            n = next_suffix.get(slug, 2)
            while f"{slug}_{n}" in taken:
                n += 1
            candidate = f"{slug}_{n}"
            next_suffix[slug] = n + 1
        taken.add(candidate)
        ids.append(candidate)
    return ids


def _check_model(model: Model) -> None:
    """Raise ValueError for a model that cannot be written as a valid GLB."""
    seen: set[str] = set()
    n_nodes, n_meshes = len(model.nodes), len(model.meshes)
    for i, node in enumerate(model.nodes):
        if not isinstance(node.id, str) or not _ID_RE.fullmatch(node.id):
            raise ValueError(f"node {i}: {node.id!r} is not a valid id")
        if node.id in seen:
            raise ValueError(f"node {i}: the id '{node.id}' is used twice")
        seen.add(node.id)
        if node.mesh != -1 and not 0 <= node.mesh < n_meshes:
            raise ValueError(f"node '{node.id}': mesh {node.mesh} does not exist")
        if node.mesh != -1 and node.children:
            # The part's node carries the dequantization transform, which
            # would move its children too.
            raise ValueError(f"node '{node.id}' has both a mesh and children; make the "
                             "mesh a child part of its own")
        if node.parent != -1 and not (0 <= node.parent < n_nodes
                                      and i in model.nodes[node.parent].children):
            raise ValueError(f"node '{node.id}': its parent does not list it as a child")
        for c in node.children:
            if not 0 <= c < n_nodes or model.nodes[c].parent != i:
                raise ValueError(f"node '{node.id}': child {c} does not name it as its parent")
    for m, mesh in enumerate(model.meshes):
        if not mesh.primitives:
            raise ValueError(f"mesh {m} has no primitives (drop empty bodies before writing)")
        for prim in mesh.primitives:
            n_values = len(prim.positions)
            if n_values == 0 or n_values % 3:
                raise ValueError(f"mesh {m}: positions must hold x, y, z for one or more vertices")
            if not all(math.isfinite(v) for v in prim.positions):
                raise ValueError(f"mesh {m}: positions must be finite numbers")
            if not prim.indices or len(prim.indices) % 3:
                raise ValueError(f"mesh {m}: indices must hold three entries per triangle")
            if min(prim.indices) < 0 or max(prim.indices) >= n_values // 3:
                raise ValueError(f"mesh {m}: an index points past the last vertex")
            if prim.normals is not None and len(prim.normals) != n_values:
                raise ValueError(f"mesh {m}: normals must have one entry per position")
            if len(prim.color) != 4:
                raise ValueError(f"mesh {m}: color must be RGBA")


def _quantize(value: float, limit: int) -> int:
    return max(-limit, min(limit, int(round(value))))


def _material_key(color) -> tuple[float, float, float, float]:
    return tuple(round(min(1.0, max(0.0, float(c))), 4) for c in color)


def _material(rgba: tuple[float, float, float, float]) -> dict:
    digits = "".join(f"{round(c * 255):02x}" for c in (rgba if rgba[3] < 1.0 else rgba[:3]))
    return {
        "name": f"color_{digits}",
        "pbrMetallicRoughness": {
            "baseColorFactor": list(rgba),
            "metallicFactor": 0.0,
            "roughnessFactor": 0.8,
        },
        "doubleSided": False,
    }


def write_glb(model: Model, *, generator: str = "") -> bytes:
    """A GLB with 3DStep's conventions (SPEC 7).

    Each part node is translated to its mesh's bounding-box center and scaled
    uniformly by the largest half extent, so its positions fit in ``SHORT``
    normalized components (``KHR_mesh_quantization``); normals are ``BYTE``
    normalized, padded to 4 bytes; indices are ``UNSIGNED_SHORT`` for up to
    65535 vertices, else ``UNSIGNED_INT``. ``generator`` (else the model's,
    else ``threedstep <version>``) is written to ``asset.generator`` and to the
    ``threedstep`` metadata.
    """
    _check_model(model)
    generator = generator or model.generator or f"threedstep {__version__}"
    binary = bytearray()
    views: list[dict] = []
    accessors: list[dict] = []
    materials: list[dict] = []
    material_index: dict[tuple, int] = {}

    def add_view(data: bytes, target: int, stride: int = 0) -> int:
        binary.extend(b"\0" * (-len(binary) % 4))
        view = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data), "target": target}
        if stride:
            view["byteStride"] = stride
        binary.extend(data)
        views.append(view)
        return len(views) - 1

    def add_accessor(acc: dict) -> int:
        accessors.append(acc)
        return len(accessors) - 1

    mesh_names = {node.mesh: node.id for node in reversed(model.nodes) if node.mesh != -1}
    transforms: list[tuple[list[float], float]] = []
    meshes_json: list[dict] = []
    for m, mesh in enumerate(model.meshes):
        box = mesh.bbox
        center = [(lo + hi) / 2 for lo, hi in zip(box["min"], box["max"])]
        scale = max(max((hi - lo) / 2 for lo, hi in zip(box["min"], box["max"])), 1e-6)
        transforms.append((center, scale))
        factor = 32767.0 / scale
        cx, cy, cz = center

        primitives = []
        for prim in mesh.primitives:
            p, count = prim.positions, len(prim.positions) // 3
            q = [_quantize((p[i] - c) * factor, 32767)
                 for v in range(count) for i, c in ((3 * v, cx), (3 * v + 1, cy), (3 * v + 2, cz))]
            # Each vertex padded from 6 to 8 bytes: vertex attributes must be
            # 4-byte aligned.
            padded = [x for v in range(count) for x in (q[3 * v], q[3 * v + 1], q[3 * v + 2], 0)]
            position = add_accessor({
                "bufferView": add_view(struct.pack(f"<{4 * count}h", *padded), _ARRAY_BUFFER, 8),
                "componentType": _SHORT, "normalized": True, "count": count, "type": "VEC3",
                "min": [min(q[k::3]) for k in range(3)],
                "max": [max(q[k::3]) for k in range(3)],
            })
            attributes = {"POSITION": position}

            if prim.normals is not None:
                n = prim.normals
                packed = []
                for v in range(count):
                    x, y, z = n[3 * v], n[3 * v + 1], n[3 * v + 2]
                    length = math.sqrt(x * x + y * y + z * z)
                    s = 127.0 / length if length > 0 and math.isfinite(length) else 0.0
                    packed.extend((_quantize(x * s, 127), _quantize(y * s, 127), _quantize(z * s, 127), 0))
                attributes["NORMAL"] = add_accessor({
                    "bufferView": add_view(struct.pack(f"<{4 * count}b", *packed), _ARRAY_BUFFER, 4),
                    "componentType": _BYTE, "normalized": True, "count": count, "type": "VEC3",
                })

            # 65535 is the primitive-restart value of UNSIGNED_SHORT, which an
            # index must never be: up to 65535 vertices means indices up to 65534.
            wide = count > 65535
            fmt = f"<{len(prim.indices)}{'I' if wide else 'H'}"
            indices = add_accessor({
                "bufferView": add_view(struct.pack(fmt, *prim.indices), _ELEMENT_ARRAY_BUFFER),
                "componentType": _UNSIGNED_INT if wide else _UNSIGNED_SHORT,
                "count": len(prim.indices), "type": "SCALAR",
            })

            key = _material_key(prim.color)
            if key not in material_index:
                material_index[key] = len(materials)
                materials.append(_material(key))
            primitives.append({"attributes": attributes, "indices": indices,
                               "material": material_index[key]})
        mesh_json = {"primitives": primitives}
        if m in mesh_names:
            mesh_json["name"] = mesh_names[m]
        meshes_json.append(mesh_json)

    nodes_json = []
    for node in model.nodes:
        extras = {"label": node.label}
        if node.src:
            extras["src"] = node.src
        out: dict = {"name": node.id, "extras": extras}
        if node.children:
            out["children"] = list(node.children)
        if node.mesh != -1:
            center, scale = transforms[node.mesh]
            out["mesh"] = node.mesh
            out["translation"] = center
            out["scale"] = [scale, scale, scale]
        nodes_json.append(out)

    gltf: dict = {
        "asset": {
            "version": "2.0",
            "generator": generator,
            "extras": {"threedstep": {"version": 1, "units": model.units, "up": model.up,
                                      "generator": generator}},
        },
        "scene": 0,
        "scenes": [{"nodes": [i for i, node in enumerate(model.nodes) if node.parent == -1]}],
        "nodes": nodes_json,
    }
    if meshes_json:
        gltf.update({
            "extensionsUsed": [_QUANTIZATION],
            "extensionsRequired": [_QUANTIZATION],
            "meshes": meshes_json,
            "materials": materials,
            "accessors": accessors,
            "bufferViews": views,
            "buffers": [{"byteLength": len(binary)}],
        })

    json_bytes = json.dumps(gltf, sort_keys=True, separators=(",", ":"), ensure_ascii=False) \
        .encode("utf-8", "replace")
    json_bytes += b" " * (-len(json_bytes) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    chunks = struct.pack("<II", len(json_bytes), _CHUNK_JSON) + json_bytes
    if binary:
        chunks += struct.pack("<II", len(binary), _CHUNK_BIN) + bytes(binary)
    return struct.pack("<III", _MAGIC, 2, 12 + len(chunks)) + chunks
