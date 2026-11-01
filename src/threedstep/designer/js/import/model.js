// The in-memory model (SPEC 13.1): one imported file, as the designer holds it
// until it is written as a GLB.
//
//   Model = { name, units: "mm", up: "z", generator,
//     nodes: [{ id, label, parent, children, mesh, src }],   // document order; roots have parent -1
//     meshes: [{ primitives: [{ positions, normals, indices, color }], bbox: { min, max }, triangles }] }
//
// A node is a part (mesh >= 0, no children) or a group (mesh -1, children),
// never both. Each mesh belongs to exactly one part, and meshes are kept in
// the order of their parts. positions and normals are Float32Arrays of x, y, z
// in model space (millimeters, the CAD file's axes, the assembly placement
// applied); normals may be null; indices is a Uint32Array, three per triangle;
// color is linear RGBA from 0 to 1, the glTF baseColorFactor.
//
// The operations below never change the model they are given: they return a
// new one. Typed arrays are shared between the old and the new model, so
// treat them as read-only.

import { isValidId, prefixIds, slugify } from "./ids.js";

export const VERSION = "0.1.0";
export const GENERATOR = `designer ${VERSION}`;
export const DEFAULT_COLOR = Object.freeze([0.8, 0.8, 0.8, 1]);

// Runtime bytes a generated page carries besides its models (the Three.js
// bundle, viewer.js and viewer.css, the page template); the designer can pass
// the real number to estimateHtmlSize once it has loaded the runtime.
export const DEFAULT_RUNTIME_BYTES = 900000;

export function createModel({ name = "", units = "mm", up = "z", generator = GENERATOR } = {}) {
  return { name, units, up, generator, nodes: [], meshes: [] };
}

// The GLB file name for an imported file ("ToqueCAN 2.step" -> "toquecan_2.glb"),
// with _2, _3, ... appended while it is in `taken`.
export function glbNameFor(fileName, taken = []) {
  const base = String(fileName || "").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const stem = base ? slugify(base) : "model";
  const used = new Set(taken);
  let name = `${stem}.glb`;
  for (let n = 2; used.has(name); n++) name = `${stem}_${n}.glb`;
  return name;
}

// The prefix a model's ids get when they clash with another model's: its GLB
// file's stem by glbNameFor's rule, then "_" (tq2_pi4.glb: tq2_pi4_).
export function idPrefixFor(name) {
  const base = String(name || "").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return `${base ? slugify(base) : "model"}_`;
}

// How a model joins a project (SPEC 7): when the project's models already use
// any of its ids (inUse: id -> the file name of the model using it), every id
// gets the model's prefix, made unique against the ids in use, so the parts of
// both stay apart; else it keeps its ids. All of a model's ids or none.
// Returns { model, prefix ("" when nothing is shared), shared: [{ id, model }] }.
export function joinIds(model, inUse) {
  const shared = model.nodes.filter(n => inUse.has(n.id)).map(n => ({ id: n.id, model: inUse.get(n.id) }));
  if (!shared.length) return { model, prefix: "", shared };
  const prefix = idPrefixFor(model.name);
  const ids = prefixIds(model.nodes.map(n => n.id), prefix, inUse.keys());
  return { model: { ...model, nodes: model.nodes.map((n, i) => ({ ...n, id: ids[i] })) }, prefix, shared };
}

// ── Meshes and primitives ──────────────────────────────────────────────

