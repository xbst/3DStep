// GLB (or .gltf with embedded buffers) -> Model.
//
// A 3DStep GLB (asset.extras.threedstep present) round-trips: node names are
// the ids, extras.label and extras.src come back, positions are dequantized
// to Float32Array in model space, units and up come from the metadata. An
// import into a project with the other up axis turns it with model.js's
// convertUp, the same rotation; opening a project's GLB never does.
//
// A foreign GLB (Blender, Fusion, ...) is converted (SPEC 13.3): node
// transforms are baked into the positions, units are scaled to millimeters
// and the up axis is rotated to the project's, names become ids by the id
// rule, and each instance of a shared mesh becomes its own part. The caller
// says which unit and up axis the file uses (glTF's own convention, meters
// and Y-up, by default).

import { assignIds, isValidId } from "./ids.js";
import {
  DEFAULT_COLOR, GENERATOR, clampColor, flattenForeign, identityMatrix, mergePrimitives, multiplyMatrices, nodeMatrix,
  upMatrix,
} from "./model.js";

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export const UNIT_FACTORS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

// Extensions that change how geometry is stored, which this reader cannot
// decode; the message names what to turn off in the exporter.
const UNSUPPORTED = {
  KHR_draco_mesh_compression: "Draco mesh compression",
  EXT_meshopt_compression: "meshopt compression",
  KHR_meshopt_compression: "meshopt compression",
  EXT_mesh_gpu_instancing: "GPU instancing",
};

export class GlbError extends Error {}

// The checks that keep a malformed document from reaching the code below as
// a TypeError or RangeError: each names the problem in a GlbError.
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function listOf(v, what) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new GlbError(`${what} is not a list`);
  return v;
}

function isIndex(v) {
  return Number.isInteger(v) && v >= 0;
}

function finiteList(v, length) {
  return Array.isArray(v) && v.length === length && v.every(Number.isFinite);
}

const TRANSFORMS = { translation: 3, rotation: 4, scale: 3, matrix: 16 };

function checkNode(n, i) {
  if (!isObject(n)) throw new GlbError(`node ${i} is not an object`);
  for (const [key, length] of Object.entries(TRANSFORMS)) {
    if (n[key] !== undefined && !finiteList(n[key], length)) throw new GlbError(`node ${i}: ${key} is not a list of ${length} numbers`);
  }
  if (n.mesh !== undefined && !isIndex(n.mesh)) throw new GlbError(`node ${i}: mesh ${JSON.stringify(n.mesh)} is not an index`);
  if (!listOf(n.children, `node ${i}: children`).every(isIndex)) throw new GlbError(`node ${i}: children are not node indices`);
}

// ── Containers ─────────────────────────────────────────────────────────

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new GlbError("expected the file's bytes (an ArrayBuffer or Uint8Array)");
}

export function isGlb(data) {
  const b = asBytes(data);
  return b.length >= 4 && new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) === MAGIC;
}

// The JSON chunk and the BIN chunk (or null) of a GLB. As strict about the
// container as glb.read_glb, so the designer refuses at import what Generate
// and the command line would refuse: the JSON chunk comes first and the
// header's length is the file's.
export function parseGlb(data) {
  const b = asBytes(data);
  if (b.length < 20) throw new GlbError("not a GLB file (it is too short)");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new GlbError("not a GLB file (the header does not start with glTF)");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new GlbError(`this is a glTF ${version} binary; only glTF 2.0 is supported`);
  const length = dv.getUint32(8, true);
  if (length !== b.length) throw new GlbError(`the GLB header says ${length} bytes, but the file has ${b.length}`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < length) {
    if (offset + 8 > length) throw new GlbError("a GLB chunk header runs past the end of the file");
    const size = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > length) throw new GlbError("a GLB chunk runs past the end of the file");
    if (json === null) {
      if (type !== CHUNK_JSON) throw new GlbError("the first GLB chunk is not JSON");
      try {
        json = JSON.parse(new TextDecoder().decode(b.subarray(start, start + size)));
      } catch (err) {
        throw new GlbError(`the GLB's JSON chunk is not valid JSON (${err.message})`);
      }
    } else if (type === CHUNK_BIN && bin === null) {
      bin = b.subarray(start, start + size);
    }
    offset = start + size + (-size & 3);
  }
  if (!json) throw new GlbError("the GLB has no JSON chunk");
  return { json, bin };
}

