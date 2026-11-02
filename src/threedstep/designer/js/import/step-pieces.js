// Reading a STEP file in pieces. occt-import-js's WebAssembly heap stops at
// 2 GB, which a STEP file of about 45 MB fills while reading. A bigger file
// is cut here into pieces that each keep the whole assembly structure (every
// product, component, placement, name and color) but only some of the
// geometry: every geometric item (a solid, a surface model, a wireframe) is
// held by one piece. Each piece is read by a fresh reader, and
// mergePieceResults puts the bodies back together.
//
// In the other pieces a solid is hollowed out (its shell replaced by an
// empty one), so every piece gives every body, in the order and with the
// names of a whole read, and only the piece holding a solid gives it
// triangles. Other items are taken out. Either way the representation gets a
// proxy: the eight corners of the box of what it lost, as a
// GEOMETRIC_CURVE_SET of points, which gives no meshes but keeps the box
// occt-import-js takes its deflection from (a share of the box of each
// top-level shape), so a piece is meshed about as finely as the whole file
// (OCCT's own box is a little looser than the geometry; ToqueCAN.step gets
// up to 4% more triangles in a piece).
//
// Pure: works on the file's bytes, in a worker or in Node.

const HASH = 35, EQ = 61, LP = 40, RP = 41, SEMI = 59, QUOTE = 39, DQUOTE = 34, SLASH = 47, STAR = 42, COMMA = 44, DOT = 46;

const isDigit = c => c >= 48 && c <= 57;
const isIdentStart = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdent = c => isIdentStart(c) || isDigit(c);

function ascii(bytes, start, end) {
  let s = "";
  for (let k = start; k < end; k += 8192) s += String.fromCharCode.apply(null, bytes.subarray(k, Math.min(end, k + 8192)));
  return s;
}

function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let k = 0; k < text.length; k++) out[k] = text.charCodeAt(k);
  return out;
}

