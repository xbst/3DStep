// Mesh simplification (SPEC 13.4) with meshoptimizer's simplifier. Each
// primitive is simplified on its positions alone; the simplifier keeps the
// original vertices and only drops triangles, so the kept vertices keep the
// exact surface normals occt-import-js computed (recomputed by area-weighted
// smoothing for a primitive that had none). Returns new meshes; the caller
// replaces them in the model with undo.

import { MeshoptSimplifier } from "../../vendor/meshopt_simplifier.module.js";
import { computeNormals, makeMesh, nodeIndex, partIndices } from "./model.js";

// Defaults: keep at most 1% deviation of each primitive's extent while
// heading for the target ratio, which may stop the simplifier early.
export const DEFAULT_ERROR = 0.01;

export function simplifierReady() {
  if (!MeshoptSimplifier.supported) return Promise.reject(new Error("mesh simplification needs WebAssembly"));
  return MeshoptSimplifier.ready;
}

// One primitive at `ratio` of its triangles. error is relative to the
// primitive's extent, or millimeters with absolute: true. Returns
// { primitive, error } with the error the simplifier reached (same unit).
export function simplifyPrimitive(prim, { ratio = 0.5, error = DEFAULT_ERROR, absolute = false, lockBorder = false } = {}) {
  const triangles = prim.indices.length / 3;
  const target = Math.max(1, Math.floor(triangles * ratio)) * 3;
  if (target >= prim.indices.length || triangles < 4) return { primitive: prim, error: 0 };
  const flags = [];
  if (lockBorder) flags.push("LockBorder");
  if (absolute) flags.push("ErrorAbsolute");
  const indices = prim.indices instanceof Uint32Array ? prim.indices : Uint32Array.from(prim.indices);
  const [out, reached] = MeshoptSimplifier.simplify(indices, prim.positions, 3, target, error, flags);
  if (!out.length || out.length >= prim.indices.length) return { primitive: prim, error: 0 };

  // Drop the vertices no triangle uses any more (compactMesh rewrites `out`).
  const [remap, unique] = MeshoptSimplifier.compactMesh(out);
  const positions = new Float32Array(unique * 3);
  const normals = prim.normals ? new Float32Array(unique * 3) : null;
  const src = prim.positions, nsrc = prim.normals;
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r === 0xffffffff) continue;
    positions[3 * r] = src[3 * v];
    positions[3 * r + 1] = src[3 * v + 1];
    positions[3 * r + 2] = src[3 * v + 2];
    if (normals) {
      normals[3 * r] = nsrc[3 * v];
      normals[3 * r + 1] = nsrc[3 * v + 1];
      normals[3 * r + 2] = nsrc[3 * v + 2];
    }
  }
  return {
    primitive: { positions, normals: normals || computeNormals(positions, out), indices: out, color: prim.color },
    error: reached,
  };
}

// A mesh with every primitive simplified. Resolves to { mesh, before, after, error }
// (triangle counts, and the largest error any primitive reached).
export async function simplifyMesh(mesh, options = {}) {
  await simplifierReady();
  let worst = 0;
  const primitives = mesh.primitives.map(prim => {
    const { primitive, error } = simplifyPrimitive(prim, options);
    worst = Math.max(worst, error);
    return primitive;
  });
  const out = makeMesh(primitives);
  return { mesh: out, before: mesh.triangles, after: out.triangles, error: worst };
}

// Simplify the parts under ids (every part when ids is empty). Resolves to
// { model, before, after, parts } with a new model; the old one is untouched.
export async function simplifyModel(model, ids, options = {}) {
  await simplifierReady();
  const meshes = model.meshes.slice();
  let before = 0, after = 0, parts = 0;
  for (const i of partIndices(model, ids)) {
    const m = model.nodes[i].mesh;
    const { mesh, before: b, after: a } = await simplifyMesh(model.meshes[m], options);
    meshes[m] = mesh;
    before += b;
    after += a;
    parts++;
  }
  return { model: { ...model, nodes: model.nodes.slice(), meshes }, before, after, parts };
}

// Simplify one part by id; resolves to the same shape as simplifyModel.
export function simplifyPart(model, id, options = {}) {
  if (nodeIndex(model, id) < 0) return Promise.reject(new Error(`no part '${id}'`));
  return simplifyModel(model, [id], options);
}