function decodeDataUri(uri, what) {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new GlbError(`${what} has an unreadable data URI`);
  if (!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2]));
  const text = atob(m[2]);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function loadBuffers(json, bin) {
  return listOf(json.buffers, "buffers").map((buf, i) => {
    if (!isObject(buf)) throw new GlbError(`buffer ${i} is not an object`);
    if (buf.uri === undefined) {
      if (i === 0 && bin) return bin;
      throw new GlbError(`buffer ${i} has no data`);
    }
    if (/^data:/i.test(buf.uri)) return decodeDataUri(buf.uri, `buffer ${i}`);
    throw new GlbError(`buffer ${i} is a separate file (${buf.uri}); export a .glb, or a .gltf with embedded buffers`);
  });
}

// ── Accessors ──────────────────────────────────────────────────────────

function componentReader(dv, type, normalized) {
  switch (type) {
    case 5120: return normalized ? o => Math.max(dv.getInt8(o) / 127, -1) : o => dv.getInt8(o);
    case 5121: return normalized ? o => dv.getUint8(o) / 255 : o => dv.getUint8(o);
    case 5122: return normalized ? o => Math.max(dv.getInt16(o, true) / 32767, -1) : o => dv.getInt16(o, true);
    case 5123: return normalized ? o => dv.getUint16(o, true) / 65535 : o => dv.getUint16(o, true);
    case 5125: return o => dv.getUint32(o, true);
    case 5126: return o => dv.getFloat32(o, true);
    default: throw new GlbError(`accessor component type ${type} is not valid`);
  }
}

const ARRAY_TYPES = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NORMALIZE = { 5120: v => Math.max(v / 127, -1), 5121: v => v / 255, 5122: v => Math.max(v / 32767, -1), 5123: v => v / 65535 };

// The accessor's values as a flat array (Float32Array, or Uint32Array when
// asked for indices), normalized integers mapped to -1..1 or 0..1, sparse
// substitutions applied.
function readAccessor(json, buffers, index, { indices = false } = {}) {
  const acc = (json.accessors || [])[index];
  if (!acc) throw new GlbError(`accessor ${index} does not exist`);
  const n = TYPE_SIZES[acc.type];
  const size = COMPONENT_BYTES[acc.componentType];
  if (!n || !size) throw new GlbError(`accessor ${index} has an unknown type`);
  if (!isIndex(acc.count)) throw new GlbError(`accessor ${index} has no valid count`);
  const count = acc.count;
  const out = indices ? new Uint32Array(count * n) : new Float32Array(count * n);
  const normalized = !!acc.normalized && acc.componentType !== 5126;

  if (acc.bufferView !== undefined) {
    const view = (json.bufferViews || [])[acc.bufferView];
    if (!view) throw new GlbError(`accessor ${index}: buffer view ${acc.bufferView} does not exist`);
    const buf = buffers[view.buffer];
    if (!buf) throw new GlbError(`accessor ${index}: buffer ${view.buffer} does not exist`);
    const stride = view.byteStride || n * size;
    const viewStart = view.byteOffset || 0;
    const start = viewStart + (acc.byteOffset || 0);
    if (!isIndex(stride) || !isIndex(viewStart) || !isIndex(start) || !isIndex(view.byteLength)) {
      throw new GlbError(`accessor ${index}: its buffer view or offset is not valid`);
    }
    const end = count ? start + stride * (count - 1) + n * size : start;
    if (end > viewStart + view.byteLength || viewStart + view.byteLength > buf.byteLength) {
      throw new GlbError(`accessor ${index} reads past the end of its buffer`);
    }
    const abs = buf.byteOffset + start;
    if (abs % size === 0 && stride % size === 0) {
      // Aligned: read through a typed array view of the component type.
      const Arr = ARRAY_TYPES[acc.componentType];
      const src = new Arr(buf.buffer, abs, count ? (end - start) / size : 0);
      const step = stride / size;
      const norm = normalized ? NORMALIZE[acc.componentType] : null;
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < n; k++) {
          const v = src[i * step + k];
          out[i * n + k] = norm ? norm(v) : v;
        }
      }
    } else {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const read = componentReader(dv, acc.componentType, normalized);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < n; k++) out[i * n + k] = read(start + i * stride + k * size);
      }
    }
  }
  return out;
}