export function primitiveBBox(prim) {
  const p = prim.positions;
  if (!p || p.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

export function unionBBox(a, b) {
  if (!a) return b ? { min: b.min.slice(), max: b.max.slice() } : null;
  if (!b) return { min: a.min.slice(), max: a.max.slice() };
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function bboxDiagonal(box) {
  if (!box) return 0;
  const dx = box.max[0] - box.min[0], dy = box.max[1] - box.min[1], dz = box.max[2] - box.min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// A mesh from its primitives, with the bounding box and triangle count filled in.
export function makeMesh(primitives) {
  let bbox = null;
  let triangles = 0;
  for (const prim of primitives) {
    bbox = unionBBox(bbox, primitiveBBox(prim));
    triangles += Math.floor(prim.indices.length / 3);
  }
  return { primitives, bbox, triangles };
}

// Area-weighted vertex normals: each vertex gets the sum of the (unnormalized)
// normals of the triangles that use it. occt-import-js gives every B-rep face
// its own vertices, so this shades a face smoothly and keeps the edges
// between faces sharp.
export function computeNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (len > 0) {
      n[i] /= len; n[i + 1] /= len; n[i + 2] /= len;
    } else {
      n[i] = 0; n[i + 1] = 0; n[i + 2] = 1;
    }
  }
  return n;
}

export function clampColor(color) {
  const c = color && color.length >= 3 ? color : DEFAULT_COLOR;
  const clamp = v => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  return [clamp(c[0]), clamp(c[1]), clamp(c[2]), c.length > 3 ? clamp(c[3]) : 1];
}

// Colors that write the same material: rounded to four decimals, as glb.py does.
export function colorKey(color) {
  return clampColor(color).map(v => Math.round(v * 10000) / 10000).join(",");
}

// Primitives with the same color joined into one, in the order each color
// first appears. Fewer primitives means fewer draw calls and a smaller GLB.
export function mergePrimitives(prims) {
  const groups = new Map();
  for (const prim of prims) {
    const key = colorKey(prim.color);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(prim);
  }
  const out = [];
  for (const group of groups.values()) {
    out.push(group.length === 1 ? group[0] : concatPrimitives(group));
  }
  return out;
}

export function concatPrimitives(prims) {
  let nPos = 0, nIdx = 0;
  const withNormals = prims.some(p => p.normals);
  for (const p of prims) {
    nPos += p.positions.length;
    nIdx += p.indices.length;
  }
  const positions = new Float32Array(nPos);
  const normals = withNormals ? new Float32Array(nPos) : null;
  const indices = new Uint32Array(nIdx);
  let po = 0, io = 0;
  for (const p of prims) {
    positions.set(p.positions, po);
    if (normals) normals.set(p.normals || computeNormals(p.positions, p.indices), po);
    const base = po / 3;
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + base;
    po += p.positions.length;
    io += p.indices.length;
  }
  return { positions, normals, indices, color: clampColor(prims[0].color) };
}

// ── Queries ────────────────────────────────────────────────────────────

export function nodeIndex(model, id) {
  for (let i = 0; i < model.nodes.length; i++) if (model.nodes[i].id === id) return i;
  return -1;
}

export function nodeIds(model) {
  return model.nodes.map(n => n.id);
}

export function isPart(node) {
  return node.mesh >= 0;
}

// The node and everything under it, in document order.
export function subtree(model, index) {
  const out = [];
  const stack = [index];
  while (stack.length) {
    const i = stack.pop();
    out.push(i);
    const kids = model.nodes[i].children;
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }
  return out;
}

// Indices of the part nodes under the given ids (every part when ids is
// omitted or empty), each once, in document order.
export function partIndices(model, ids) {
  if (!ids || ids.length === 0) {
    const all = [];
    model.nodes.forEach((n, i) => { if (isPart(n)) all.push(i); });
    return all;
  }
  const seen = new Set();
  for (const id of ids) {
    const i = nodeIndex(model, id);
    if (i < 0) continue;
    for (const j of subtree(model, i)) if (isPart(model.nodes[j])) seen.add(j);
  }
  return [...seen].sort((a, b) => a - b);
}

export function triangleCount(model, ids) {
  let total = 0;
  for (const i of partIndices(model, ids)) total += model.meshes[model.nodes[i].mesh].triangles;
  return total;
}

export function vertexCount(model, ids) {
  let total = 0;
  for (const i of partIndices(model, ids)) {
    for (const p of model.meshes[model.nodes[i].mesh].primitives) total += p.positions.length / 3;
  }
  return total;
}

// { min, max } over the parts under the ids (the whole model when omitted), or null.
export function bboxOf(model, ids) {
  let box = null;
  for (const i of partIndices(model, ids)) box = unionBBox(box, model.meshes[model.nodes[i].mesh].bbox);
  return box;
}

// Ids of the parts whose bounding-box diagonal is under mm, in document order.
export function selectTiny(model, mm) {
  const out = [];
  for (const node of model.nodes) {
    if (isPart(node) && bboxDiagonal(model.meshes[node.mesh].bbox) < mm) out.push(node.id);
  }
  return out;
}

// The node tree as glb.py's tree() returns it: [{id, label, children, has_mesh}],
// which is what bridge.validate checks project ids against.
export function treeOf(model) {
  const build = i => {
    const n = model.nodes[i];
    return { id: n.id, label: n.label || n.id, children: n.children.map(build), has_mesh: isPart(n) };
  };
  const roots = [];
  model.nodes.forEach((n, i) => { if (n.parent === -1) roots.push(i); });
  return roots.map(build);
}

// Raise an Error naming the first thing that keeps the model from being a
// valid 3DStep model (the checks glb.py's writer makes).
export function checkModel(model) {
  const seen = new Set();
  const nNodes = model.nodes.length, nMeshes = model.meshes.length;
  const owner = new Array(nMeshes).fill(-1);
  model.nodes.forEach((node, i) => {
    if (!isValidId(node.id)) throw new Error(`node ${i}: ${JSON.stringify(node.id)} is not a valid id`);
    if (seen.has(node.id)) throw new Error(`node ${i}: the id '${node.id}' is used twice`);
    seen.add(node.id);
    if (node.mesh !== -1) {
      if (!(node.mesh >= 0 && node.mesh < nMeshes)) throw new Error(`node '${node.id}': mesh ${node.mesh} does not exist`);
      if (owner[node.mesh] !== -1) throw new Error(`node '${node.id}': mesh ${node.mesh} already belongs to '${model.nodes[owner[node.mesh]].id}'`);
      owner[node.mesh] = i;
      if (node.children.length) throw new Error(`node '${node.id}' has both a mesh and children`);
    }
    if (node.parent !== -1 && !(node.parent >= 0 && node.parent < nNodes && model.nodes[node.parent].children.includes(i))) {
      throw new Error(`node '${node.id}': its parent does not list it as a child`);
    }
    for (const c of node.children) {
      if (!(c >= 0 && c < nNodes) || model.nodes[c].parent !== i) throw new Error(`node '${node.id}': child ${c} does not name it as its parent`);
    }
  });
  model.meshes.forEach((mesh, m) => {
    if (!mesh.primitives.length) throw new Error(`mesh ${m} has no primitives`);
    for (const prim of mesh.primitives) {
      const nValues = prim.positions.length;
      if (nValues === 0 || nValues % 3) throw new Error(`mesh ${m}: positions must hold x, y, z for one or more vertices`);
      for (let i = 0; i < nValues; i++) {
        if (!Number.isFinite(prim.positions[i])) throw new Error(`mesh ${m}: positions must be finite numbers`);
      }
      if (!prim.indices.length || prim.indices.length % 3) throw new Error(`mesh ${m}: indices must hold three entries per triangle`);
      const nVerts = nValues / 3;
      for (let i = 0; i < prim.indices.length; i++) {
        if (prim.indices[i] >= nVerts) throw new Error(`mesh ${m}: an index points past the last vertex`);
      }
      if (prim.normals && prim.normals.length !== nValues) throw new Error(`mesh ${m}: normals must have one entry per position`);
    }
  });
}

// ── Operations ─────────────────────────────────────────────────────────

// A new model from the nodes kept (a set of old indices), in document order.
// meshFor(oldIndex) returns the mesh a kept part gets (default: its own) or
// null to make it a group; childrenFor(oldIndex) can override its children.
function rebuild(model, keep, { meshFor, childrenFor } = {}) {
  const remap = new Map();
  const order = [];
  model.nodes.forEach((n, i) => {
    if (keep.has(i)) {
      remap.set(i, order.length);
      order.push(i);
    }
  });
  const nodes = [];
  const meshes = [];
  for (const i of order) {
    const old = model.nodes[i];
    const mesh = meshFor ? meshFor(i) : (old.mesh >= 0 ? model.meshes[old.mesh] : null);
    const kids = (childrenFor ? childrenFor(i) : old.children).filter(c => remap.has(c)).map(c => remap.get(c));
    const node = {
      id: old.id,
      label: old.label,
      parent: old.parent >= 0 && remap.has(old.parent) ? remap.get(old.parent) : -1,
      children: mesh ? [] : kids,
      mesh: -1,
      src: old.src || "",
    };
    if (mesh) {
      node.mesh = meshes.length;
      meshes.push(mesh);
    }
    nodes.push(node);
  }
  return { ...model, nodes, meshes };
}

// Remove the nodes with these ids and everything under them. Groups left
// without children stay (a project may still name them); unknown ids are
// ignored.
export function deleteNodes(model, ids) {
  const drop = new Set();
  for (const id of ids) {
    const i = nodeIndex(model, id);
    if (i >= 0) for (const j of subtree(model, i)) drop.add(j);
  }
  if (!drop.size) return model;
  const keep = new Set();
  model.nodes.forEach((n, i) => { if (!drop.has(i)) keep.add(i); });
  return rebuild(model, keep);
}

// Every id that deleteNodes(model, ids) would remove, in document order.
export function deletedIds(model, ids) {
  const drop = new Set();
  for (const id of ids) {
    const i = nodeIndex(model, id);
    if (i >= 0) for (const j of subtree(model, i)) drop.add(j);
  }
  return [...drop].sort((a, b) => a - b).map(i => model.nodes[i].id);
}

// Turn a group into one part with the same id: its subtree's primitives are
// joined (by color) into one mesh and the nodes under it go away. A part, an
// unknown id or a group without parts returns the model unchanged.
export function mergeGroup(model, id) {
  const g = nodeIndex(model, id);
  if (g < 0 || isPart(model.nodes[g])) return model;
  const under = subtree(model, g).slice(1);
  const prims = [];
  for (const i of under) {
    const n = model.nodes[i];
    if (isPart(n)) prims.push(...model.meshes[n.mesh].primitives);
  }
  if (!prims.length) return model;
  const merged = makeMesh(mergePrimitives(prims));
  const drop = new Set(under);
  const keep = new Set();
  model.nodes.forEach((n, i) => { if (!drop.has(i)) keep.add(i); });
  return rebuild(model, keep, {
    meshFor: i => (i === g ? merged : (model.nodes[i].mesh >= 0 ? model.meshes[model.nodes[i].mesh] : null)),
  });
}

// Merge several parts into one: the part `keep` gets the primitives of every
// part under `ids` (a group names the parts under it), joined by color in
// document order, and the other parts go away, with the groups left without
// parts. The kept part stays where it is, with its id, label and source. The
// model unchanged when fewer than two parts are named or `keep` is not one.
export function mergeParts(model, ids, keep) {
  const parts = partIndices(model, ids);
  const k = nodeIndex(model, keep);
  if (parts.length < 2 || !parts.includes(k)) return model;
  const prims = [];
  for (const i of parts) prims.push(...model.meshes[model.nodes[i].mesh].primitives);
  const merged = makeMesh(mergePrimitives(prims));
  const drop = new Set(parts.filter(i => i !== k));
  // A group whose every child goes, goes too; children come after their
  // parent, so one pass from the end settles nested groups.
  for (let i = model.nodes.length - 1; i >= 0; i--) {
    const n = model.nodes[i];
    if (!isPart(n) && n.children.length && n.children.every(c => drop.has(c))) drop.add(i);
  }
  const kept = new Set();
  model.nodes.forEach((n, i) => { if (!drop.has(i)) kept.add(i); });
  return rebuild(model, kept, {
    meshFor: i => (i === k ? merged : (model.nodes[i].mesh >= 0 ? model.meshes[model.nodes[i].mesh] : null)),
  });
}

// Give a part (by id, or by mesh index) a new mesh, as after simplifying it.
// The bounding box and triangle count are recomputed from the primitives.
export function replaceMesh(model, which, mesh) {
  const m = typeof which === "number" ? which : model.nodes[nodeIndex(model, which)]?.mesh;
  if (!(m >= 0 && m < model.meshes.length)) throw new Error(`replaceMesh: no part or mesh ${JSON.stringify(which)}`);
  const meshes = model.meshes.slice();
  meshes[m] = makeMesh(mesh.primitives);
  return { ...model, nodes: model.nodes.slice(), meshes };
}

// ── Size estimates ─────────────────────────────────────────────────────

// About how many bytes glb-writer.js writes for this model: the binary chunk
// exactly, the JSON chunk from per-element averages of the writer's output.
export function estimateGlbSize(model) {
  let bin = 0;
  let json = 400;
  const materials = new Set();
  for (const node of model.nodes) {
    json += 40 + 2 * node.id.length + (node.label || "").length + 4 * node.children.length;
    if (!isPart(node)) continue;
    json += 140 + node.id.length;
    for (const prim of model.meshes[node.mesh].primitives) {
      const verts = prim.positions.length / 3;
      bin += 8 * verts;
      if (prim.normals) bin += 4 * verts;
      bin += Math.ceil((prim.indices.length * (verts > 65535 ? 4 : 2)) / 4) * 4;
      json += prim.normals ? 600 : 480;
      materials.add(colorKey(prim.color));
    }
  }
  json += 130 * materials.size;
  return 28 + json + bin;
}

// The size of a generated page with these models: each GLB inlined as base64
// (4/3 of its bytes) plus the runtime.
export function estimateHtmlSize(models, { runtimeBytes = DEFAULT_RUNTIME_BYTES } = {}) {
  let total = runtimeBytes;
  for (const model of models) total += Math.ceil(estimateGlbSize(model) / 3) * 4;
  return total;
}

// ── Foreign models ─────────────────────────────────────────────────────

// 4x4 matrices are column-major arrays of 16 numbers, as in glTF.
export function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiplyMatrices(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

// The matrix of a glTF node: its matrix, else translation * rotation * scale.
export function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

// Bake each part's world matrix into its positions and normals, so the model
// carries no transforms (SPEC 13.3). The input is a model whose nodes also
// have a `matrix` (the world matrix, column-major) and whose meshes may be
// shared by several nodes (glTF instancing); every part gets its own copy.
// A mirroring matrix flips the triangle winding so faces stay outward.
export function flattenForeign(model) {
  const meshes = [];
  const nodes = model.nodes.map(node => {
    const out = { id: node.id, label: node.label, parent: node.parent, children: node.children.slice(), mesh: -1, src: node.src || "" };
    if (node.mesh >= 0) {
      const m = node.matrix || identityMatrix();
      out.mesh = meshes.length;
      meshes.push(makeMesh(model.meshes[node.mesh].primitives.map(p => transformPrimitive(p, m))));
    }
    return out;
  });
  return { name: model.name, units: model.units, up: model.up, generator: model.generator, nodes, meshes };
}

export function transformPrimitive(prim, m) {
  const p = prim.positions;
  const positions = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  // Normals go through the inverse transpose of the upper 3x3, which is the
  // cofactor matrix up to a scale that the normalization removes.
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  let normals = null;
  if (prim.normals) {
    const n = prim.normals;
    const c00 = e * k - f * h, c01 = -(d * k - f * g), c02 = d * h - e * g;
    const c10 = -(b * k - c * h), c11 = a * k - c * g, c12 = -(a * h - b * g);
    const c20 = b * f - c * e, c21 = -(a * f - c * d), c22 = a * e - b * d;
    const sign = det < 0 ? -1 : 1;
    normals = new Float32Array(n.length);
    for (let i = 0; i < n.length; i += 3) {
      const x = n[i], y = n[i + 1], z = n[i + 2];
      const nx = c00 * x + c01 * y + c02 * z, ny = c10 * x + c11 * y + c12 * z, nz = c20 * x + c21 * y + c22 * z;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals[i] = (sign * nx) / len;
      normals[i + 1] = (sign * ny) / len;
      normals[i + 2] = (sign * nz) / len;
    }
  }
  let indices = prim.indices;
  if (det < 0) {
    indices = new Uint32Array(prim.indices.length);
    for (let t = 0; t + 2 < prim.indices.length; t += 3) {
      indices[t] = prim.indices[t];
      indices[t + 1] = prim.indices[t + 2];
      indices[t + 2] = prim.indices[t + 1];
    }
  }
  return { positions, normals, indices, color: prim.color };
}

// ── Axes ───────────────────────────────────────────────────────────────

// Rotation from one up axis to another, as a column-major 4x4 matrix: a
// quarter turn about X.
export function upMatrix(from, to) {
  if (from === to) return identityMatrix();
  // Y-up to Z-up: (x, y, z) -> (x, -z, y); Z-up to Y-up: (x, y, z) -> (x, z, -y).
  return from === "y"
    ? [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]
    : [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
}

// The model turned from its up axis to `up` ("y" or "z"), as a model added to
// a project with the other axis is (SPEC 13.3): every part's positions and
// normals go through upMatrix, as a foreign file's do in glb-reader.js, and
// the model says `up`. The model itself when it has that axis already.
export function convertUp(model, up) {
  const from = model.up === "y" ? "y" : "z";
  if ((up !== "y" && up !== "z") || from === up) return model;
  const m = upMatrix(from, up);
  return {
    ...model,
    up,
    nodes: model.nodes.slice(),
    meshes: model.meshes.map(mesh => makeMesh(mesh.primitives.map(p => transformPrimitive(p, m)))),
  };
}
