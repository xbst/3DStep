// The project as the designer holds it: plain classes mirroring the project
// TOML (SPEC 6), the scene the viewer consumes (SPEC 8), and the checks the
// command line makes when it loads the TOML (config.py), so a mistake typed in
// the TOML tab reads the same way it would from `3dstep`.
//
// Visibility helpers live here too: the registry of the loaded models' ids,
// the folding of the show/hide deltas into the visible parts of each step, and
// the rewriting of those deltas that keeps every step's displayed state when a
// step is edited, added, removed or moved (SPEC 12.2).

import { isValidId, slugify } from "./import/ids.js";

export const STYLES = ["lineart", "shaded"];
export const UP_AXES = ["z", "y"];
export const STARTS = ["visible", "hidden"];
export const PROJECTIONS = ["orthographic", "perspective"];
export const ARROW_KINDS = ["straight", "rotate"];
export const LABEL_SIDES = ["auto", "left", "right", "top", "bottom"];

export const DEFAULT_TITLE = "Untitled assembly";
export const DEFAULT_THEME_DIR = "./themes";

const copy3 = v => (Array.isArray(v) ? v.slice(0, 3) : v);
const list = v => (Array.isArray(v) ? v.slice() : []);

// ── Classes (SPEC 6) ─────────────────────────────────────────────────

// A camera: the home view ([camera]) or a step's own ([step.camera]). A step
// camera states only what it changes: position and target together, or fit;
// fov and projection are null when the step inherits them.
export class CameraSpec {
  constructor({ position = null, target = null, fov = null, projection = null, fit = null } = {}) {
    this.position = position ? copy3(position) : null;
    this.target = target ? copy3(target) : null;
    this.fov = fov ?? null;
    this.projection = projection ?? null;
    this.fit = fit ? fit.slice() : null;
  }
}

export class PartMeta {
  constructor({ id = "", name = "", color = "" } = {}) {
    this.id = id;
    this.name = name;
    this.color = color;
  }
}

export class Move {
  constructor({ parts = [], offset = [0, 0, 0], rotate = [0, 0, 0], arrow = true } = {}) {
    this.parts = list(parts);
    this.offset = copy3(offset);
    this.rotate = copy3(rotate);
    this.arrow = arrow !== false;
  }
}

export class Arrow {
  constructor({ from = [0, 0, 0], to = [0, 0, 1], kind = "straight", turns = 0.75, radius = 4, color = "", label = "", attach = "" } = {}) {
    this.from = copy3(from);
    this.to = copy3(to);
    this.kind = kind;
    this.turns = turns;
    this.radius = radius;
    this.color = color;
    this.label = label;
    this.attach = attach;
  }
}

export class Label {
  constructor({ text = "", at = [0, 0, 0], side = "auto", attach = "" } = {}) {
    this.text = text;
    this.at = copy3(at);
    this.side = side;
    this.attach = attach;
  }
}

// id and title hold what the TOML says: "" when it says nothing, so a step
// written without an id stays without one. stepId() and stepTitle() give the
// defaults the loader applies ("step-N", "Step N").
export class Step {
  constructor({ id = "", title = "", text = "", note = "", show = [], hide = [], highlight = [], ghost = [],
    camera = null, moves = [], arrows = [], labels = [] } = {}) {
    this.id = id;
    this.title = title;
    this.text = text;
    this.note = note;
    this.show = list(show);
    this.hide = list(hide);
    this.highlight = list(highlight);
    this.ghost = list(ghost);
    // A step camera that states nothing means "inherit", which is no camera.
    const states = camera && ["position", "target", "fov", "projection", "fit"].some(k => camera[k] !== null && camera[k] !== undefined);
    this.camera = states ? new CameraSpec(camera) : null;
    this.moves = moves.map(m => new Move(m));
    this.arrows = arrows.map(a => new Arrow(a));
    this.labels = labels.map(l => new Label(l));
  }
}

