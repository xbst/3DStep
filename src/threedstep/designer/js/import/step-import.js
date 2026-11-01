// STEP -> Model (SPEC 13.2). occt-import-js reads and tessellates the file in
// a worker (occt-worker.js); buildModel turns its result into a Model on the
// main thread: the tree mapping, ids assigned before the size filter, colors,
// typed arrays and bounding boxes. buildModel is pure, so it also runs in Node
// on a recorded result.

import { assignIds } from "./ids.js";
import {
  DEFAULT_COLOR, GENERATOR, bboxDiagonal, clampColor, computeNormals, createModel, glbNameFor, makeMesh, mergePrimitives,
  primitiveBBox,
} from "./model.js";

// Tessellation presets (SPEC 11.3): linearDeflection is a ratio of the mean
// bounding-box extent of each top-level shape, angularDeflection is radians.
// "normal" is the library's default.
export const QUALITY = Object.freeze({
  fine: Object.freeze({ linearDeflection: 0.0005, angularDeflection: 0.3 }),
  normal: Object.freeze({ linearDeflection: 0.001, angularDeflection: 0.5 }),
  coarse: Object.freeze({ linearDeflection: 0.003, angularDeflection: 0.8 }),
});

export const OCCT_VERSION = "0.0.23";
export const CDN_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;
// The designer's own copy (designer/vendor/), wherever the page that imports this module lives.
export const VENDOR_BASE = new URL("../../vendor/", import.meta.url).href;

export class StepImportError extends Error {
  // kind: "load" (the library did not load), "read" (not a readable STEP file),
  // "empty" (no geometry), "memory" (the WASM heap ran out), "crash" (any other abort).
  constructor(message, { kind = "crash", log = [], heapBytes = 0 } = {}) {
    super(message);
    this.name = "StepImportError";
    this.kind = kind;
    this.log = log;
    this.heapBytes = heapBytes;
  }
}

// The ReadStepFile parameters for an import's options: an explicit
// deflection (mm) and angle (degrees) win over the quality preset.
export function occtParams({ quality = "normal", deflection, angle } = {}) {
  const preset = QUALITY[quality] || QUALITY.normal;
  const params = {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: preset.linearDeflection,
    angularDeflection: preset.angularDeflection,
  };
  if (deflection > 0) {
    params.linearDeflectionType = "absolute_value";
    params.linearDeflection = deflection;
  }
  if (angle > 0) params.angularDeflection = (angle * Math.PI) / 180;
  return params;
}

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function resolveBase(url) {
  const base = typeof document !== "undefined" ? document.baseURI : self.location.href;
  const href = new URL(url, base).href;
  return href.endsWith("/") ? href : href + "/";
}

function memoryMessage(name, unmeshed) {
  // Reading alone filled the heap: a coarser mesh would not help.
  if (unmeshed) {
    return `Out of memory while reading ${name}: reading the file took all of the 2 GB the STEP reader can use, ` +
      "leaving nothing to mesh it with. Split the assembly into smaller STEP files (a project can hold several).";
  }
  return `Out of memory while reading ${name}: the STEP reader can use at most 2 GB. ` +
    "Import it with the coarse quality, or split the assembly into smaller STEP files.";
}