// A typed array that grows as it is pushed to.
class Grow {
  constructor(Type, size) {
    this.Type = Type;
    this.a = new Type(Math.max(16, size));
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

export class StepPiecesError extends Error {
  constructor(message) {
    super(message);
    this.name = "StepPiecesError";
  }
}

// The entity index of a Part 21 file: one entry per record of its DATA
// section, with the records it references. A reference is direct when it is
// an attribute of its own and not inside an aggregate (a list or set).
//   { bytes, dataStart, dataEnd, count, ids, start, end, type, typeNames,
//     refStart, refs, refDirect, indexOf(id) }
export function indexStep(bytes) {
  const n = bytes.length;
  let p = 0;
  const fail = message => {
    throw new StepPiecesError(`${message} (byte ${p})`);
  };
  const skipString = () => {
    p++;
    while (p < n) {
      if (bytes[p] === QUOTE) {
        if (bytes[p + 1] === QUOTE) {
          p += 2;
          continue;
        }
        p++;
        return;
      }
      p++;
    }
    fail("unterminated string");
  };
  const skipBinary = () => {
    p++;
    while (p < n && bytes[p] !== DQUOTE) p++;
    p++;
  };
  const skipComment = () => {
    p += 2;
    while (p < n - 1 && !(bytes[p] === STAR && bytes[p + 1] === SLASH)) p++;
    p += 2;
  };
  const skipBlank = () => {
    while (p < n) {
      const c = bytes[p];
      if (c <= 32) p++;
      else if (c === SLASH && bytes[p + 1] === STAR) skipComment();
      else break;
    }
  };
  const readIdent = () => {
    const s = p;
    while (p < n && isIdent(bytes[p])) p++;
    return ascii(bytes, s, p);
  };
  const skipParens = () => {
    let depth = 0;
    while (p < n) {
      const c = bytes[p];
      if (c === QUOTE) skipString();
      else if (c === DQUOTE) skipBinary();
      else if (c === SLASH && bytes[p + 1] === STAR) skipComment();
      else {
        p++;
        if (c === LP) depth++;
        else if (c === RP && --depth === 0) return;
      }
    }
  };

  // The header, up to "DATA;" (or "DATA(...);", a named section).
  let dataStart = -1;
  while (p < n && dataStart < 0) {
    const c = bytes[p];
    if (c === QUOTE) skipString();
    else if (c === DQUOTE) skipBinary();
    else if (c === SLASH && bytes[p + 1] === STAR) skipComment();
    else if (isIdentStart(c)) {
      if (readIdent() === "DATA") {
        skipBlank();
        if (bytes[p] === LP) {
          skipParens();
          skipBlank();
        }
        if (bytes[p] === SEMI) dataStart = ++p;
      }
    } else p++;
  }
  if (dataStart < 0) fail("no DATA section");

  const estimate = Math.ceil(n / 40);
  const ids = new Grow(Float64Array, estimate);
  const start = new Grow(Uint32Array, estimate);
  const end = new Grow(Uint32Array, estimate);
  const type = new Grow(Int32Array, estimate);
  const refStart = new Grow(Uint32Array, estimate + 1);
  const refIds = new Grow(Float64Array, estimate * 3);
  const refDepth = new Grow(Uint8Array, estimate * 3);
  const typeNames = [];
  const typeMap = new Map();
  const intern = name => {
    let t = typeMap.get(name);
    if (t === undefined) {
      t = typeNames.length;
      typeNames.push(name);
      typeMap.set(name, t);
    }
    return t;
  };

  let dataEnd = -1;
  for (;;) {
    skipBlank();
    if (p >= n) fail("no ENDSEC after the DATA section");
    const c = bytes[p];
    if (c === HASH) {
      const s = p++;
      let id = 0;
      while (p < n && isDigit(bytes[p])) id = id * 10 + bytes[p++] - 48;
      skipBlank();
      if (bytes[p] !== EQ) fail("a record without =");
      p++;
      skipBlank();
      const complex = bytes[p] === LP;
      const name = complex ? null : readIdent();
      if (!complex && !name) fail("a record without a type");
      const partials = complex ? [] : null;
      refStart.push(refIds.n);
      let depth = 0;
      for (;;) {
        if (p >= n) fail("an unterminated record");
        const ch = bytes[p];
        if (ch === QUOTE) skipString();
        else if (ch === LP) {
          depth++;
          p++;
        } else if (ch === RP) {
          depth--;
          p++;
        } else if (ch === HASH) {
          p++;
          let r = 0;
          while (p < n && isDigit(bytes[p])) r = r * 10 + bytes[p++] - 48;
          refIds.push(r);
          refDepth.push(Math.min(depth, 255));
        } else if (ch === SEMI && depth === 0) {
          p++;
          break;
        } else if (ch === DQUOTE) skipBinary();
        else if (ch === SLASH && bytes[p + 1] === STAR) skipComment();
        else if (complex && depth === 1 && isIdentStart(ch)) partials.push(readIdent());
        else p++;
      }
      ids.push(id);
      start.push(s);
      end.push(p);
      type.push(intern(complex ? `(${partials.join(" ")})` : name));
    } else if (isIdentStart(c)) {
      const s = p;
      if (readIdent() !== "ENDSEC") fail("unexpected text in the DATA section");
      dataEnd = s;
      skipBlank();
      if (bytes[p] === SEMI) p++;
      break;
    } else fail("unexpected text in the DATA section");
  }
  // A second DATA section (AP242 ed2 allows several) is not supported.
  let more = false;
  while (p < n && !more) {
    const c = bytes[p];
    if (c === QUOTE) skipString();
    else if (c === SLASH && bytes[p + 1] === STAR) skipComment();
    else if (isIdentStart(c)) more = readIdent() === "DATA";
    else p++;
  }

  const count = ids.n;
  refStart.push(refIds.n);
  const idArr = ids.done();
  let maxId = 0;
  for (let i = 0; i < count; i++) if (idArr[i] > maxId) maxId = idArr[i];
  let indexOf;
  if (maxId <= count * 8 + 1024) {
    const map = new Int32Array(maxId + 1).fill(-1);
    for (let i = 0; i < count; i++) {
      if (map[idArr[i]] >= 0) throw new StepPiecesError(`entity #${idArr[i]} is defined twice`);
      map[idArr[i]] = i;
    }
    indexOf = id => (id <= maxId ? map[id] : -1);
  } else {
    const map = new Map();
    for (let i = 0; i < count; i++) {
      if (map.has(idArr[i])) throw new StepPiecesError(`entity #${idArr[i]} is defined twice`);
      map.set(idArr[i], i);
    }
    indexOf = id => {
      const i = map.get(id);
      return i === undefined ? -1 : i;
    };
  }
  const typeArr = type.done();
  const rs = refStart.done();
  const rawRefs = refIds.a, rawDepth = refDepth.a;
  const refs = new Int32Array(refIds.n);
  const refDirect = new Uint8Array(refIds.n);
  for (let i = 0; i < count; i++) {
    const direct = typeNames[typeArr[i]].charCodeAt(0) === LP ? 2 : 1;
    for (let k = rs[i]; k < rs[i + 1]; k++) {
      refs[k] = indexOf(rawRefs[k]);
      refDirect[k] = rawDepth[k] === direct ? 1 : 0;
    }
  }
  return {
    bytes, dataStart, dataEnd, more, count, maxId,
    ids: idArr, start: start.done(), end: end.done(), type: typeArr, typeNames,
    refStart: rs, refs, refDirect, indexOf,
  };
}

// The entities referencing each entity (CSR), with the direct flag.
function referencers(ix) {
  const { count, refStart, refs, refDirect } = ix;
  const inStart = new Uint32Array(count + 1);
  for (let k = 0; k < refs.length; k++) if (refs[k] >= 0) inStart[refs[k] + 1]++;
  for (let i = 0; i < count; i++) inStart[i + 1] += inStart[i];
  const fill = inStart.slice(0, count);
  const inRefs = new Int32Array(inStart[count]);
  const inDirect = new Uint8Array(inStart[count]);
  for (let i = 0; i < count; i++) {
    for (let k = refStart[i]; k < refStart[i + 1]; k++) {
      const t = refs[k];
      if (t < 0) continue;
      inRefs[fill[t]] = i;
      inDirect[fill[t]++] = refDirect[k];
    }
  }
  return { inStart, inRefs, inDirect };
}

// --- One record's arguments ------------------------------------------------
// Values: arrays for aggregates, { r: index, id } for references,
// { t: [start, end], a: [...] } for typed parameters, { s: start, e: end }
// for anything else (strings, numbers, enumerations, $ and *), as bytes.

export function parseRecord(ix, i) {
  const b = ix.bytes;
  let p = ix.start[i];
  const n = ix.end[i];
  const blank = () => {
    while (p < n) {
      const c = b[p];
      if (c <= 32) p++;
      else if (c === SLASH && b[p + 1] === STAR) {
        p += 2;
        while (p < n - 1 && !(b[p] === STAR && b[p + 1] === SLASH)) p++;
        p += 2;
      } else break;
    }
  };
  const ident = () => {
    const s = p;
    while (p < n && isIdent(b[p])) p++;
    return [s, p];
  };
  const value = () => {
    const c = b[p];
    if (c === LP) return list();
    if (c === HASH) {
      p++;
      let id = 0;
      while (p < n && isDigit(b[p])) id = id * 10 + b[p++] - 48;
      return { r: ix.indexOf(id), id };
    }
    const s = p;
    if (c === QUOTE) {
      p++;
      while (p < n) {
        if (b[p] === QUOTE) {
          if (b[p + 1] === QUOTE) p += 2;
          else break;
        } else p++;
      }
      p++;
      return { s, e: p };
    }
    if (c === DQUOTE) {
      p++;
      while (p < n && b[p] !== DQUOTE) p++;
      return { s, e: ++p };
    }
    if (c === DOT) {
      p++;
      while (p < n && b[p] !== DOT) p++;
      return { s, e: ++p };
    }
    if (isIdentStart(c)) {
      const t = ident();
      blank();
      return { t, a: list() };
    }
    while (p < n && b[p] !== COMMA && b[p] !== RP && b[p] > 32 && b[p] !== SLASH) p++;
    return { s, e: p };
  };
  const list = () => {
    const items = [];
    p++;
    for (;;) {
      blank();
      if (p >= n) throw new StepPiecesError(`entity #${ix.ids[i]} could not be read`);
      if (b[p] === RP) {
        p++;
        return items;
      }
      items.push(value());
      blank();
      if (b[p] === COMMA) p++;
    }
  };
  while (b[p] !== EQ) p++;
  p++;
  blank();
  if (b[p] === LP) {
    p++;
    const partials = [];
    for (;;) {
      blank();
      if (b[p] === RP || p >= n) break;
      const t = ident();
      blank();
      partials.push({ type: ascii(b, t[0], t[1]), args: list() });
    }
    return { partials };
  }
  const t = ident();
  blank();
  return { type: ascii(b, t[0], t[1]), args: list() };
}

// The record as text again (latin1, so bytes the file had come back unchanged).
function writeRecord(ix, id, record) {
  const b = ix.bytes;
  const val = v => {
    if (Array.isArray(v)) return `(${v.map(val).join(",")})`;
    if (v.r !== undefined) return `#${v.id}`;
    if (v.t) return `${ascii(b, v.t[0], v.t[1])}(${v.a.map(val).join(",")})`;
    return ascii(b, v.s, v.e);
  };
  if (record.partials) return `#${id}=(${record.partials.map(q => `${q.type}(${q.args.map(val).join(",")})`).join("")});`;
  return `#${id}=${record.type}(${record.args.map(val).join(",")});`;
}

function argsOf(record, type) {
  if (!record.partials) return record.type === type ? record.args : null;
  const q = record.partials.find(x => x.type === type);
  return q ? q.args : null;
}

const refIndex = v => (v && v.r !== undefined ? v.r : -1);

function realText(v) {
  if (!Number.isFinite(v)) v = 0;
  if (Object.is(v, -0)) v = 0;
  const s = v.toPrecision(15);
  const [mantissa, exponent] = s.split("e");
  const m = mantissa.includes(".") ? mantissa : `${mantissa}.`;
  return exponent ? `${m}E${exponent.replace("+", "")}` : m;
}

function numberOf(ix, v) {
  return v && v.s !== undefined ? Number(ascii(ix.bytes, v.s, v.e)) : NaN;
}

// --- The assembly ----------------------------------------------------------


function isShapeRep(name) {
  if (name.charCodeAt(0) === LP) {
    const parts = name.slice(1, -1).split(" ");
    return parts.includes("REPRESENTATION") && parts.some(isShapeRep);
  }
  return name.endsWith("SHAPE_REPRESENTATION") && name !== "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION";
}

// The items of a representation record (simple, or the REPRESENTATION partial).
function repItems(record) {
  const args = record.partials ? argsOf(record, "REPRESENTATION") : record.args;
  return args && Array.isArray(args[1]) ? args[1] : null;
}

// What a piece that does not hold an item puts in its place. A body must
// stay a body of the same kind, in its place: occt-import-js lists a node's
// solids, then its loose shells (an empty solid is one of those), so a
// solid becomes a marker solid and a surface model's shells marker shells
// (a tiny regular tetrahedron, which mergePieceResults recognizes). Wires
// give no bodies and just go; anything else stays in every piece.
const KEEP = 0, SOLID = 1, SHELLS = 2, WIRES = 3;
const FREE = -1, SHARED = -2, PROTECTED = -3;
const WIRE_ITEMS = new Set(["GEOMETRIC_SET", "GEOMETRIC_CURVE_SET", "EDGE_BASED_WIREFRAME_MODEL", "SHELL_BASED_WIREFRAME_MODEL"]);

function itemKind(name) {
  if (name.charCodeAt(0) === LP) return name.slice(1, -1).split(" ").includes("MANIFOLD_SOLID_BREP") ? SOLID : KEEP;
  if (name === "MANIFOLD_SOLID_BREP" || name === "BREP_WITH_VOIDS" || name === "FACETED_BREP") return SOLID;
  if (name === "SHELL_BASED_SURFACE_MODEL") return SHELLS;
  return WIRE_ITEMS.has(name) ? WIRES : KEEP;
}

// The geometry a piece can leave out: the solids, surface models and wires
// of every shape representation, with the bytes of the records only each
// reaches, and the product it belongs to (for packing a product's items
// together, and for messages).
//   { items: [entity], itemIndex, itemBytes, itemPd, kind, owner (per
//     record: the item whose geometry it is, or SHARED, PROTECTED or FREE),
//     reps: Map(rep -> [item entities]), geometryBytes }
export function analyzeStep(ix) {
  const { count, type, typeNames, refStart, refs } = ix;
  const typeOf = i => typeNames[type[i]];
  const parse = i => parseRecord(ix, i);

  const sdrs = [], srr = new Map(), maps = new Map(), reps = new Map(), nauoChild = new Map(), pds = new Set();
  const push = (map, k, v) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  };
  for (let i = 0; i < count; i++) {
    const name = typeOf(i);
    if (name === "NEXT_ASSEMBLY_USAGE_OCCURRENCE") {
      const args = parse(i).args;
      const parent = refIndex(args[3]), child = refIndex(args[4]);
      if (parent < 0 || child < 0) continue;
      nauoChild.set(i, child);
      pds.add(parent);
      pds.add(child);
    } else if (name === "SHAPE_DEFINITION_REPRESENTATION") {
      const args = parse(i).args;
      const def = refIndex(args[0]), rep = refIndex(args[1]);
      if (def >= 0 && rep >= 0) sdrs.push([def, rep]);
    } else if (name === "SHAPE_REPRESENTATION_RELATIONSHIP" || name === "REPRESENTATION_RELATIONSHIP") {
      const args = parse(i).args;
      const a = refIndex(args[2]), b = refIndex(args[3]);
      if (a >= 0 && b >= 0) {
        push(srr, a, b);
        push(srr, b, a);
      }
    } else if (name === "MAPPED_ITEM") {
      const source = refIndex(parse(i).args[1]);
      if (source >= 0) maps.set(i, source);
    } else if (name === "REPRESENTATION_MAP") {
      const rep = refIndex(parse(i).args[1]);
      if (rep >= 0) maps.set(i, rep);
    } else if (isShapeRep(name)) {
      reps.set(i, null);
    }
  }
  for (const rep of reps.keys()) reps.set(rep, (repItems(parse(rep)) || []).map(refIndex).filter(x => x >= 0));

  // The product definition a shape definition describes: a product
  // definition shape of it, or of a shape aspect of one (a property
  // definition of a shape aspect, as some exporters attach their solids),
  // each the first direct reference of the last. A shape of a component
  // (of a NAUO) belongs to the component's product.
  const isPd = e => {
    const name = typeOf(e);
    return name === "PRODUCT_DEFINITION" || name === "PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS" ||
      (name.charCodeAt(0) === LP && name.slice(1, -1).split(" ").includes("PRODUCT_DEFINITION"));
  };
  const firstDirect = e => {
    for (let k = refStart[e]; k < refStart[e + 1]; k++) if (ix.refDirect[k]) return refs[k];
    return -1;
  };
  const pdOf = def => {
    let e = def;
    for (let depth = 0; depth < 8 && e >= 0; depth++) {
      if (nauoChild.has(e)) return nauoChild.get(e);
      if (pds.has(e) || isPd(e)) return e;
      e = firstDirect(e);
    }
    return -1;
  };
  // A representation's product: through its shape definition, else through
  // a representation it is related to, or one that maps it.
  const repPd = new Map();
  for (const [def, rep] of sdrs) {
    const pd = pdOf(def);
    if (pd >= 0 && reps.has(rep) && !repPd.has(rep)) repPd.set(rep, pd);
  }
  const mappedBy = new Map();
  for (const [rep, items] of reps) {
    for (const item of items) {
      const source = maps.get(item);
      if (source !== undefined && maps.has(source)) push(mappedBy, maps.get(source), rep);
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const rep of reps.keys()) {
      if (repPd.has(rep)) continue;
      const via = [...(srr.get(rep) || []), ...(mappedBy.get(rep) || [])].find(o => repPd.has(o));
      if (via !== undefined) {
        repPd.set(rep, repPd.get(via));
        changed = true;
      }
    }
  }

  // Removable items, in record order.
  const itemOf = new Map();
  for (const [rep, list] of reps) {
    for (const item of list) {
      if (itemKind(typeOf(item)) === KEEP || itemOf.has(item)) continue;
      itemOf.set(item, repPd.has(rep) ? repPd.get(rep) : -1);
    }
  }
  const items = [...itemOf.keys()].sort((a, b) => a - b);
  const itemIndex = new Map(items.map((e, k) => [e, k]));
  const itemPd = Int32Array.from(items, e => itemOf.get(e));
  const kind = Uint8Array.from(items, e => itemKind(typeOf(e)));

  // owner[e]: the item whose geometry alone reaches e, SHARED when two items
  // reach it, PROTECTED when what is always kept (a placement, a mapped
  // item, an item of another kind) does, FREE otherwise. A mapped item
  // reaches another representation, whose items have owners of their own:
  // walks stop at representations.
  const owner = new Int32Array(count).fill(FREE);
  const stack = [];
  for (const list of reps.values()) {
    for (const item of list) {
      if (itemIndex.has(item)) continue;
      stack.push(item);
      while (stack.length) {
        const e = stack.pop();
        if (owner[e] === PROTECTED || reps.has(e)) continue;
        owner[e] = PROTECTED;
        for (let k = refStart[e]; k < refStart[e + 1]; k++) if (refs[k] >= 0 && owner[refs[k]] !== PROTECTED) stack.push(refs[k]);
      }
    }
  }
  items.forEach((item, g) => {
    stack.push(item);
    while (stack.length) {
      const e = stack.pop();
      const o = owner[e];
      if (o === PROTECTED || o === SHARED || o === g || reps.has(e)) continue;
      owner[e] = o === FREE ? g : SHARED;
      for (let k = refStart[e]; k < refStart[e + 1]; k++) if (refs[k] >= 0) stack.push(refs[k]);
    }
  });
  const itemBytes = new Float64Array(items.length);
  let geometryBytes = 0;
  for (let i = 0; i < count; i++) {
    if (owner[i] >= 0) {
      const size = ix.end[i] - ix.start[i];
      itemBytes[owner[i]] += size;
      geometryBytes += size;
    }
  }
  return { items, itemIndex, itemBytes, itemPd, kind, owner, reps, geometryBytes };
}


// The name of a product definition's product (PRODUCT_DEFINITION -> its
// formation -> the PRODUCT's name), for messages; "" when it has none.
export function productName(ix, pd) {
  try {
    const formation = refIndex(parseRecord(ix, pd).args[2]);
    const product = refIndex(parseRecord(ix, formation).args[2]);
    const v = parseRecord(ix, product).args[1];
    return ascii(ix.bytes, v.s + 1, v.e - 1).replace(/''/g, "'");
  } catch {
    return "";
  }
}

// Pieces for a budget of geometry bytes each, every item in one piece. A
// product's items go together (largest products first, each into the first
// piece with room); a product bigger than the budget is packed item by item.
// Returns [{ items: [item indices], bytes, pds: [product definitions] }].
export function planPieces(an, budget) {
  const bundles = new Map();
  an.items.forEach((_, k) => {
    const key = an.itemPd[k] >= 0 ? an.itemPd[k] : `item${k}`;
    if (!bundles.has(key)) bundles.set(key, { pd: an.itemPd[k], items: [], bytes: 0 });
    const b = bundles.get(key);
    b.items.push(k);
    b.bytes += an.itemBytes[k];
  });
  const units = [];
  for (const b of bundles.values()) {
    if (b.bytes <= budget) units.push(b);
    else for (const k of b.items) units.push({ pd: b.pd, items: [k], bytes: an.itemBytes[k] });
  }
  units.sort((a, b) => b.bytes - a.bytes || a.items[0] - b.items[0]);
  const pieces = [];
  for (const unit of units) {
    let piece = pieces.find(p => p.bytes + unit.bytes <= budget);
    if (!piece) {
      piece = { items: [], bytes: 0, pds: new Set() };
      pieces.push(piece);
    }
    piece.items.push(...unit.items);
    piece.bytes += unit.bytes;
    if (unit.pd >= 0) piece.pds.add(unit.pd);
  }
  return pieces.map(p => ({ items: p.items.sort((a, b) => a - b), bytes: p.bytes, pds: [...p.pds].sort((a, b) => a - b) }));
}

// The box of an item's geometry in its representation's coordinates: its
// vertices, the control points of its B-splines and the arcs of circles and
// ellipses its edges run along. Close to the box OCCT takes the deflection
// from.
function itemBox(ix, item, box) {
  const { refStart, refs, type, typeNames } = ix;
  const seen = new Set();
  const stack = [item];
  const point = i => {
    if (i < 0 || typeNames[type[i]] !== "CARTESIAN_POINT") return null;
    const coords = parseRecord(ix, i).args[1];
    if (!Array.isArray(coords) || coords.length !== 3) return null;
    const xyz = coords.map(v => numberOf(ix, v));
    return xyz.every(Number.isFinite) ? xyz : null;
  };
  const add = xyz => {
    for (let a = 0; a < 3; a++) {
      box.min[a] = Math.min(box.min[a], xyz[a]);
      box.max[a] = Math.max(box.max[a], xyz[a]);
    }
  };
  const direction = i => {
    if (i < 0 || typeNames[type[i]] !== "DIRECTION") return null;
    const v = parseRecord(ix, i).args[1];
    if (!Array.isArray(v) || v.length !== 3) return null;
    const d = v.map(x => numberOf(ix, x));
    const len = Math.hypot(d[0], d[1], d[2]);
    return len > 0 && d.every(Number.isFinite) ? d.map(x => x / len) : null;
  };
  // The box of the arc of a circle or ellipse an edge runs along: its ends
  // and the points where it turns in x, y or z (the whole curve when the
  // edge is closed or its vertices are unknown).
  const TAU = 2 * Math.PI;
  const arcBox = (curve, v1, v2, sense) => {
    const args = parseRecord(ix, curve).args;
    const placement = refIndex(args[1]);
    if (placement < 0 || typeNames[type[placement]] !== "AXIS2_PLACEMENT_3D") return;
    const a = numberOf(ix, args[2]);
    const b = typeNames[type[curve]] === "ELLIPSE" ? numberOf(ix, args[3]) : a;
    const pa = parseRecord(ix, placement).args;
    const c = point(refIndex(pa[1]));
    if (!c || !(a > 0) || !(b > 0)) return;
    const z = direction(refIndex(pa[2])) || [0, 0, 1];
    let x = direction(refIndex(pa[3])) || (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    const dot = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = [x[0] - dot * z[0], x[1] - dot * z[1], x[2] - dot * z[2]];
    const len = Math.hypot(x[0], x[1], x[2]);
    if (!(len > 1e-12)) return;
    x = x.map(v => v / len);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const at = t => [0, 1, 2].map(k => c[k] + a * Math.cos(t) * x[k] + b * Math.sin(t) * y[k]);
    const angle = p => {
      const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      return Math.atan2((d[0] * y[0] + d[1] * y[1] + d[2] * y[2]) / b, (d[0] * x[0] + d[1] * x[1] + d[2] * x[2]) / a);
    };
    const mod = t => ((t % TAU) + TAU) % TAU;
    let from = 0, span = TAU;
    if (v1 && v2) {
      const [p, q] = sense ? [v1, v2] : [v2, v1];
      from = angle(p);
      span = mod(angle(q) - from);
      if (span < 1e-9) span = TAU;
      add(p);
      add(q);
    }
    for (let k = 0; k < 3; k++) {
      const phi = Math.atan2(b * y[k], a * x[k]);
      for (const t of [phi, phi + Math.PI]) if (mod(t - from) <= span) add(at(t));
    }
  };
  while (stack.length) {
    const e = stack.pop();
    if (seen.has(e)) continue;
    seen.add(e);
    const name = typeNames[type[e]];
    if (name === "VERTEX_POINT") {
      const xyz = point(refs[refStart[e]]);
      if (xyz) add(xyz);
    } else if (name.includes("B_SPLINE") || name === "POLYLINE" || name === "TRIMMED_CURVE") {
      for (let k = refStart[e]; k < refStart[e + 1]; k++) {
        const xyz = point(refs[k]);
        if (xyz) add(xyz);
      }
    } else if (name === "EDGE_CURVE") {
      const args = parseRecord(ix, e).args;
      let curve = refIndex(args[3]);
      if (curve >= 0 && (typeNames[type[curve]] === "SURFACE_CURVE" || typeNames[type[curve]] === "SEAM_CURVE")) curve = refs[refStart[curve]];
      const kind = curve >= 0 ? typeNames[type[curve]] : "";
      if (kind === "CIRCLE" || kind === "ELLIPSE") {
        const vertex = v => {
          const i = refIndex(v);
          return i >= 0 && typeNames[type[i]] === "VERTEX_POINT" ? point(refs[refStart[i]]) : null;
        };
        const sense = !(args[4] && args[4].s !== undefined && ascii(ix.bytes, args[4].s, args[4].e).toUpperCase() === ".F.");
        arcBox(curve, vertex(args[1]), vertex(args[2]), sense);
      }
    }
    for (let k = refStart[e]; k < refStart[e + 1]; k++) if (refs[k] >= 0 && !seen.has(refs[k])) stack.push(refs[k]);
  }
  // Geometry with none of those (lines, say): every point it reaches.
  if (box.min[0] > box.max[0]) {
    for (const e of seen) {
      const xyz = point(e);
      if (xyz) add(xyz);
    }
  }
}

const emptyBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

// The bytes of a piece (from planPieces): the whole file, with the solids of
// every item the piece does not hold hollowed out (an empty closed shell),
// its other items taken out, and a proxy for their box in each
// representation they leave, as parts for a Blob (or to concatenate).
export function pieceParts(ix, an, piece, { inverse, boxes = new Map() } = {}) {
  const { count, refStart, refs, start, end, bytes } = ix;
  const keep = new Uint8Array(an.items.length);
  for (const k of piece.items) keep[k] = 1;
  const { inStart, inRefs, inDirect } = inverse || referencers(ix);
  const owner = an.owner;
  const dropped = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (owner[i] >= 0 && !keep[owner[i]]) dropped[i] = 1;
  const hollow = new Set();
  an.items.forEach((e, k) => {
    if (!keep[k] && (an.kind[k] === SOLID || an.kind[k] === SHELLS)) {
      hollow.add(e);
      dropped[e] = 0;
    }
  });

  // Whatever references a dropped record directly goes too; references in
  // aggregates are taken out of them, and a record whose aggregate is left
  // empty goes. Representations and hollowed solids are rewritten instead.
  const dirty = new Set();
  const stack = [];
  const visitReferencers = e => {
    for (let k = inStart[e]; k < inStart[e + 1]; k++) {
      const x = inRefs[k];
      if (dropped[x] || hollow.has(x) || an.reps.has(x)) continue;
      if (inDirect[k]) {
        dropped[x] = 1;
        stack.push(x);
      } else dirty.add(x);
    }
  };
  for (let i = 0; i < count; i++) if (dropped[i]) visitReferencers(i);
  const rewritten = new Map();
  let nextId = ix.maxId + 1;
  const added = [];

  const record = (text) => {
    const id = nextId++;
    added.push(`#${id}=${text};`);
    return id;
  };
  const point = xyz => record(`CARTESIAN_POINT('',(${xyz.map(realText).join(",")}))`);

  // The marker: the four faces of a regular tetrahedron (a solid needs a
  // volume: OCCT makes a flat or empty one a loose shell), at the corner of
  // the box of what a representation lost, its base in the plane of the
  // box's two longest sides. It stays inside the box (which a body would
  // widen) but for a flat box, out of which it rises by at most 1% of the
  // second side.
  const markerFaces = box => {
    let c = [0, 0, 0], s = 1, axes = [0, 1, 2];
    if (box.min[0] <= box.max[0]) {
      const ext = [0, 1, 2].map(a => box.max[a] - box.min[a]);
      axes.sort((a, b) => ext[b] - ext[a]);
      c = box.min;
      const side = 0.25 * Math.max(ext[axes[2]], 0.04 * ext[axes[1]]);
      if (side > 0) s = side;
      else if (ext[axes[0]] > 0) s = 0.01 * ext[axes[0]];
    }
    const at = (u, v, w) => {
      const p = c.slice();
      p[axes[0]] += s * u;
      p[axes[1]] += s * v;
      p[axes[2]] += s * w;
      return p;
    };
    const v = [at(0, 0, 0), at(1, 0, 0), at(0.5, Math.sqrt(3) / 2, 0), at(0.5, Math.sqrt(3) / 6, Math.sqrt(2 / 3))];
    const ids = v.map(point);
    const unit = x => {
      const len = Math.hypot(x[0], x[1], x[2]);
      return x.map(q => q / len);
    };
    return [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]].map(([a, b, d]) => {
      const u = [0, 1, 2].map(k => v[b][k] - v[a][k]), w = [0, 1, 2].map(k => v[d][k] - v[a][k]);
      const n = unit([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
      const normal = record(`DIRECTION('',(${n.map(realText).join(",")}))`);
      const ref = record(`DIRECTION('',(${unit(u).map(realText).join(",")}))`);
      const plane = record(`PLANE('',#${record(`AXIS2_PLACEMENT_3D('',#${ids[a]},#${normal},#${ref})`)})`);
      const loop = record(`POLY_LOOP('',(#${ids[a]},#${ids[b]},#${ids[d]}))`);
      return record(`FACE_SURFACE('',(#${record(`FACE_OUTER_BOUND('',#${loop},.T.)`)}),#${plane},.T.)`);
    });
  };
  const nameOf = rec => {
    const args = rec.partials ? argsOf(rec, "REPRESENTATION_ITEM") : rec.args;
    return args && args[0] && args[0].s !== undefined ? ascii(ix.bytes, args[0].s, args[0].e) : "''";
  };

  // A representation keeps its items but the wires taken out, its hollowed
  // solids and surface models now made of marker faces, plus the proxy: the
  // eight corners of the box of what it lost, as a set of points.
  for (const [rep, list] of an.reps) {
    if (!list.some(item => an.itemIndex.has(item) && !keep[an.itemIndex.get(item)])) continue;
    const rec = parseRecord(ix, rep);
    const items = repItems(rec);
    const box = emptyBox();
    const kept = [];
    const hollowed = [];
    for (const v of items) {
      const item = refIndex(v);
      const k = item >= 0 ? an.itemIndex.get(item) : undefined;
      if (k !== undefined && !keep[k]) {
        if (!boxes.has(item)) {
          const b = emptyBox();
          itemBox(ix, item, b);
          boxes.set(item, b);
        }
        const b = boxes.get(item);
        for (let a = 0; a < 3; a++) {
          box.min[a] = Math.min(box.min[a], b.min[a]);
          box.max[a] = Math.max(box.max[a], b.max[a]);
        }
        if (hollow.has(item)) {
          kept.push(v);
          if (!rewritten.has(item)) hollowed.push(item);
        }
      } else kept.push(v);
    }
    if (hollowed.length) {
      const faces = markerFaces(box).map(f => `#${f}`).join(",");
      let closed = -1;
      for (const item of hollowed) {
        const r = parseRecord(ix, item);
        if (an.kind[an.itemIndex.get(item)] === SOLID) {
          if (closed < 0) closed = record(`CLOSED_SHELL('',(${faces}))`);
          rewritten.set(item, `#${ix.ids[item]}=MANIFOLD_SOLID_BREP(${nameOf(r)},#${closed});`);
        } else {
          const shells = (Array.isArray(r.args && r.args[1]) ? r.args[1] : []).map(() => `#${record(`OPEN_SHELL('',(${faces}))`)}`);
          rewritten.set(item, `#${ix.ids[item]}=SHELL_BASED_SURFACE_MODEL(${nameOf(r)},(${shells.join(",")}));`);
        }
      }
    }
    if (box.min[0] <= box.max[0]) {
      const corners = [];
      for (let c = 0; c < 8; c++) corners.push(`#${point([0, 1, 2].map(a => ((c >> a) & 1 ? box.max[a] : box.min[a])))}`);
      kept.push({ r: -1, id: record(`GEOMETRIC_CURVE_SET('',(${corners.join(",")}))`) });
    }
    items.length = 0;
    items.push(...kept);
    rewritten.set(rep, writeRecord(ix, ix.ids[rep], rec));
  }

  for (;;) {
    while (stack.length) visitReferencers(stack.pop());
    const pending = [...dirty].filter(x => !dropped[x] && !rewritten.has(x));
    dirty.clear();
    if (!pending.length) break;
    for (const x of pending) {
      const rec = parseRecord(ix, x);
      let emptied = false;
      const filter = list => {
        let had = false;
        for (let k = list.length - 1; k >= 0; k--) {
          const v = list[k];
          if (Array.isArray(v)) filter(v);
          else if (v.r !== undefined && v.r >= 0 && dropped[v.r]) {
            list.splice(k, 1);
            had = true;
          } else if (v.t) filter(v.a);
        }
        if (had && !list.length) emptied = true;
      };
      for (const args of rec.partials ? rec.partials.map(q => q.args) : [rec.args]) {
        for (const v of args) if (Array.isArray(v)) filter(v);
      }
      if (emptied) {
        dropped[x] = 1;
        stack.push(x);
      } else rewritten.set(x, writeRecord(ix, ix.ids[x], rec));
    }
  }

  // What is still reachable from the records nothing referenced.
  const live = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (inStart[i] !== inStart[i + 1] || dropped[i]) continue;
    stack.push(i);
    while (stack.length) {
      const e = stack.pop();
      if (live[e]) continue;
      live[e] = 1;
      for (let k = refStart[e]; k < refStart[e + 1]; k++) {
        const t = refs[k];
        if (t >= 0 && !live[t] && !dropped[t]) stack.push(t);
      }
    }
  }

  const parts = [bytes.subarray(0, ix.dataStart), asciiBytes("\n")];
  let runStart = -1, runEnd = -1, records = 0;
  const flush = () => {
    if (runStart >= 0) parts.push(bytes.subarray(runStart, runEnd), asciiBytes("\n"));
    runStart = -1;
  };
  for (let i = 0; i < count; i++) {
    if (!live[i]) {
      flush();
      continue;
    }
    records++;
    if (rewritten.has(i)) {
      flush();
      parts.push(asciiBytes(rewritten.get(i) + "\n"));
    } else if (runStart >= 0) {
      runEnd = end[i];
    } else {
      runStart = start[i];
      runEnd = end[i];
    }
  }
  flush();
  if (added.length) parts.push(asciiBytes(added.join("\n") + "\n"));
  parts.push(asciiBytes("ENDSEC;\nEND-ISO-10303-21;\n"));
  let size = 0;
  for (const part of parts) size += part.length;
  return { parts, bytes: size, records, added: added.length, hollowed: hollow.size };
}

export function concatParts(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

// Plans the pieces of a STEP file for a budget of geometry bytes per piece.
// Returns null when the file needs no cutting or cannot be cut, else
// { index, analysis, pieces, piece(k) -> { parts, bytes } }; pieces can be
// planned again (planPieces(analysis, budget)) and piece(k) writes from it.
export function splitStep(bytes, { budget = 16 * 1024 * 1024 } = {}) {
  const ix = indexStep(bytes);
  if (ix.more) return null;
  const an = analyzeStep(ix);
  if (an.geometryBytes <= budget) return null;
  const pieces = planPieces(an, budget);
  if (pieces.length < 2) return null;
  let inverse = null;
  const boxes = new Map();
  const split = {
    index: ix,
    analysis: an,
    pieces,
    piece(k) {
      inverse = inverse || referencers(ix);
      return pieceParts(ix, an, split.pieces[k], { inverse, boxes });
    },
  };
  return split;
}

const triangles = (result, i) => {
  const mesh = result.meshes[i];
  return mesh && mesh.index && mesh.index.array ? mesh.index.array.length / 3 : 0;
};

// A marker body: four triangles whose twelve sides are all the same length,
// wherever it was placed and in whatever unit (within the rounding of
// 32-bit coordinates of that size).
export function isMarker(mesh) {
  const index = mesh && mesh.index && mesh.index.array;
  const p = mesh && mesh.attributes && mesh.attributes.position && mesh.attributes.position.array;
  if (!index || index.length !== 12 || !p) return false;
  const sides = [];
  let far = 0;
  for (let t = 0; t < 12; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k] * 3, b = index[t + (k + 1) % 3] * 3;
      sides.push(Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]));
      far = Math.max(far, Math.abs(p[a]), Math.abs(p[a + 1]), Math.abs(p[a + 2]));
    }
  }
  const mean = sides.reduce((s, x) => s + x, 0) / 12;
  const tolerance = Math.max(1e-3 * mean, 4e-7 * far);
  return mean > tolerance && sides.every(x => Math.abs(x - mean) <= tolerance);
}

// One occt-import-js result from the results of the pieces. Every piece has
// the tree and the bodies of the whole file; each body comes from the first
// piece where it is not a marker and has triangles (else where it is not a
// marker). A node whose bodies differ in number between the pieces (which
// hollowing should never let happen) comes whole from the piece where it
// has the most real bodies.
export function mergePieceResults(results) {
  const meshes = [];
  const walk = (nodes, path) => {
    const first = nodes[0];
    const kids = first.children || [];
    for (const node of nodes) {
      if ((node.name || "") !== (first.name || "") || (node.children || []).length !== kids.length) {
        throw new StepPiecesError(`the pieces read into different trees at ${path || "the root"}`);
      }
    }
    const lists = nodes.map(node => node.meshes || []);
    const own = [];
    const real = (p, i) => !isMarker(results[p].meshes[i]);
    if (lists.every(list => list.length === lists[0].length)) {
      for (let j = 0; j < lists[0].length; j++) {
        let k = lists.findIndex((list, p) => real(p, list[j]) && triangles(results[p], list[j]) > 0);
        if (k < 0) k = lists.findIndex((list, p) => real(p, list[j]));
        if (k < 0) k = 0;
        meshes.push(results[k].meshes[lists[k][j]]);
        own.push(meshes.length - 1);
      }
    } else {
      const score = p => [lists[p].filter(i => real(p, i) && triangles(results[p], i) > 0).length, lists[p].reduce((s, i) => s + triangles(results[p], i), 0)];
      let best = 0;
      for (let p = 1; p < lists.length; p++) {
        const [a, b] = score(p), [c, d] = score(best);
        if (a > c || (a === c && b > d)) best = p;
      }
      for (const i of lists[best]) {
        meshes.push(results[best].meshes[i]);
        own.push(meshes.length - 1);
      }
    }
    return {
      name: first.name,
      meshes: own,
      children: kids.map((_, j) => walk(nodes.map(node => node.children[j]), `${path}/${j}`)),
    };
  };
  return { success: true, root: walk(results.map(r => r.root), ""), meshes };
}