export class Assembly {
  constructor({ title = DEFAULT_TITLE, description = "", models = [], theme = "default", theme_dir = DEFAULT_THEME_DIR,
    style = "lineart", up = "z", start = "visible", arrow_scale = 1 } = {}) {
    this.title = title;
    this.description = description;
    this.models = list(models);
    this.theme = theme;
    this.theme_dir = theme_dir;
    this.style = style;
    this.up = up;
    this.start = start;
    this.arrow_scale = arrow_scale;   // multiplies every arrow, on top of the theme's
  }
}

export class Project {
  constructor({ assembly = {}, camera = null, parts = [], steps = [] } = {}) {
    this.assembly = new Assembly(assembly);
    // The home view always has a fov and a projection, as the loader fills them in.
    this.camera = camera && camera.position && camera.target
      ? new CameraSpec({ ...camera, fit: null, fov: camera.fov ?? 35, projection: camera.projection || "orthographic" })
      : null;
    this.parts = parts.map(p => new PartMeta(p));
    this.steps = steps.map(s => new Step(s));
  }

  // Plain data with every field, for snapshots and comparisons.
  toData() {
    const d = JSON.parse(JSON.stringify(this));
    if (d.camera) Object.assign(d.camera, { fov: d.camera.fov ?? 35, projection: d.camera.projection || "orthographic", fit: null });
    return d;
  }

  static fromData(data) {
    return new Project(data || {});
  }

  clone() {
    return Project.fromData(this.toData());
  }

  stepId(index) {
    const step = this.steps[index];
    return step && step.id ? step.id : `step-${index + 1}`;
  }

  stepTitle(index) {
    const step = this.steps[index];
    return step && step.title.trim() ? step.title : `Step ${index + 1}`;
  }

  partMeta(id) {
    return this.parts.find(p => p.id === id) || null;
  }

  // The scene the viewer consumes (SPEC 8), as renderer.build_scene makes it
  // from the same TOML: defaults applied, a step camera with only the keys the
  // TOML gives, [[part]] tables only.
  toScene() {
    const a = this.assembly;
    const home = this.camera && this.camera.position && this.camera.target
      ? { position: this.camera.position.slice(), target: this.camera.target.slice(), fov: this.camera.fov ?? 35, projection: this.camera.projection || "orthographic" }
      : null;
    return {
      version: 1,
      title: a.title,
      description: a.description,
      style: a.style,
      up: a.up,
      start: a.start,
      arrow_scale: a.arrow_scale,
      camera: home,
      models: a.models.map(name => ({ name })),
      parts: Object.fromEntries(this.parts.map(p => [p.id, { name: p.name, color: p.color }])),
      steps: this.steps.map((s, i) => ({
        id: this.stepId(i),
        title: this.stepTitle(i),
        text: s.text,
        note: s.note,
        show: s.show.slice(),
        hide: s.hide.slice(),
        highlight: s.highlight.slice(),
        ghost: s.ghost.slice(),
        camera: sceneCamera(s.camera),
        moves: s.moves.map(m => ({ parts: m.parts.slice(), offset: m.offset.slice(), rotate: m.rotate.slice(), arrow: m.arrow })),
        arrows: s.arrows.map(ar => ({
          from: ar.from.slice(), to: ar.to.slice(), kind: ar.kind, turns: ar.turns, radius: ar.radius,
          color: ar.color, label: ar.label, attach: ar.attach,
        })),
        labels: s.labels.map(l => ({ text: l.text, at: l.at.slice(), side: l.side, attach: l.attach })),
      })),
    };
  }
}

// A step camera in the scene: only the keys the TOML gives (renderer._camera).
function sceneCamera(cam) {
  if (!cam) return null;
  const out = {};
  if (cam.position && cam.target) {
    out.position = cam.position.slice();
    out.target = cam.target.slice();
  }
  if (cam.fit && cam.fit.length) out.fit = cam.fit.slice();
  if (cam.fov !== null && cam.fov !== undefined) out.fov = cam.fov;
  if (cam.projection) out.projection = cam.projection;
  return Object.keys(out).length ? out : null;
}