// Run occt-import-js on a STEP file in a fresh worker. Resolves to
// { result, timings, heapBytes, base } with the library's result (its
// position, normal and index arrays as typed arrays).
export function readStepRaw(file, { baseUrls = [VENDOR_BASE], quality, deflection, angle, signal, onProgress, name } = {}) {
  name = name || (file && file.name) || "model.step";
  const size = file && (file.size !== undefined ? file.size : file.byteLength) || 0;
  const params = occtParams({ quality, deflection, angle });
  const bases = baseUrls.map(resolveBase);
  const start = performance.now();
  const progress = (phase, message, extra) => {
    if (onProgress) onProgress(Object.assign({ phase, message, elapsedMs: performance.now() - start }, extra));
  };

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DOMException("The import was canceled", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./occt-worker.js", import.meta.url));
    let done = false;
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      worker.terminate();
      if (signal) signal.removeEventListener("abort", onAbort);
      settle(value);
    };
    const onAbort = () => finish(reject, new DOMException("The import was canceled", "AbortError"));
    if (signal) signal.addEventListener("abort", onAbort);

    worker.onmessage = ev => {
      const msg = ev.data;
      if (msg.type === "progress") {
        if (msg.phase === "load") progress("load", "Loading the STEP reader…");
        else if (msg.phase === "read") progress("read", `Reading ${name} (${formatMB(msg.bytes)})…`, { bytes: msg.bytes });
        else if (msg.phase === "convert") progress("convert", "Receiving the meshes…");
      } else if (msg.type === "result") {
        finish(resolve, msg);
      } else if (msg.type === "error") {
        const message = msg.kind === "memory" ? memoryMessage(name, msg.unmeshed)
          : msg.kind === "read" ? `${name} could not be read as a STEP file.${msg.log.length ? ` The reader said: ${msg.log.slice(-3).join(" ")}` : ""}`
          : msg.kind === "load" ? msg.message
          : `The STEP reader stopped while reading ${name}: ${msg.message}`;
        finish(reject, new StepImportError(message, msg));
      }
    };
    worker.onerror = ev => {
      ev.preventDefault();
      finish(reject, new StepImportError(`The STEP reader stopped while reading ${name}: ${ev.message || "the worker failed"}`));
    };
    worker.onmessageerror = () => finish(reject, new StepImportError(`The STEP reader's result for ${name} could not be received`));

    progress("start", `Reading ${name} (${formatMB(size)})…`, { bytes: size });
    let payload = file;
    if (!(typeof Blob !== "undefined" && file instanceof Blob)) {
      // Copy, so the caller's buffer is not detached by the transfer.
      const view = ArrayBuffer.isView(file) ? file : new Uint8Array(file);
      payload = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    }
    worker.postMessage({ baseUrls: bases, file: payload, name, params }, payload instanceof ArrayBuffer ? [payload] : []);
  });
}

// Import a STEP file (a File, Blob, ArrayBuffer or Uint8Array) as a Model.
//   quality: "fine" | "normal" | "coarse", or deflection (mm) and angle (degrees)
//   minSize: drop bodies whose bounding-box diagonal is under this many mm (0 keeps all)
//   mergeBodies: one part per product (default) instead of one part per body
//   baseUrls: where occt-import-js.js and .wasm are, tried in order (default: designer/vendor/)
//   signal: an AbortSignal that cancels the import (the worker is terminated)
//   onProgress({ phase, message, elapsedMs }): "start", "load", "read", "convert", "build", "done"
//   name: the model's GLB file name (default: derived from the file name)
export async function importStep(file, options = {}) {
  const sourceName = options.sourceName || (file && file.name) || "model.step";
  const raw = await readStepRaw(file, { ...options, name: sourceName });
  raw.source = { name: sourceName, bytes: (file && (file.size !== undefined ? file.size : file.byteLength)) || 0 };
  return modelFromRaw(raw, options);
}

// The Model for a readStepRaw result, with the import's stats. It can run
// again on the same result with other mergeBodies / minSize options without
// reading the file again (the tessellation options need a new read).
export function modelFromRaw(raw, options = {}) {
  const source = raw.source || { name: options.sourceName || "model.step", bytes: 0 };
  const t = performance.now();
  if (options.onProgress) options.onProgress({ phase: "build", message: "Building parts…", elapsedMs: 0 });
  const model = buildModel(raw.result, {
    name: options.name || glbNameFor(source.name),
    mergeBodies: options.mergeBodies,
    minSize: options.minSize,
    up: options.up,
    generator: options.generator,
  });
  if (!model.nodes.length) {
    throw new StepImportError(
      model.stats.counts.bodies > model.stats.counts.emptyBodies
        ? `${source.name} has no bodies of ${options.minSize} mm or larger; lower the size filter`
        : `${source.name} has no solids or surfaces to show`,
      { kind: "empty" });
  }
  model.stats.source = { ...source, kind: "step" };
  model.stats.options = {
    ...occtParams(options),
    minSize: options.minSize > 0 ? options.minSize : 0,
    mergeBodies: typeof options.mergeBodies === "function" ? "custom" : options.mergeBodies !== false,
  };
  model.stats.timings = { ...raw.timings, buildMs: performance.now() - t };
  model.stats.heapBytes = raw.heapBytes;
  model.stats.base = raw.base;
  if (options.onProgress) options.onProgress({ phase: "done", message: "Done", elapsedMs: model.stats.timings.buildMs });
  return model;
}

