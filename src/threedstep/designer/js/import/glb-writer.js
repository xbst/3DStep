// Model -> GLB bytes with 3DStep's conventions (SPEC 7), the same ones glb.py's
// writer follows: one node per part named by its id, positions quantized with
// KHR_mesh_quantization (SHORT, the part node translated to the bounding-box
// center and scaled uniformly by the largest half extent), normals as BYTE,
// one material per color, 4-byte aligned buffer views, and the threedstep
// metadata in asset.extras.

import { checkModel, colorKey, makeMesh, GENERATOR } from "./model.js";

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const BYTE = 5120, SHORT = 5122, UNSIGNED_SHORT = 5123, UNSIGNED_INT = 5125;

export const QUANTIZATION = "KHR_mesh_quantization";

function quantize(value, limit) {
  const q = Math.round(value);
  return q > limit ? limit : q < -limit ? -limit : q;
}

function material(key) {
  const rgba = key.split(",").map(Number);
  const digits = (rgba[3] < 1 ? rgba : rgba.slice(0, 3))
    .map(c => Math.round(c * 255).toString(16).padStart(2, "0"))
    .join("");
  return {
    name: `color_${digits}`,
    pbrMetallicRoughness: { baseColorFactor: rgba, metallicFactor: 0, roughnessFactor: 0.8 },
    doubleSided: false,
  };
}

// JSON with the keys of every object sorted, as glb.py writes it, so the same
// model gives the same bytes every time.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function writeGlb(model, { generator } = {}) {
  checkModel(model);
  generator = generator || model.generator || GENERATOR;
  const parts = [];
  let binLength = 0;
  const views = [];
  const accessors = [];
  const materials = [];
  const materialIndex = new Map();

  const addView = (bytes, target, stride) => {
    const pad = -binLength & 3;
    if (pad) {
      parts.push(new Uint8Array(pad));
      binLength += pad;
    }
    const view = { buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength, target };
    if (stride) view.byteStride = stride;
    parts.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    binLength += bytes.byteLength;
    views.push(view);
    return views.length - 1;
  };
  const addAccessor = acc => {
    accessors.push(acc);
    return accessors.length - 1;
  };

  const meshNames = new Map();
  for (const node of model.nodes) if (node.mesh >= 0 && !meshNames.has(node.mesh)) meshNames.set(node.mesh, node.id);

  const transforms = [];
  const meshesJson = model.meshes.map((mesh, m) => {
    // From the positions themselves, so a stale mesh.bbox cannot clip them.
    const box = makeMesh(mesh.primitives).bbox;
    const center = [0, 1, 2].map(k => (box.min[k] + box.max[k]) / 2);
    const scale = Math.max(Math.max(...[0, 1, 2].map(k => (box.max[k] - box.min[k]) / 2)), 1e-6);
    transforms.push({ center, scale });
    const factor = 32767 / scale;

    const primitives = mesh.primitives.map(prim => {
      const p = prim.positions;
      const count = p.length / 3;
      // Each vertex padded from 6 to 8 bytes: vertex attributes must be 4-byte aligned.
      const q = new Int16Array(4 * count);
      const lo = [32767, 32767, 32767], hi = [-32767, -32767, -32767];
      for (let v = 0; v < count; v++) {
        for (let k = 0; k < 3; k++) {
          const value = quantize((p[3 * v + k] - center[k]) * factor, 32767);
          q[4 * v + k] = value;
          if (value < lo[k]) lo[k] = value;
          if (value > hi[k]) hi[k] = value;
        }
      }
      const attributes = {
        POSITION: addAccessor({
          bufferView: addView(q, ARRAY_BUFFER, 8),
          componentType: SHORT, normalized: true, count, type: "VEC3", min: lo, max: hi,
        }),
      };

      if (prim.normals) {
        const n = prim.normals;
        const packed = new Int8Array(4 * count);
        for (let v = 0; v < count; v++) {
          const x = n[3 * v], y = n[3 * v + 1], z = n[3 * v + 2];
          const len = Math.sqrt(x * x + y * y + z * z);
          const s = len > 0 && Number.isFinite(len) ? 127 / len : 0;
          packed[4 * v] = quantize(x * s, 127);
          packed[4 * v + 1] = quantize(y * s, 127);
          packed[4 * v + 2] = quantize(z * s, 127);
        }
        attributes.NORMAL = addAccessor({
          bufferView: addView(packed, ARRAY_BUFFER, 4),
          componentType: BYTE, normalized: true, count, type: "VEC3",
        });
      }

      // 65535 is the primitive-restart value of UNSIGNED_SHORT, which an index
      // must never be: up to 65535 vertices means indices up to 65534.
      const wide = count > 65535;
      const indexData = wide ? Uint32Array.from(prim.indices) : Uint16Array.from(prim.indices);
      const indices = addAccessor({
        bufferView: addView(indexData, ELEMENT_ARRAY_BUFFER),
        componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT,
        count: prim.indices.length, type: "SCALAR",
      });

      const key = colorKey(prim.color);
      if (!materialIndex.has(key)) {
        materialIndex.set(key, materials.length);
        materials.push(material(key));
      }
      return { attributes, indices, material: materialIndex.get(key) };
    });
    const out = { primitives };
    if (meshNames.has(m)) out.name = meshNames.get(m);
    return out;
  });

  const nodesJson = model.nodes.map(node => {
    const extras = { label: node.label || "" };
    if (node.src) extras.src = node.src;
    const out = { name: node.id, extras };
    if (node.children.length) out.children = node.children.slice();
    if (node.mesh >= 0) {
      const { center, scale } = transforms[node.mesh];
      out.mesh = node.mesh;
      out.translation = center;
      out.scale = [scale, scale, scale];
    }
    return out;
  });

  const gltf = {
    asset: {
      version: "2.0",
      generator,
      extras: { threedstep: { version: 1, units: model.units || "mm", up: model.up || "z", generator } },
    },
    scene: 0,
    scenes: [{ nodes: model.nodes.map((n, i) => (n.parent === -1 ? i : -1)).filter(i => i >= 0) }],
    nodes: nodesJson,
  };
  if (meshesJson.length) {
    Object.assign(gltf, {
      extensionsUsed: [QUANTIZATION],
      extensionsRequired: [QUANTIZATION],
      meshes: meshesJson,
      materials,
      accessors,
      bufferViews: views,
      buffers: [{ byteLength: binLength }],
    });
  }

  let jsonBytes = new TextEncoder().encode(stableStringify(gltf));
  const jsonPad = -jsonBytes.length & 3;
  const binPad = -binLength & 3;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (binLength ? 8 + binLength + binPad : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  if (binLength) {
    let offset = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(offset, binLength + binPad, true);
    dv.setUint32(offset + 4, CHUNK_BIN, true);
    offset += 8;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
  }
  return out;
}