// A step id for what someone typed: the id rule's slug (ids.js), never only
// digits (?step=3 means the third step), unique among the other steps.
export function stepIdFor(text, taken = []) {
  if (!String(text || "").trim()) return "";
  let base = slugify(text);
  if (/^\d+$/.test(base)) base = `step_${base}`;
  const used = new Set(taken);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  return id;
}

// ── Loading (config.py's checks) ─────────────────────────────────────

// A problem that keeps the TOML from loading, with the line it is on.
export class ProjectError extends Error {
  constructor(message, line = 0) {
    super(message);
    this.name = "ProjectError";
    this.line = line;
  }
}

const TOP_KEYS = ["assembly", "camera", "part", "step"];
const ASSEMBLY_KEYS = ["title", "description", "models", "theme", "theme_dir", "style", "up", "start", "arrow_scale"];
const CAMERA_KEYS = ["position", "target", "fov", "projection"];
const STEP_CAMERA_KEYS = ["position", "target", "fov", "projection", "fit"];
const PART_KEYS = ["id", "name", "color"];
const STEP_KEYS = ["id", "title", "text", "note", "show", "hide", "highlight", "ghost", "camera", "move", "arrow", "label"];
const MOVE_KEYS = ["parts", "offset", "rotate", "arrow"];
const ARROW_KEYS = ["from", "to", "kind", "turns", "radius", "color", "label", "attach"];
const LABEL_KEYS = ["text", "at", "side", "attach"];

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ID_HINT = "ids are node names like fan_holder: letters, digits, '_', '.' and '-', not starting with '.' or '-'";

// Tables from the TOML parser are plain objects; a date or time is not.
function isTable(v) {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

function repr(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || v === undefined) return "nothing";
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  if (isTable(v)) return "a table";
  return String(v);
}