// The occt-import-js tree as an import dialog can show it, without building
// anything: [{ label, src, bodies, triangles, children }] for every node with
// geometry, src matching buildModel's (and mergeBodies' callback argument).
export function rawTree(result) {
  const meshes = (result && result.meshes) || [];
  const walk = (node, src) => {
    const kids = (node.children || []).map((c, k) => walk(c, `${src}/${k}`)).filter(Boolean);
    const own = (node.meshes || []).filter(i => meshes[i]);
    if (!own.length && !kids.length) return null;
    let triangles = 0;
    for (const i of own) triangles += Math.floor(((meshes[i].index && meshes[i].index.array) || []).length / 3);
    for (const k of kids) triangles += k.triangles;
    return { label: node.name || (own.length && meshes[own[0]].name) || "part", src, bodies: own.length, triangles, children: kids };
  };
  const root = (result && result.root) || { children: [] };
  return (root.children || []).map((c, k) => walk(c, String(k))).filter(Boolean);
}

function toFloat32(a) {
  return a instanceof Float32Array ? a : Float32Array.from(a || []);
}

function toUint32(a) {
  return a instanceof Uint32Array ? a : Uint32Array.from(a || []);
}

// One body (an occt-import-js mesh) as a primitive, or null when it has no triangles.
export function bodyPrimitive(mesh) {
  const attrs = mesh.attributes || {};
  const positions = toFloat32(attrs.position && attrs.position.array);
  const indices = toUint32(mesh.index && mesh.index.array);
  if (positions.length < 9 || indices.length < 3) return null;
  let normals = attrs.normal ? toFloat32(attrs.normal.array) : null;
  if (!normals || normals.length !== positions.length) normals = computeNormals(positions, indices);
  let color = DEFAULT_COLOR;
  if (Array.isArray(mesh.color) && mesh.color.length >= 3) {
    // occt-import-js gives linear RGB from 0 to 1 (OCCT converts the STEP's
    // sRGB values); anything above 1 would be a 0-255 color.
    const scale = Math.max(mesh.color[0], mesh.color[1], mesh.color[2]) > 1 ? 1 / 255 : 1;
    color = clampColor([mesh.color[0] * scale, mesh.color[1] * scale, mesh.color[2] * scale, 1]);
  }
  return { positions, normals, indices, color };
}