// Sparse accessors keep their substitutions in two small arrays; read them
// with the same code by wrapping each in a temporary accessor.
function applySparse(json, buffers, index, out) {
  const acc = json.accessors[index];
  const sp = acc.sparse;
  if (!sp || !(sp.count > 0)) return out;
  if (!isObject(sp.indices) || !isObject(sp.values)) throw new GlbError(`accessor ${index}: its sparse indices or values are missing`);
  const n = TYPE_SIZES[acc.type];
  const tmp = { ...json, accessors: [
    { bufferView: sp.indices.bufferView, byteOffset: sp.indices.byteOffset || 0, componentType: sp.indices.componentType, count: sp.count, type: "SCALAR" },
    { bufferView: sp.values.bufferView, byteOffset: sp.values.byteOffset || 0, componentType: acc.componentType, normalized: acc.normalized, count: sp.count, type: acc.type },
  ] };
  const where = readAccessor(tmp, buffers, 0, { indices: true });
  const values = readAccessor(tmp, buffers, 1);
  for (let i = 0; i < sp.count; i++) {
    for (let k = 0; k < n; k++) out[where[i] * n + k] = values[i * n + k];
  }
  return out;
}

function accessor(json, buffers, index, opts) {
  const out = readAccessor(json, buffers, index, opts);
  return applySparse(json, buffers, index, out);
}

// ── Meshes ─────────────────────────────────────────────────────────────

function triangleIndices(mode, idx, count, what, warnings) {
  const v = idx || Uint32Array.from({ length: count }, (_, i) => i);
  if (mode === 4) return v;
  const tris = [];
  if (mode === 5) {
    for (let i = 0; i + 2 < v.length; i++) {
      if (i % 2 === 0) tris.push(v[i], v[i + 1], v[i + 2]);
      else tris.push(v[i + 1], v[i], v[i + 2]);
    }
    return Uint32Array.from(tris);
  }
  if (mode === 6) {
    for (let i = 1; i + 1 < v.length; i++) tris.push(v[0], v[i], v[i + 1]);
    return Uint32Array.from(tris);
  }
  warnings.push(`${what}: points and lines are not supported and were skipped`);
  return null;
}

function decodeMesh(json, buffers, m, warnings) {
  const mesh = (json.meshes || [])[m];
  if (!isObject(mesh)) throw new GlbError(`mesh ${m} does not exist`);
  const prims = [];
  listOf(mesh.primitives, `mesh ${m}: primitives`).forEach((p, k) => {
    const what = `mesh ${mesh.name ? `'${mesh.name}'` : m} primitive ${k}`;
    if (!isObject(p)) throw new GlbError(`${what} is not an object`);
    if (p.extensions) {
      for (const ext of Object.keys(p.extensions)) {
        if (UNSUPPORTED[ext]) throw new GlbError(`${what} uses ${ext} (${UNSUPPORTED[ext]}), which 3DStep cannot read; export the file again without it`);
      }
    }
    const attrs = p.attributes || {};
    if (attrs.POSITION === undefined) {
      warnings.push(`${what} has no positions and was skipped`);
      return;
    }
    const positions = accessor(json, buffers, attrs.POSITION);
    const count = positions.length / 3;
    if (!count) return;
    let normals = null;
    if (attrs.NORMAL !== undefined) {
      normals = accessor(json, buffers, attrs.NORMAL);
      if (normals.length !== positions.length) normals = null;
    }
    const mode = p.mode === undefined ? 4 : p.mode;
    const raw = p.indices !== undefined ? accessor(json, buffers, p.indices, { indices: true }) : null;
    const indices = triangleIndices(mode, raw, count, what, warnings);
    if (!indices || !indices.length) return;
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] >= count) throw new GlbError(`${what}: an index points past the last vertex`);
    }
    let color = DEFAULT_COLOR;
    if (p.material !== undefined) {
      const mat = (json.materials || [])[p.material];
      const factor = mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor;
      color = clampColor(Array.isArray(factor) ? factor : [1, 1, 1, 1]);
    }
    prims.push({ positions, normals, indices, color: clampColor(color) });
  });
  return prims;
}