// Read a parsed project TOML (plain objects from toml-io's parser) into a
// Project, raising ProjectError with the checks and messages of
// config.load_project. `locate(path)` maps a path such as ["step", 2, "show"]
// to a 1-based line for the message (0 when unknown). Returns {project,
// warnings}.
export function projectFromToml(raw, { locate = () => 0 } = {}) {
  const warnings = [];
  const fail = (path, where, message) => {
    throw new ProjectError(where ? `${where}: ${message}` : message, locate(path) || 0);
  };
  const checkKeys = (table, allowed, path, where) => {
    const unknown = Object.keys(table).filter(k => !allowed.includes(k)).sort();
    if (unknown.length) fail([...path, unknown[0]], where, `unknown key(s): ${unknown.join(", ")} (valid: ${allowed.join(", ")})`);
  };
  const tables = (value, path, where, name) => {
    if (isTable(value)) fail(path, where, `write '[[${name}]]' (an array of tables), not '[${name}]'`);
    if (!Array.isArray(value) || !value.every(isTable)) fail(path, where, `'${name.split(".").pop()}' must be written as [[${name}]] tables`);
    return value;
  };
  const text = (value, path, where, key) => {
    if (typeof value !== "string") fail(path, where, `${key} must be a string (got ${repr(value)})`);
    return value.replace(/\r\n?/g, "\n");
  };
  const getText = (table, key, path, where, def = "") => (key in table ? text(table[key], [...path, key], where, key) : def);
  const enumOf = (table, key, path, where, choices, def) => {
    const value = key in table ? table[key] : def;
    if (typeof value !== "string" || !choices.includes(value)) {
      fail([...path, key], where, `${key} must be one of ${choices.map(c => `'${c}'`).join(", ")} (got ${repr(value)})`);
    }
    return value;
  };
  const number = (value, path, where, key) => {
    if (typeof value !== "number") fail(path, where, `${key} must be a number (got ${repr(value)})`);
    if (!Number.isFinite(value)) fail(path, where, `${key} must be a finite number (got ${repr(value)})`);
    return value;
  };
  const bool = (table, key, path, where, def) => {
    const value = key in table ? table[key] : def;
    if (typeof value !== "boolean") fail([...path, key], where, `${key} must be true or false (got ${repr(value)})`);
    return value;
  };
  const vector = (value, path, where, key) => {
    if (!Array.isArray(value) || value.length !== 3 || value.some(c => typeof c !== "number")) {
      fail(path, where, `${key} must be three numbers like [0.0, 0.0, 10.0] (got ${repr(value)})`);
    }
    if (!value.every(Number.isFinite)) fail(path, where, `${key} must be three finite numbers (got ${repr(value)})`);
    return value.slice();
  };
  const id = (value, path, where, key) => {
    if (typeof value !== "string" || !isValidId(value)) fail(path, where, `${key}: ${repr(value)} is not a valid id (${ID_HINT})`);
    return value;
  };
  const idList = (table, key, path, where) => {
    if (!(key in table)) return [];
    const value = table[key];
    if (!Array.isArray(value)) fail([...path, key], where, `${key} must be a list of ids like ["fan"] (got ${repr(value)})`);
    const out = [];
    for (const item of value) {
      id(item, [...path, key], where, key);
      if (out.includes(item)) fail([...path, key], where, `${key} lists '${item}' twice`);
      out.push(item);
    }
    return out;
  };
  const attach = (table, path, where) => {
    const value = "attach" in table ? table.attach : "";
    return value === "" ? "" : id(value, [...path, "attach"], where, "attach");
  };
  const camera = (value, path, where, step) => {
    if (!isTable(value)) fail(path, where, `must be a table, written as '${step ? "[step.camera]" : "[camera]"}'`);
    checkKeys(value, step ? STEP_CAMERA_KEYS : CAMERA_KEYS, path, where);
    if (!Object.keys(value).length) return null;
    const cam = new CameraSpec();
    if (("position" in value) !== ("target" in value)) fail(path, where, "position and target go together: give both, or neither");
    if ("position" in value) {
      cam.position = vector(value.position, [...path, "position"], where, "position");
      cam.target = vector(value.target, [...path, "target"], where, "target");
      if (cam.position.every((c, k) => c === cam.target[k])) fail([...path, "position"], where, "position and target are the same point, so the camera has no direction");
    }
    if ("fov" in value) {
      cam.fov = number(value.fov, [...path, "fov"], where, "fov");
      if (!(cam.fov > 0 && cam.fov < 180)) fail([...path, "fov"], where, `fov must be between 0 and 180 degrees (got ${repr(value.fov)})`);
    }
    if ("projection" in value) cam.projection = enumOf(value, "projection", path, where, PROJECTIONS, "orthographic");
    if (step) {
      if ("fit" in value) {
        if (cam.position) fail([...path, "fit"], where, "fit frames the listed ids instead of a position and target: give one or the other");
        cam.fit = idList(value, "fit", path, where);
        if (!cam.fit.length) fail([...path, "fit"], where, "fit must name at least one id");
      }
    } else {
      if (!cam.position) fail(path, where, "missing required keys 'position' and 'target' (leave out [camera] to fit the view to the model)");
      if (cam.fov === null) cam.fov = 35;
      if (!cam.projection) cam.projection = "orthographic";
    }
    return cam;
  };

  if (!isTable(raw)) throw new ProjectError("the project is not a TOML document");
  const unknownTop = Object.keys(raw).filter(k => !TOP_KEYS.includes(k)).sort();
  if (unknownTop.length) {
    throw new ProjectError(`unknown top-level key(s) or table(s): ${unknownTop.join(", ")} (valid: [assembly], [camera], [[part]], [[step]])`,
      locate([unknownTop[0]]));
  }

  // [assembly]
  if (!("assembly" in raw)) throw new ProjectError("missing required [assembly] table", 1);
  let where = "[assembly]";
  const a = raw.assembly;
  if (!isTable(a)) fail(["assembly"], where, "must be a table, written as '[assembly]'");
  checkKeys(a, ASSEMBLY_KEYS, ["assembly"], where);
  if (!("title" in a)) fail(["assembly"], where, "missing required key 'title'");
  const title = text(a.title, ["assembly", "title"], where, "title");
  if (!title.trim()) fail(["assembly", "title"], where, "title must not be empty");
  if (!("models" in a)) fail(["assembly"], where, "missing required key 'models' (the .glb files beside this file, like [\"assembly.glb\"])");
  const models = a.models;
  // The designer also holds a project with no model yet, which the command
  // line refuses; Generate reports that through the bridge.
  if (!Array.isArray(models)) fail(["assembly", "models"], where, `models must list one or more .glb files, like ["assembly.glb"] (got ${repr(models)})`);
  for (const m of models) {
    if (typeof m !== "string" || !m.trim()) fail(["assembly", "models"], where, `models: ${repr(m)} is not a file name`);
    if (!m.toLowerCase().endsWith(".glb")) fail(["assembly", "models"], where, `models: '${m}' is not a .glb file (a model is the GLB the designer or \`3dstep model.step\` writes)`);
    if (/^([\\/]|[A-Za-z]:)/.test(m)) fail(["assembly", "models"], where, `models: '${m}' must be a path relative to this file`);
    if (models.filter(x => x === m).length > 1) fail(["assembly", "models"], where, `models lists '${m}' twice`);
  }
  let arrowScale = 1;
  if ("arrow_scale" in a) {
    arrowScale = number(a.arrow_scale, ["assembly", "arrow_scale"], where, "arrow_scale");
    if (arrowScale <= 0) fail(["assembly", "arrow_scale"], where, `arrow_scale must be greater than 0 (got ${repr(a.arrow_scale)})`);
  }
  const assembly = new Assembly({
    title,
    models,
    description: getText(a, "description", ["assembly"], where),
    theme: getText(a, "theme", ["assembly"], where, "default"),
    theme_dir: getText(a, "theme_dir", ["assembly"], where, DEFAULT_THEME_DIR),
    style: enumOf(a, "style", ["assembly"], where, STYLES, "lineart"),
    up: enumOf(a, "up", ["assembly"], where, UP_AXES, "z"),
    start: enumOf(a, "start", ["assembly"], where, STARTS, "visible"),
    arrow_scale: arrowScale,
  });

  // [camera]
  const home = "camera" in raw ? camera(raw.camera, ["camera"], "[camera]", false) : null;

  // [[part]]
  const parts = [];
  tables(raw.part || [], ["part"], "", "part").forEach((p, i) => {
    let w = `[[part]] #${i + 1}`;
    const path = ["part", i];
    checkKeys(p, PART_KEYS, path, w);
    if (!("id" in p)) fail(path, w, "missing required key 'id'");
    const pid = id(p.id, [...path, "id"], w, "id");
    w = `[[part]] '${pid}'`;
    if (parts.some(q => q.id === pid)) fail([...path, "id"], w, `two [[part]] tables have the id '${pid}'`);
    const color = getText(p, "color", path, w);
    if (color && !HEX_COLOR.test(color)) {
      const hint = HEX_COLOR.test(`#${color}`) ? " (it is missing its '#')" : "";
      fail([...path, "color"], w, `color must be a hex color like "#3b82f6" (got ${repr(color)})${hint}`);
    }
    parts.push(new PartMeta({ id: pid, name: getText(p, "name", path, w), color }));
  });

  // [[step]]
  const steps = [];
  const taken = new Map();
  tables(raw.step || [], ["step"], "", "step").forEach((s, i) => {
    const n = i + 1;
    const path = ["step", i];
    where = `[[step]] #${n}`;
    checkKeys(s, STEP_KEYS, path, where);
    let sid = "";
    if ("id" in s) {
      sid = id(s.id, [...path, "id"], where, "id");
      if (/^\d+$/.test(sid)) fail([...path, "id"], where, `id '${sid}' is a number, which ?step= would read as a step number; use a slug like 'screws'`);
    }
    const effective = sid || `step-${n}`;
    if (taken.has(effective)) {
      const unnamed = sid ? "" : ` (step #${n} has no id, so it gets '${effective}')`;
      fail([...path, "id"], where, `duplicate step id '${effective}', also used by step #${taken.get(effective)}${unnamed}`);
    }
    taken.set(effective, n);
    where = `[[step]] #${n} (${effective})`;
    const show = idList(s, "show", path, where);
    const hide = idList(s, "hide", path, where);
    const both = show.filter(x => hide.includes(x));
    if (both.length) fail([...path, "show"], where, `'${both[0]}' is in both show and hide`);

    const moves = [];
    const moved = new Set();
    tables(s.move || [], [...path, "move"], where, "step.move").forEach((m, j) => {
      const w = `${where}: [[step.move]] #${j + 1}`;
      const mp = [...path, "move", j];
      checkKeys(m, MOVE_KEYS, mp, w);
      if (!("parts" in m)) fail(mp, w, "missing required key 'parts'");
      const ids = idList(m, "parts", mp, w);
      if (!ids.length) fail([...mp, "parts"], w, "parts must name at least one id");
      for (const p of ids) {
        if (moved.has(p)) fail([...mp, "parts"], w, `'${p}' is already moved by another [[step.move]] in this step`);
        moved.add(p);
      }
      moves.push(new Move({
        parts: ids,
        offset: "offset" in m ? vector(m.offset, [...mp, "offset"], w, "offset") : [0, 0, 0],
        rotate: "rotate" in m ? vector(m.rotate, [...mp, "rotate"], w, "rotate") : [0, 0, 0],
        arrow: bool(m, "arrow", mp, w, true),
      }));
    });

    const arrows = [];
    tables(s.arrow || [], [...path, "arrow"], where, "step.arrow").forEach((ar, j) => {
      const w = `${where}: [[step.arrow]] #${j + 1}`;
      const ap = [...path, "arrow", j];
      checkKeys(ar, ARROW_KEYS, ap, w);
      for (const key of ["from", "to"]) if (!(key in ar)) fail(ap, w, `missing required key '${key}'`);
      const from = vector(ar.from, [...ap, "from"], w, "from");
      const to = vector(ar.to, [...ap, "to"], w, "to");
      if (from.every((c, k) => c === to[k])) fail([...ap, "to"], w, "from and to are the same point, so the arrow has no direction");
      const turns = "turns" in ar ? number(ar.turns, [...ap, "turns"], w, "turns") : 0.75;
      if (turns === 0) fail([...ap, "turns"], w, "turns must not be 0 (it is the fraction of a turn a rotate arrow sweeps; negative turns counterclockwise)");
      const radius = "radius" in ar ? number(ar.radius, [...ap, "radius"], w, "radius") : 4;
      if (radius <= 0) fail([...ap, "radius"], w, `radius must be greater than 0 (got ${repr(ar.radius)})`);
      arrows.push(new Arrow({
        from, to, turns, radius,
        kind: enumOf(ar, "kind", ap, w, ARROW_KINDS, "straight"),
        color: getText(ar, "color", ap, w),
        label: getText(ar, "label", ap, w),
        attach: attach(ar, ap, w),
      }));
    });

    const labels = [];
    tables(s.label || [], [...path, "label"], where, "step.label").forEach((l, j) => {
      const w = `${where}: [[step.label]] #${j + 1}`;
      const lp = [...path, "label", j];
      checkKeys(l, LABEL_KEYS, lp, w);
      for (const key of ["text", "at"]) if (!(key in l)) fail(lp, w, `missing required key '${key}'`);
      const t = text(l.text, [...lp, "text"], w, "text");
      if (!t.trim()) fail([...lp, "text"], w, "text must not be empty");
      labels.push(new Label({
        text: t,
        at: vector(l.at, [...lp, "at"], w, "at"),
        side: enumOf(l, "side", lp, w, LABEL_SIDES, "auto"),
        attach: attach(l, lp, w),
      }));
    });

    steps.push(new Step({
      id: sid,
      title: getText(s, "title", path, where),
      text: getText(s, "text", path, where),
      note: getText(s, "note", path, where),
      show,
      hide,
      highlight: idList(s, "highlight", path, where),
      ghost: idList(s, "ghost", path, where),
      camera: "camera" in s ? camera(s.camera, [...path, "camera"], `${where}: [step.camera]`, true) : null,
      moves,
      arrows,
      labels,
    }));
  });
  if (!steps.length && assembly.models.length) {
    warnings.push("the project has no [[step]] tables, so the page shows the model with no instructions");
  }
  return { project: new Project({ assembly, camera: home, parts, steps }), warnings };
}