// The occt-import-js result -> Model. The tree mapping (SPEC 13.2), for each
// node under the result's unnamed root, in document order:
//   - children and no meshes: a group
//   - meshes and no children: a part, its meshes (bodies) its primitives; when
//     the node's bodies are not merged and it has more than one, a group with
//     one part per body, labeled with the body's name, else <label>_body<N>
//     (N counts the node's bodies from 1)
//   - both: a group with a part <label> (or its body parts) for its own
//     meshes first, then its children
//   - neither, and no meshes anywhere below: skipped
// occt-import-js 0.0.23 flattens the tree below the first level of
// components: a sub-assembly inside the top assembly arrives as one node
// whose bodies are all the solids under it, named after their products when
// OCCT finds them. That is why split bodies keep their names.
//
// Labels: the node's name, else its first mesh's name, else "part". Ids come
// from every label in document order before any body is dropped, so a part's
// id does not depend on the quality or the size filter. Then bodies with no
// triangles or a bounding-box diagonal under minSize are dropped, then parts
// without bodies, then groups without parts.
//
// mergeBodies is true (one part per node, the default), false (one part per
// body), or a function given { label, src, bodies, names } for each node with
// more than one body that returns whether to merge them.
export function buildModel(result, { name = "model.glb", mergeBodies = true, minSize = 0, units = "mm", up = "z", generator = GENERATOR } = {}) {
  const merges = typeof mergeBodies === "function"
    ? mergeBodies
    : () => mergeBodies !== false;
  minSize = minSize > 0 ? minSize : 0;
  const meshes = (result && result.meshes) || [];
  const root = (result && result.root) || { name: "", meshes: [], children: [] };

  const geometry = new Map();
  const hasGeometry = node => {
    if (!geometry.has(node)) {
      const own = (node.meshes || []).some(i => meshes[i]);
      geometry.set(node, own || (node.children || []).some(hasGeometry));
    }
    return geometry.get(node);
  };

  // { label, parent, bodies: [mesh indices] | null (group), src }
  const entries = [];
  const merged = (label, src, own) =>
    own.length === 1 || !!merges({ label, src, bodies: own.length, names: own.map(i => meshes[i].name || "") });
  const pushBodies = (label, parent, own, src) => {
    own.forEach((m, k) => entries.push({
      label: meshes[m].name || `${label}_body${k + 1}`, parent, bodies: [m], src: `${src}#${k + 1}`,
    }));
  };
  const visit = (node, parent, src) => {
    if (!hasGeometry(node)) return;
    const own = (node.meshes || []).filter(i => meshes[i]);
    const kids = node.children || [];
    const label = node.name || (own.length && meshes[own[0]].name) || "part";
    if (own.length && !kids.some(hasGeometry)) {
      if (merged(label, src, own)) {
        entries.push({ label, parent, bodies: own, src });
      } else {
        entries.push({ label, parent, bodies: null, src });
        pushBodies(label, entries.length - 1, own, src);
      }
      return;
    }
    entries.push({ label, parent, bodies: null, src });
    const self = entries.length - 1;
    if (own.length) {
      if (merged(label, `${src}#own`, own)) entries.push({ label, parent: self, bodies: own, src: `${src}#own` });
      else pushBodies(label, self, own, `${src}#own`);
    }
    kids.forEach((child, k) => visit(child, self, `${src}/${k}`));
  };
  (root.children || []).forEach((child, k) => visit(child, -1, String(k)));
  // occt-import-js never puts meshes on the root itself; treat any as one more part.
  if ((root.meshes || []).length) visit({ name: "", meshes: root.meshes, children: [] }, -1, "root");

  const ids = assignIds(entries.map(e => e.label));

  // Bodies -> primitives, dropping empty and tiny ones.
  let bodies = 0, emptyBodies = 0, droppedBodies = 0;
  const prims = entries.map(e => {
    if (!e.bodies) return null;
    const kept = [];
    for (const i of e.bodies) {
      bodies++;
      const prim = bodyPrimitive(meshes[i]);
      if (!prim) {
        emptyBodies++;
        continue;
      }
      if (minSize && bboxDiagonal(primitiveBBox(prim)) < minSize) {
        droppedBodies++;
        continue;
      }
      kept.push(prim);
    }
    return kept;
  });

  // Keep parts with bodies and groups with kept parts; children come after
  // their parents, so one pass from the end settles every group.
  const alive = entries.map((e, k) => (e.bodies ? prims[k].length > 0 : false));
  for (let k = entries.length - 1; k >= 0; k--) {
    if (alive[k] && entries[k].parent >= 0) alive[entries[k].parent] = true;
  }

  const model = createModel({ name, units, up, generator });
  const remap = new Map();
  entries.forEach((e, k) => {
    if (!alive[k]) return;
    const index = model.nodes.length;
    remap.set(k, index);
    const parent = e.parent >= 0 ? remap.get(e.parent) : -1;
    const node = { id: ids[k], label: e.label, parent, children: [], mesh: -1, src: e.src };
    if (e.bodies) {
      node.mesh = model.meshes.length;
      model.meshes.push(makeMesh(mergePrimitives(prims[k])));
    }
    model.nodes.push(node);
    if (parent >= 0) model.nodes[parent].children.push(index);
  });

  let triangles = 0, vertices = 0;
  for (const mesh of model.meshes) {
    triangles += mesh.triangles;
    for (const p of mesh.primitives) vertices += p.positions.length / 3;
  }
  model.stats = {
    counts: {
      bodies,
      emptyBodies,
      droppedBodies,
      parts: model.meshes.length,
      groups: model.nodes.length - model.meshes.length,
      triangles,
      vertices,
    },
  };
  return model;
}