// ── Models ─────────────────────────────────────────────────────────────

function scaleMatrix(s) {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
}

function checkExtensions(json) {
  const names = new Set([...listOf(json.extensionsRequired, "extensionsRequired"), ...listOf(json.extensionsUsed, "extensionsUsed")]);
  for (const ext of names) {
    if (UNSUPPORTED[ext]) throw new GlbError(`this file uses ${ext} (${UNSUPPORTED[ext]}), which 3DStep cannot read; export it again without ${UNSUPPORTED[ext]}`);
  }
}

// The 3DStep metadata of a parsed glTF, or null for a foreign file.
export function threedstepMetadata(json) {
  const extras = json.asset && json.asset.extras;
  const meta = extras && typeof extras === "object" ? extras.threedstep : null;
  return meta && typeof meta === "object" ? meta : null;
}

// Read a .glb or a .gltf (embedded buffers) into a Model.
//   name: the model's file name (default "model.glb")
//   units, up: what a foreign file uses ("m" and "y", glTF's convention, by default)
//   targetUp: the project's up axis ("z" by default)
export function readGlb(data, { name = "model.glb", units = "m", up = "y", targetUp = "z", generator } = {}) {
  const bytes = asBytes(data);
  let json, bin;
  let kind = "glb";
  if (isGlb(bytes)) {
    ({ json, bin } = parseGlb(bytes));
  } else {
    kind = "gltf";
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new GlbError("not a GLB or glTF file");
    }
    bin = null;
  }
  if (!json || typeof json !== "object" || !json.asset) throw new GlbError("not a glTF 2.0 file (no asset)");
  if (String(json.asset.version || "").split(".")[0] !== "2") throw new GlbError(`this is glTF ${json.asset.version}; only glTF 2.0 is supported`);
  checkExtensions(json);
  const buffers = loadBuffers(json, bin);
  const warnings = [];
  const meta = threedstepMetadata(json);
  const nodesJson = listOf(json.nodes, "nodes");
  nodesJson.forEach(checkNode);
  const nodeAt = i => {
    if (!isIndex(i) || i >= nodesJson.length) throw new GlbError(`node ${JSON.stringify(i)} does not exist`);
    return nodesJson[i];
  };

  // The model-space conversion applied above the roots.
  let root = identityMatrix();
  let modelUnits = "mm", modelUp = targetUp;
  if (meta) {
    modelUnits = meta.units || "mm";
    modelUp = meta.up || "z";
    if (meta.version !== undefined && meta.version > 1) warnings.push(`this model was written by a newer 3DStep (format version ${meta.version})`);
  } else {
    const factor = UNIT_FACTORS[units];
    if (!factor) throw new GlbError(`unknown unit '${units}' (expected ${Object.keys(UNIT_FACTORS).join(", ")})`);
    if (up !== "y" && up !== "z") throw new GlbError(`unknown up axis '${up}' (expected y or z)`);
    root = multiplyMatrices(upMatrix(up, targetUp), scaleMatrix(factor));
  }

  // Roots: the default scene's nodes, else every node that is nobody's child.
  const scene = (json.scenes || [])[json.scene !== undefined ? json.scene : 0];
  let roots = scene && Array.isArray(scene.nodes) ? scene.nodes : null;
  if (!roots) {
    const isChild = new Set();
    nodesJson.forEach(n => (n.children || []).forEach(c => isChild.add(c)));
    roots = nodesJson.map((_, i) => i).filter(i => !isChild.has(i));
  }

  // Which glTF nodes lead to geometry (foreign files drop the rest).
  const meshPrims = new Map();
  const primsOf = m => {
    if (!meshPrims.has(m)) {
      const prims = decodeMesh(json, buffers, m, warnings);
      meshPrims.set(m, meta ? prims : mergePrimitives(prims));
    }
    return meshPrims.get(m);
  };
  const geometry = new Map();
  const hasGeometry = (i, stack = new Set()) => {
    if (geometry.has(i)) return geometry.get(i);
    if (stack.has(i)) throw new GlbError(`node ${i} is its own ancestor`);
    const n = nodeAt(i);
    stack.add(i);
    let yes = n.mesh !== undefined && primsOf(n.mesh).length > 0;
    for (const c of n.children || []) if (hasGeometry(c, stack)) yes = true;
    stack.delete(i);
    geometry.set(i, yes);
    return yes;
  };

  // Entries in document order: { gltf, label, id?, src, parent, mesh (glTF mesh index or -1), matrix }.
  const entries = [];
  const ancestors = new Set();
  const visit = (i, parent, world) => {
    const n = nodeAt(i);
    if (ancestors.has(i)) throw new GlbError(`node ${i} is its own ancestor`);
    const matrix = multiplyMatrices(world, nodeMatrix(n));
    const kids = n.children || [];
    const extras = n.extras && typeof n.extras === "object" ? n.extras : {};
    if (meta) {
      if (n.mesh !== undefined && kids.length) throw new GlbError(`node '${n.name}' has both a mesh and children`);
      const e = { id: n.name, label: typeof extras.label === "string" ? extras.label : n.name, src: typeof extras.src === "string" ? extras.src : "", parent, mesh: n.mesh !== undefined ? n.mesh : -1, matrix };
      entries.push(e);
      const self = entries.length - 1;
      ancestors.add(i);
      for (const c of kids) visit(c, self, matrix);
      ancestors.delete(i);
      return;
    }
    if (!hasGeometry(i)) return;
    const meshName = n.mesh !== undefined && json.meshes[n.mesh] ? json.meshes[n.mesh].name : "";
    const label = n.name || meshName || "part";
    const ownMesh = n.mesh !== undefined && primsOf(n.mesh).length > 0;
    const liveKids = kids.filter(c => hasGeometry(c));
    if (ownMesh && !liveKids.length) {
      entries.push({ label, src: `node ${i}`, parent, mesh: n.mesh, matrix });
      return;
    }
    entries.push({ label, src: `node ${i}`, parent, mesh: -1, matrix });
    const self = entries.length - 1;
    if (ownMesh) entries.push({ label, src: `node ${i} mesh`, parent: self, mesh: n.mesh, matrix });
    for (const c of liveKids) visit(c, self, matrix);
  };
  for (const r of roots) visit(r, -1, root);

  if (meta) {
    const seen = new Set();
    for (const e of entries) {
      if (!isValidId(e.id)) throw new GlbError(`node name ${JSON.stringify(e.id)} is not a valid id`);
      if (seen.has(e.id)) throw new GlbError(`node name '${e.id}' is used twice`);
      seen.add(e.id);
    }
  } else {
    const ids = assignIds(entries.map(e => e.label));
    entries.forEach((e, k) => { e.id = ids[k]; });
  }

  // One mesh slot per glTF mesh for flattenForeign, which gives every part its own copy.
  const slot = new Map();
  const meshes = [];
  const nodes = entries.map(e => ({ id: e.id, label: e.label, parent: e.parent, children: [], mesh: -1, src: e.src, matrix: e.matrix }));
  entries.forEach((e, k) => {
    if (e.parent >= 0) nodes[e.parent].children.push(k);
    if (e.mesh >= 0) {
      const prims = primsOf(e.mesh);
      if (!prims.length) {
        if (!meta) return;
        throw new GlbError(`part '${e.id}' has no triangles`);
      }
      if (!slot.has(e.mesh)) {
        slot.set(e.mesh, meshes.length);
        meshes.push({ primitives: prims });
      }
      nodes[k].mesh = slot.get(e.mesh);
    }
  });

  const flat = flattenForeign({ name, units: modelUnits, up: modelUp, generator: generator || GENERATOR, nodes, meshes });
  // A transform or an accessor can still give values past the float range.
  for (const node of flat.nodes) {
    if (node.mesh < 0) continue;
    for (const prim of flat.meshes[node.mesh].primitives) {
      if (!prim.positions.every(Number.isFinite)) throw new GlbError(`part '${node.id}' has positions that are not finite numbers`);
    }
  }
  flat.stats = { source: { name, bytes: bytes.byteLength, kind, threedstep: !!meta }, warnings };
  return flat;
}