// ── The loaded models' ids ───────────────────────────────────────────

// Every node of the loaded models, in project order then document order:
// order (ids), parts / groups (sets), label, children, parent, model (the file
// a node is in), members (the parts a reference means: the part itself, or
// every part under a group). An id two models share keeps the first node, as
// config.check_ids does.
export function buildRegistry(models) {
  const reg = {
    order: [], parts: new Set(), groups: new Set(), label: new Map(), children: new Map(), parent: new Map(),
    model: new Map(), members: new Map(), duplicates: [],
  };
  for (const model of models) {
    if (!model || !Array.isArray(model.nodes)) continue;
    const ids = model.nodes.map(n => n.id);
    model.nodes.forEach(node => {
      if (reg.model.has(node.id)) {
        reg.duplicates.push({ id: node.id, models: [reg.model.get(node.id), model.name] });
        return;
      }
      reg.order.push(node.id);
      reg.model.set(node.id, model.name);
      reg.label.set(node.id, node.label || node.id);
      reg.children.set(node.id, node.children.map(c => ids[c]));
      if (node.parent >= 0) reg.parent.set(node.id, ids[node.parent]);
      if (node.mesh >= 0) reg.parts.add(node.id);
      else reg.groups.add(node.id);
    });
  }
  const collect = id => {
    if (reg.members.has(id)) return reg.members.get(id);
    const out = [];
    if (reg.parts.has(id)) out.push(id);
    for (const c of reg.children.get(id) || []) for (const p of collect(c)) out.push(p);
    reg.members.set(id, out);
    return out;
  };
  for (const id of reg.order) collect(id);
  return reg;
}

export function membersOf(reg, id) {
  return reg.members.get(id) || [];
}

export function knownId(reg, id) {
  return reg.members.has(id);
}

// The parts a list of ids means, each once, in the order given.
export function expandIds(reg, ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids || []) {
    for (const p of membersOf(reg, id)) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

export function allParts(reg) {
  return reg.order.filter(id => reg.parts.has(id));
}

// The visible parts of every step (SPEC 6, "State folding"): before step 1
// every part is visible (or none, with start = "hidden"); each step applies
// its hide list, then its show list.
export function foldVisibility(steps, start, reg) {
  let visible = new Set(start === "hidden" ? [] : allParts(reg));
  return steps.map(step => {
    visible = applyDeltas(visible, step.show, step.hide, reg);
    return visible;
  });
}

export function applyDeltas(prev, show, hide, reg) {
  const out = new Set(prev);
  for (const p of expandIds(reg, hide)) out.delete(p);
  for (const p of expandIds(reg, show)) out.add(p);
  return out;
}

// The ids of `ids` with the parts in `drop` taken out: a part in drop goes, a
// group wholly in drop goes, a group partly in drop is replaced by its
// children (recursively), so the list keeps naming every other part it named.
// An id no model has stays as it is.
export function removeFromIds(reg, ids, drop) {
  const out = [];
  const split = id => {
    const members = membersOf(reg, id);
    if (!members.length) return [id];
    const hit = members.filter(p => drop.has(p)).length;
    if (!hit) return [id];
    if (hit === members.length) return [];
    return (reg.children.get(id) || []).flatMap(split);
  };
  for (const id of ids) for (const x of split(id)) if (!out.includes(x)) out.push(x);
  return out;
}

// Ids naming exactly the parts in `need`: first the ids in `prefer` (what the
// user acted on) when all their parts are allowed, then the largest groups
// wholly inside `need`, top down, then single parts.
export function coverIds(reg, need, { allowed = null, forbidden = new Set(), prefer = [] } = {}) {
  const left = new Set(need);
  const out = [];
  const ok = id => {
    const m = membersOf(reg, id);
    return m.length > 0 && m.every(p => (!allowed || allowed.has(p)) && !forbidden.has(p));
  };
  for (const id of prefer) {
    const m = membersOf(reg, id);
    if (m.some(p => left.has(p)) && ok(id)) {
      out.push(id);
      m.forEach(p => left.delete(p));
    }
  }
  if (!left.size) return out;
  const walk = id => {
    const m = membersOf(reg, id);
    if (!m.some(p => left.has(p))) return;
    // A needed part is always taken; a group only when it adds nothing unwanted.
    if (m.every(p => left.has(p)) && (reg.parts.has(id) || ok(id))) {
      out.push(id);
      m.forEach(p => left.delete(p));
      return;
    }
    for (const c of reg.children.get(id) || []) walk(c);
  };
  for (const id of reg.order) if (!reg.parent.has(id)) walk(id);
  for (const p of need) if (left.has(p)) out.push(p);   // ids no tree walk reaches
  return out;
}

// Add ids to a highlight / ghost style list: skip what the list already
// covers, and drop entries the new ids cover entirely.
export function addToIdList(reg, ids, add) {
  const covered = new Set(expandIds(reg, ids));
  const fresh = add.filter(id => !membersOf(reg, id).length ? !ids.includes(id) : membersOf(reg, id).some(p => !covered.has(p)));
  if (!fresh.length) return ids.slice();
  const freshParts = new Set(expandIds(reg, fresh));
  const kept = ids.filter(id => {
    const m = membersOf(reg, id);
    return !m.length || !m.every(p => freshParts.has(p));
  });
  return [...kept, ...fresh.filter(id => !kept.includes(id))];
}

const setsEqual = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

// Rewrite the show / hide deltas from step `from` on, so that each step k >=
// from displays targets[k] (a Set of part ids). Earlier steps keep their lists.
// A step's lists change only as much as needed: parts are taken out of the
// lists that hide or show them by mistake (splitting a group into its other
// children), then the parts still wrong are added, covered by the ids in
// `prefer` where they fit and the largest groups otherwise. A step never ends
// up with one part in both its expanded show and hide lists (the viewer
// rejects that). Returns new {show, hide} lists for every step.
export function rewriteVisibility(steps, start, reg, targets, { from = 0, prefer = [] } = {}) {
  const out = steps.map(s => ({ show: s.show.slice(), hide: s.hide.slice() }));
  let prev = new Set(start === "hidden" ? [] : allParts(reg));
  for (let k = 0; k < steps.length; k++) {
    if (k < from) {
      prev = applyDeltas(prev, out[k].show, out[k].hide, reg);
      continue;
    }
    const target = targets[k];
    let { show, hide } = out[k];
    let S = new Set(expandIds(reg, show));
    let H = new Set(expandIds(reg, hide));
    // A part both shown and hidden by one step is shown (hide applies first):
    // say so with the hide list alone.
    const both = new Set([...H].filter(p => S.has(p)));
    if (both.size) hide = removeFromIds(reg, hide, both);
    H = new Set(expandIds(reg, hide));
    let F = applyDeltas(prev, show, hide, reg);
    if (!setsEqual(F, target)) {
      const unhide = new Set([...target].filter(p => !F.has(p) && H.has(p)));
      const unshow = new Set([...F].filter(p => !target.has(p) && S.has(p)));
      if (unhide.size) hide = removeFromIds(reg, hide, unhide);
      if (unshow.size) show = removeFromIds(reg, show, unshow);
      S = new Set(expandIds(reg, show));
      H = new Set(expandIds(reg, hide));
      F = applyDeltas(prev, show, hide, reg);
      const add = [...target].filter(p => !F.has(p));
      const del = [...F].filter(p => !target.has(p));
      if (add.length) {
        for (const id of coverIds(reg, add, { allowed: target, forbidden: H, prefer })) if (!show.includes(id)) show.push(id);
      }
      if (del.length) {
        const hidden = new Set(allParts(reg).filter(p => !target.has(p)));
        for (const id of coverIds(reg, del, { allowed: hidden, forbidden: new Set(expandIds(reg, show)), prefer })) {
          if (!hide.includes(id)) hide.push(id);
        }
      }
    }
    out[k] = { show, hide };
    prev = target;
  }
  return out;
}
