// The designer's state: the project, the models loaded into it, the current
// step and the selection, an event bus and undo (PinConnect's BoardState
// pattern, SPEC 12.2).
//
// Every mutator takes an origin ("visual" for the panels, "viewport",
// "editor" for the TOML tab, "import", "open", "undo") and commits a new
// project in one step: one undo snapshot, one "project-changed" event whose
// `change` tells the TOML tab which blocks moved. Visibility is edited through
// the show / hide deltas, rewritten so that every other step keeps the state
// it displays (project-model.js does the folding and rewriting). Model
// operations (import, delete, merge, simplify) snapshot the models too; at
// most MODEL_SNAPSHOTS of those stay in the history.
//
// Events: project-changed {origin, change}, models-changed {origin},
// step-changed {index, origin}, selection-changed {selection},
// undo-changed, before-mutation {origin, cancel}, source-error, and
// dirty-changed for the unload guard.

import {
  ARROW_KINDS, Arrow, CameraSpec, LABEL_SIDES, Label, Move, PartMeta, Project, Step, addToIdList, allParts, buildRegistry,
  expandIds, foldVisibility, membersOf, removeFromIds, rewriteVisibility, stepIdFor,
} from "./project-model.js";
import { isValidId } from "./import/ids.js";
import {
  DEFAULT_RUNTIME_BYTES, bboxOf, deleteNodes, deletedIds, estimateGlbSize, glbNameFor, mergeGroup as mergeModelGroup,
  nodeIndex, triangleCount,
} from "./import/model.js";
import { writeGlb } from "./import/glb-writer.js";

export const MODEL_SNAPSHOTS = 5;
const UNDO_LIMIT = 100;

export function emptySelection() {
  return { parts: [], arrow: -1, label: -1 };
}

const round = (v, digits = 3) => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const round3 = v => v.map(x => round(x));
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// Step text as the TOML keeps it: LF only, and a multi-line text ends with a
// newline, so it is written as the SPEC 6 example writes it.
export function normalizeText(text) {
  let t = String(text ?? "").replace(/\r\n?/g, "\n");
  if (t.includes("\n") && !t.endsWith("\n")) t += "\n";
  return t;
}

export class ProjectState {
  constructor() {
    this.project = new Project();
    this.models = new Map();        // file name -> Model (SPEC 13.1)
    // file name -> the Model on disk under that name (as opened, attached or
    // last saved). Undo never touches it: a model is dirty when the one in the
    // project is not the one on disk, however it got there.
    this._onDisk = new Map();
    this.registry = buildRegistry([]);
    this.currentStep = -1;
    this.selection = emptySelection();
    // The TOML tab keeps the last text it synchronized here, so undo restores
    // comments and formatting with the data (PinConnect's sourceText).
    this.sourceText = null;
    this.themes = [];               // [{name, display}] from the bridge
    this.runtimeBytes = DEFAULT_RUNTIME_BYTES;
    this._glbCache = new WeakMap();   // Model -> its GLB: the bytes it was opened or saved as, else as written
    this._listeners = new Map();
    this._origin = null;
    this._undoStack = [];
    this._redoStack = [];
    this._isRestoring = false;
  }

  // ── Events ─────────────────────────────────────────────────────────

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(callback);
  }

  off(event, callback) {
    const cbs = this._listeners.get(event);
    if (cbs) {
      const i = cbs.indexOf(callback);
      if (i >= 0) cbs.splice(i, 1);
    }
  }

  emit(event, data) {
    const cbs = this._listeners.get(event);
    if (cbs) cbs.slice().forEach(cb => cb(data));
  }

  get origin() { return this._origin; }
  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }

  // ── Queries ────────────────────────────────────────────────────────

  // The loaded models in the project's order.
  loadedModels() {
    return this.project.assembly.models.filter(n => this.models.has(n)).map(n => this.models.get(n));
  }

  missingModels() {
    return this.project.assembly.models.filter(n => !this.models.has(n));
  }

  step(index = this.currentStep) {
    return this.project.steps[index] || null;
  }

  folds() {
    return foldVisibility(this.project.steps, this.project.assembly.start, this.registry);
  }

  // Display name of a node: its [[part]] name, else its CAD label, else its id.
  displayName(id) {
    const meta = this.project.partMeta(id);
    return (meta && meta.name) || this.registry.label.get(id) || id;
  }

  // Where each part sits in a step: {offset, rotate, arrow, move (index), named (the id the move lists)}.
  placements(index = this.currentStep) {
    const out = new Map();
    const step = this.step(index);
    if (!step) return out;
    step.moves.forEach((m, mi) => {
      for (const id of m.parts) {
        const parts = membersOf(this.registry, id);
        for (const p of parts.length ? parts : [id]) out.set(p, { offset: m.offset, rotate: m.rotate, arrow: m.arrow, move: mi, named: id });
      }
    });
    return out;
  }

  triangles() {
    return this.loadedModels().reduce((sum, m) => sum + triangleCount(m), 0);
  }

  // The generated page's size: every GLB as base64 plus the runtime.
  pageSize() {
    let total = this.runtimeBytes;
    for (const model of this.loadedModels()) {
      const bytes = this._glbCache.get(model);
      total += Math.ceil((bytes ? bytes.length : estimateGlbSize(model)) / 3) * 4;
    }
    return total;
  }

  // Models not saved as they are: imported ones, changed ones, and ones an
  // undo or redo brought back after a Save wrote another version.
  get dirtyModels() {
    const out = new Set();
    for (const [name, model] of this.models) if (this._onDisk.get(name) !== model) out.add(name);
    return out;
  }

  // The bytes a model was opened or saved as stay its GLB: Models never change.
  _rememberBytes(model, bytes) {
    if (model && bytes) this._glbCache.set(model, bytes);
  }

  // The GLB bytes of a model: as opened or saved while unchanged (so Generate
  // inlines what is on disk), else freshly written.
  glbBytes(name) {
    const model = this.models.get(name);
    if (!model) return null;
    let out = this._glbCache.get(model);
    if (!out) {
      out = writeGlb(model);
      this._glbCache.set(model, out);
    }
    return out;
  }

  // {min, max} of the parts under ids (every part when empty), over all models.
  bboxOf(ids) {
    let box = null;
    for (const model of this.loadedModels()) {
      const own = ids && ids.length ? ids.filter(id => nodeIndex(model, id) >= 0) : null;
      if (own && !own.length) continue;
      const b = bboxOf(model, own);
      if (!b) continue;
      box = box ? { min: box.min.map((v, k) => Math.min(v, b.min[k])), max: box.max.map((v, k) => Math.max(v, b.max[k])) } : b;
    }
    return box;
  }

  // Ids without the ones a selected group already covers.
  topIds(ids) {
    return ids.filter(id => {
      for (let p = this.registry.parent.get(id); p; p = this.registry.parent.get(p)) if (ids.includes(p)) return false;
      return true;
    });
  }

  // ── Mutations ──────────────────────────────────────────────────────

  _prepareMutation(origin) {
    if (origin === "editor" || origin === "init" || origin === "open" || this._isRestoring) return true;
    // The TOML tab may hold a pending keystroke: flush it before reading the
    // project. Text that does not parse cancels the action instead of letting
    // the two drift apart (PinConnect's before-mutation).
    const request = { origin, cancel: false };
    this.emit("before-mutation", request);
    return !request.cancel;
  }

  _snapshot(withModels) {
    return {
      project: this.project.toData(),
      sourceText: this.sourceText,
      selection: JSON.parse(JSON.stringify(this.selection)),
      currentStep: this.currentStep,
      models: withModels ? { map: new Map(this.models) } : null,
    };
  }

  // Keep at most MODEL_SNAPSHOTS model snapshots: history older than the
  // oldest one kept cannot be restored without its models, so it goes too.
  _trim(stack) {
    if (stack.length > UNDO_LIMIT) stack.splice(0, stack.length - UNDO_LIMIT);
    const withModels = stack.map((s, i) => (s.models ? i : -1)).filter(i => i >= 0);
    if (withModels.length > MODEL_SNAPSHOTS) stack.splice(0, withModels[withModels.length - MODEL_SNAPSHOTS - 1] + 1);
  }

  _pushUndo(withModels) {
    if (this._isRestoring) return;
    this._undoStack.push(this._snapshot(withModels));
    this._trim(this._undoStack);
    this._redoStack = [];
    this.emit("undo-changed", {});
  }

  _restore(snap) {
    this._isRestoring = true;
    const listBefore = JSON.stringify(this.project.assembly.models);
    this.project = Project.fromData(snap.project);
    this.sourceText = snap.sourceText ?? null;
    // The loaded models change with a model snapshot, or with a models list
    // the TOML tab edited: the registry describes loadedModels() either way.
    const modelsChanged = !!snap.models || JSON.stringify(this.project.assembly.models) !== listBefore;
    if (snap.models) this.models = new Map(snap.models.map);
    if (modelsChanged) this.registry = buildRegistry(this.loadedModels());
    this.currentStep = snap.currentStep;
    this._clampStep();
    this.selection = this._validSelection(snap.selection);
    this._origin = "undo";
    if (modelsChanged) this.emit("models-changed", { origin: "undo" });
    this.emit("project-changed", { origin: "undo", change: { kind: "full" } });
    this.emit("step-changed", { index: this.currentStep, origin: "undo" });
    this.emit("selection-changed", { selection: this.selection });
    this.emit("dirty-changed", {});
    this._origin = null;
    this._isRestoring = false;
    this.emit("undo-changed", {});
  }

  undo() {
    if (!this.canUndo) return;
    const snap = this._undoStack.pop();
    this._redoStack.push(this._snapshot(!!snap.models));
    this._trim(this._redoStack);
    this._restore(snap);
  }

  redo() {
    if (!this.canRedo) return;
    const snap = this._redoStack.pop();
    this._undoStack.push(this._snapshot(!!snap.models));
    this._trim(this._undoStack);
    this._restore(snap);
  }

  _clampStep() {
    const n = this.project.steps.length;
    if (!n) this.currentStep = -1;
    else if (this.currentStep < 0 || this.currentStep >= n) this.currentStep = Math.max(0, Math.min(n - 1, this.currentStep));
  }

  _validSelection(sel) {
    const step = this.step();
    return {
      parts: sel.parts.filter(id => this.registry.members.has(id)),
      arrow: step && sel.arrow >= 0 && sel.arrow < step.arrows.length ? sel.arrow : -1,
      label: step && sel.label >= 0 && sel.label < step.labels.length ? sel.label : -1,
    };
  }

  // One undo step: the new project (and models), then the events.
  _commit(origin, next, change, { models = null, currentStep, selection } = {}) {
    if (!models && JSON.stringify(next.toData()) === JSON.stringify(this.project.toData())) return false;
    this._pushUndo(!!models);
    const stepBefore = this.currentStep;
    const selBefore = JSON.stringify(this.selection);
    const listBefore = JSON.stringify(this.project.assembly.models);
    this.project = next;
    // A models list edited in the TOML tab changes the loaded models too.
    const modelsChanged = !!models || JSON.stringify(next.assembly.models) !== listBefore;
    if (models) this.models = models.map;
    if (modelsChanged) this.registry = buildRegistry(this.loadedModels());
    if (currentStep !== undefined) this.currentStep = currentStep;
    this._clampStep();
    if (this.currentStep !== stepBefore) this.selection = { ...this.selection, arrow: -1, label: -1 };
    this.selection = this._validSelection(selection || this.selection);
    this._origin = origin;
    if (modelsChanged) this.emit("models-changed", { origin });
    this.emit("project-changed", { origin, change });
    if (this.currentStep !== stepBefore) this.emit("step-changed", { index: this.currentStep, origin });
    if (JSON.stringify(this.selection) !== selBefore) this.emit("selection-changed", { selection: this.selection });
    this.emit("dirty-changed", {});
    this._origin = null;
    return true;
  }

  // A new project from the TOML tab, with the text it was parsed from.
  // Snapshots hold the text, so typing that changes only comments or layout
  // is an undo step of its own: Undo takes back that typing, not the change
  // before it.
  setProjectFromEditor(project, text) {
    const changed = this._commit("editor", project, { kind: "full" });
    if (!changed && text !== this.sourceText) this._pushUndo(false);
    this.sourceText = text;
    return changed;
  }

  // Replace everything: an opened project, or the empty start. "init" keeps
  // no history; "open" is one undo step.
  loadProject(project, { models = new Map(), bytes = new Map(), origin = "open", sourceText = null } = {}) {
    if (!this._prepareMutation(origin)) return false;
    const state = { map: new Map(models) };
    // The opened files are what is on disk from now on.
    this._onDisk = new Map(state.map);
    for (const [name, model] of state.map) this._rememberBytes(model, bytes.get(name));
    if (origin === "init") {
      this.project = project;
      this.models = state.map;
      this.registry = buildRegistry(this.loadedModels());
      this.sourceText = sourceText;
      this.currentStep = project.steps.length ? 0 : -1;
      this.selection = emptySelection();
      this._undoStack = [];
      this._redoStack = [];
      this._origin = "init";
      this.emit("models-changed", { origin });
      this.emit("project-changed", { origin, change: { kind: "full", text: sourceText } });
      this.emit("step-changed", { index: this.currentStep, origin });
      this.emit("selection-changed", { selection: this.selection });
      this.emit("undo-changed", {});
      this.emit("dirty-changed", {});
      this._origin = null;
      return true;
    }
    return this._commit(origin, project, { kind: "full", text: sourceText }, { models: state, currentStep: project.steps.length ? 0 : -1, selection: emptySelection() });
  }

  // Add models opened beside a project (matched by file name), without an undo step of their own.
  attachModel(name, model, bytes) {
    this.models.set(name, model);
    this._onDisk.set(name, model);
    this._rememberBytes(model, bytes);
    this.registry = buildRegistry(this.loadedModels());
    this.selection = this._validSelection(this.selection);
    this.emit("models-changed", { origin: "open" });
    this.emit("dirty-changed", {});
  }

  setAssembly(fields, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const next = this.project.clone();
    Object.assign(next.assembly, fields);
    if ("description" in fields) next.assembly.description = normalizeText(fields.description);
    return this._commit(origin, next, { kind: "assembly" });
  }

  // The home view ([camera]); null means fit the model.
  setCamera(cam, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const next = this.project.clone();
    next.camera = cam && cam.position && cam.target ? new CameraSpec({
      position: round3(cam.position), target: round3(cam.target), fov: round(cam.fov ?? 35, 2), projection: cam.projection || "orthographic",
    }) : null;
    return this._commit(origin, next, { kind: "camera" });
  }

  // A step's own camera: {position, target, fov, projection} captured from the
  // view, {fit: [ids]}, or null to inherit the previous step's. A fit list
  // keeps the step camera's fov and projection unless it names its own; an
  // empty one leaves only those, as Delete does.
  setStepCamera(index, cam, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const next = this.project.clone();
    const step = next.steps[index];
    if (!step) return false;
    const prev = step.camera;
    if (!cam) step.camera = null;
    else if (cam.fit) step.camera = withFit({ fov: cam.fov ?? (prev ? prev.fov : null), projection: cam.projection ?? (prev ? prev.projection : null) }, cam.fit.slice());
    else step.camera = new CameraSpec({ position: round3(cam.position), target: round3(cam.target), fov: round(cam.fov ?? 35, 2), projection: cam.projection || "orthographic" });
    return this._commit(origin, next, { kind: "steps", indices: [index] });
  }

  setCurrentStep(index, origin = "visual") {
    const n = this.project.steps.length;
    const i = n ? Math.max(0, Math.min(n - 1, index)) : -1;
    if (i === this.currentStep) return false;
    this.currentStep = i;
    const sel = { ...this.selection, arrow: -1, label: -1 };
    const selChanged = sel.arrow !== this.selection.arrow || sel.label !== this.selection.label;
    this.selection = sel;
    this.emit("step-changed", { index: i, origin });
    if (selChanged) this.emit("selection-changed", { selection: this.selection });
    return true;
  }

  setSelection(selection) {
    const next = this._validSelection({ ...emptySelection(), ...selection });
    if (JSON.stringify(next) === JSON.stringify(this.selection)) return false;
    this.selection = next;
    this.emit("selection-changed", { selection: this.selection });
    return true;
  }

  // mode: "replace" | "toggle" | "add"
  selectParts(ids, mode = "replace") {
    let parts;
    if (mode === "replace") parts = ids.slice();
    else if (mode === "add") parts = [...this.selection.parts, ...ids.filter(id => !this.selection.parts.includes(id))];
    else {
      parts = this.selection.parts.slice();
      for (const id of ids) {
        const i = parts.indexOf(id);
        if (i >= 0) parts.splice(i, 1);
        else parts.push(id);
      }
    }
    return this.setSelection({ parts });
  }

  clearSelection() {
    return this.setSelection(emptySelection());
  }

  // ── Steps ──────────────────────────────────────────────────────────

  _stepIds(project, except = -1) {
    return project.steps.map((s, i) => (i === except ? null : project.stepId(i))).filter(Boolean);
  }

  // After the current step: the same visibility (no deltas), no moves,
  // highlights, ghosts, arrows or labels, the camera inherited (SPEC 12.1).
  addStep(origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const next = this.project.clone();
    const index = this.currentStep + 1;
    next.steps.splice(index, 0, new Step());
    return this._commit(origin, next, { kind: "step-added", index }, { currentStep: index, selection: { ...this.selection, arrow: -1, label: -1 } });
  }

  // A copy right after it. The copy needs no show / hide deltas (applying a
  // step's deltas twice changes nothing), so it has none.
  duplicateStep(index = this.currentStep, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const src = this.project.steps[index];
    if (!src) return false;
    const next = this.project.clone();
    const copy = new Step({ ...JSON.parse(JSON.stringify(src)), show: [], hide: [] });
    if (src.id) copy.id = stepIdFor(src.id, this._stepIds(next));
    next.steps.splice(index + 1, 0, copy);
    return this._commit(origin, next, { kind: "step-added", index: index + 1, duplicateOf: index }, { currentStep: index + 1 });
  }

  // Remove a step; the steps after it keep what they display (a part the
  // removed step showed is shown by the next one instead).
  removeStep(index = this.currentStep, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    if (!this.project.steps[index]) return false;
    const next = this.project.clone();
    const folds = this.folds();
    next.steps.splice(index, 1);
    const targets = folds.filter((_, k) => k !== index);
    this._applyLists(next, rewriteVisibility(next.steps, next.assembly.start, this.registry, targets, { from: index }));
    const current = Math.min(index, next.steps.length - 1);
    return this._commit(origin, next, { kind: "step-removed", index }, { currentStep: current });
  }

  // Move a step to index `to` (its final position); every step keeps what it
  // displays, so the deltas from the first moved position on are rewritten.
  moveStep(from, to, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const n = this.project.steps.length;
    if (!(from >= 0 && from < n && to >= 0 && to < n) || from === to) return false;
    const next = this.project.clone();
    const folds = this.folds();
    const [step] = next.steps.splice(from, 1);
    next.steps.splice(to, 0, step);
    const [target] = folds.splice(from, 1);
    folds.splice(to, 0, target);
    this._applyLists(next, rewriteVisibility(next.steps, next.assembly.start, this.registry, folds, { from: Math.min(from, to) }));
    let current = this.currentStep;
    if (current === from) current = to;
    else if (from < current && current <= to) current--;
    else if (to <= current && current < from) current++;
    return this._commit(origin, next, { kind: "step-moved", from, to }, { currentStep: current });
  }

  // id, title, text, note.
  updateStep(index, fields, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const next = this.project.clone();
    const step = next.steps[index];
    if (!step) return false;
    if ("id" in fields) step.id = fields.id ? stepIdFor(fields.id, this._stepIds(next, index)) : "";
    if ("title" in fields) step.title = String(fields.title).replace(/[\r\n]+/g, " ");
    if ("text" in fields) step.text = normalizeText(fields.text);
    if ("note" in fields) step.note = normalizeText(fields.note);
    return this._commit(origin, next, { kind: "steps", indices: [index] });
  }

  _applyLists(project, lists) {
    lists.forEach((l, k) => {
      project.steps[k].show = l.show;
      project.steps[k].hide = l.hide;
    });
  }

  // ── Visibility, highlight, ghost ───────────────────────────────────

  // Show or hide ids in the current step. Other steps keep what they display
  // (SPEC 12.2), unless onward is set: then the change holds from this step on.
  setVisibility(ids, visible, { origin = "visual", onward = false } = {}) {
    if (!this._prepareMutation(origin)) return false;
    const c = this.currentStep;
    if (c < 0 || !ids.length) return false;
    const next = this.project.clone();
    const parts = expandIds(this.registry, ids);
    const targets = this.folds().map((s, k) => {
      if (k < c || (k > c && !onward)) return s;
      const t = new Set(s);
      for (const p of parts) {
        if (visible) t.add(p);
        else t.delete(p);
      }
      return t;
    });
    this._applyLists(next, rewriteVisibility(next.steps, next.assembly.start, this.registry, targets, { from: c, prefer: this.topIds(ids) }));
    return this._commit(origin, next, { kind: "steps", indices: [c] });
  }

  // Show only these ids in the current step.
  isolate(ids, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const c = this.currentStep;
    if (c < 0 || !ids.length) return false;
    const next = this.project.clone();
    const keep = new Set(expandIds(this.registry, ids));
    const targets = this.folds().map((s, k) => (k === c ? keep : s));
    this._applyLists(next, rewriteVisibility(next.steps, next.assembly.start, this.registry, targets, { from: c, prefer: this.topIds(ids) }));
    return this._commit(origin, next, { kind: "steps", indices: [c] });
  }

  _setListed(key, ids, on, origin) {
    if (!this._prepareMutation(origin)) return false;
    const c = this.currentStep;
    if (c < 0 || !ids.length) return false;
    const next = this.project.clone();
    const step = next.steps[c];
    step[key] = on ? addToIdList(this.registry, step[key], this.topIds(ids)) : removeFromIds(this.registry, step[key], new Set(expandIds(this.registry, ids)));
    if (!on) step[key] = step[key].filter(id => !ids.includes(id));
    return this._commit(origin, next, { kind: "steps", indices: [c] });
  }

  setHighlight(ids, on, origin = "visual") {
    return this._setListed("highlight", ids, on, origin);
  }

  setGhost(ids, on, origin = "visual") {
    return this._setListed("ghost", ids, on, origin);
  }

  // Undo what the current step does with these ids (the Delete key): they
  // leave its show, hide, highlight, ghost and fit lists and its moves. Later
  // steps keep what they display.
  removeFromStep(ids, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const c = this.currentStep;
    if (c < 0 || !ids.length) return false;
    const next = this.project.clone();
    const step = next.steps[c];
    const drop = new Set(expandIds(this.registry, ids));
    const without = list => removeFromIds(this.registry, list, drop).filter(id => !ids.includes(id));
    const folds = this.folds();
    for (const key of ["show", "hide", "highlight", "ghost"]) step[key] = without(step[key]);
    if (step.camera && step.camera.fit) step.camera = withFit(step.camera, without(step.camera.fit));
    const removed = this._withoutInMoves(step, drop, ids);
    const targets = foldVisibility(next.steps, next.assembly.start, this.registry).map((s, k) => (k <= c ? s : folds[k]));
    this._applyLists(next, rewriteVisibility(next.steps, next.assembly.start, this.registry, targets, { from: c + 1 }));
    return this._commit(origin, next, { kind: "steps", indices: [c], removed: removed.map(index => ({ step: c, list: "moves", index })) });
  }

  // Take one id out of one list of the current step (a chip's x): show and
  // hide keep the later steps' displayed states, as every visibility edit does.
  removeListedId(key, id, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const c = this.currentStep;
    const step = this.step();
    if (!step || !step[key] || !step[key].includes(id)) return false;
    const next = this.project.clone();
    const folds = this.folds();
    next.steps[c][key] = next.steps[c][key].filter(x => x !== id);
    if (key === "show" || key === "hide") {
      const targets = foldVisibility(next.steps, next.assembly.start, this.registry).map((s, k) => (k <= c ? s : folds[k]));
      this._applyLists(next, rewriteVisibility(next.steps, next.assembly.start, this.registry, targets, { from: c + 1 }));
    }
    return this._commit(origin, next, { kind: "steps", indices: [c] });
  }

  // Take parts out of a step's moves; returns the indices of the moves that
  // were left empty and removed (highest first).
  _withoutInMoves(step, drop, ids = []) {
    const removed = [];
    step.moves.forEach(m => { m.parts = removeFromIds(this.registry, m.parts, drop).filter(id => !ids.includes(id)); });
    for (let j = step.moves.length - 1; j >= 0; j--) {
      if (!step.moves[j].parts.length) {
        step.moves.splice(j, 1);
        removed.push(j);
      }
    }
    return removed;
  }

  // ── Moves ──────────────────────────────────────────────────────────

  // Set where ids sit in the current step: fields of {offset, rotate, arrow}.
  // The move that lists exactly these ids is edited; otherwise the ids leave
  // the moves they are in and get a move of their own, starting from where
  // the first of them sits now.
  setMove(ids, fields, origin = "visual") {
    return this.setMoves([{ ids, ...fields }], origin);
  }

  // Several placements in one undo step (a gizmo drag over a selection, an
  // exploded step): entries of {ids, offset, rotate, arrow}, each applied as
  // setMove applies one. Entries are applied in order, so an entry may take
  // parts out of a move an earlier entry made.
  setMoves(entries, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const c = this.currentStep;
    if (c < 0 || !entries.length) return false;
    const next = this.project.clone();
    const step = next.steps[c];
    const placements = this.placements(c);
    const removed = [];
    let any = false;
    for (const entry of entries) {
      // Ids no loaded model has get no move (the page could not place them).
      const ids = this.topIds(entry.ids || []).filter(id => this.registry.members.has(id));
      if (!ids.length) continue;
      any = true;
      const clean = {};
      if (entry.offset) clean.offset = entry.offset.map(v => round(v, 4));
      if (entry.rotate) clean.rotate = entry.rotate.map(v => round(v, 4));
      if ("arrow" in entry && entry.arrow !== undefined) clean.arrow = entry.arrow !== false;
      const exact = step.moves.find(m => sameSet(m.parts, ids));
      if (exact) {
        Object.assign(exact, clean);
        continue;
      }
      const first = expandIds(this.registry, ids)[0] || ids[0];
      const now = placements.get(first) || { offset: [0, 0, 0], rotate: [0, 0, 0], arrow: true };
      for (const index of this._withoutInMoves(step, new Set(expandIds(this.registry, ids)), ids)) removed.push({ step: c, list: "moves", index });
      step.moves.push(new Move({ parts: ids, offset: now.offset, rotate: now.rotate, arrow: now.arrow, ...clean }));
    }
    if (!any) return false;
    return this._commit(origin, next, { kind: "steps", indices: [c], removed });
  }

  // Back to the assembled pose in the current step.
  clearMove(ids, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const c = this.currentStep;
    if (c < 0 || !ids.length) return false;
    const next = this.project.clone();
    const removed = this._withoutInMoves(next.steps[c], new Set(expandIds(this.registry, ids)), ids);
    return this._commit(origin, next, { kind: "steps", indices: [c], removed: removed.map(index => ({ step: c, list: "moves", index })) });
  }

  // ── Arrows and labels (of the current step) ────────────────────────

  _subEdit(list, fn, origin, select) {
    if (!this._prepareMutation(origin)) return false;
    const c = this.currentStep;
    if (c < 0) return false;
    const next = this.project.clone();
    const out = fn(next.steps[c][list]);
    if (out === false) return false;
    const change = { kind: "steps", indices: [c] };
    if (out && out.removed !== undefined) change.removed = [{ step: c, list, index: out.removed }];
    return this._commit(origin, next, change, select ? { selection: select(next.steps[c][list]) } : {});
  }

  addArrow(fields = {}, origin = "visual") {
    if (refusedFields(fields)) return false;
    return this._subEdit("arrows", arrows => { arrows.push(new Arrow(cleanArrow(fields))); },
      origin, arrows => ({ parts: [], arrow: arrows.length - 1, label: -1 }));
  }

  updateArrow(index, fields, origin = "visual") {
    if (refusedFields(fields)) return false;
    return this._subEdit("arrows", arrows => {
      if (!arrows[index]) return false;
      Object.assign(arrows[index], cleanArrow(fields));
      return undefined;
    }, origin);
  }

  removeArrow(index, origin = "visual") {
    return this._subEdit("arrows", arrows => {
      if (!arrows[index]) return false;
      arrows.splice(index, 1);
      return { removed: index };
    }, origin, () => ({ ...this.selection, arrow: -1 }));
  }

  addLabel(fields = {}, origin = "visual") {
    if (refusedFields(fields)) return false;
    return this._subEdit("labels", labels => { labels.push(new Label(cleanLabel(fields))); },
      origin, labels => ({ parts: [], arrow: -1, label: labels.length - 1 }));
  }

  updateLabel(index, fields, origin = "visual") {
    if (refusedFields(fields)) return false;
    return this._subEdit("labels", labels => {
      if (!labels[index]) return false;
      Object.assign(labels[index], cleanLabel(fields));
      return undefined;
    }, origin);
  }

  removeLabel(index, origin = "visual") {
    return this._subEdit("labels", labels => {
      if (!labels[index]) return false;
      labels.splice(index, 1);
      return { removed: index };
    }, origin, () => ({ ...this.selection, label: -1 }));
  }

  // ── Part metadata ([[part]]) ───────────────────────────────────────

  _setMeta(id, fields, origin) {
    if (!this._prepareMutation(origin)) return false;
    const next = this.project.clone();
    let meta = next.partMeta(id);
    if (!meta) {
      meta = new PartMeta({ id });
      next.parts.push(meta);
    }
    Object.assign(meta, fields);
    if (!meta.name && !meta.color) next.parts = next.parts.filter(p => p !== meta);
    return this._commit(origin, next, { kind: "parts" });
  }

  // The display name only: ids never change after import, so references stay valid.
  renamePart(id, name, origin = "visual") {
    const label = this.registry.label.get(id);
    const clean = String(name ?? "").trim();
    return this._setMeta(id, { name: clean === label ? "" : clean }, origin);
  }

  setPartColor(id, color, origin = "visual") {
    return this._setMeta(id, { color: color || "" }, origin);
  }

  // ── Models ─────────────────────────────────────────────────────────

  _modelState() {
    return { map: new Map(this.models) };
  }

  // A newly imported model (or an opened GLB, with its bytes): added to the
  // project under a file name no other model has. The first model names an
  // untitled project and gets it a first step.
  addModel(model, { bytes = null, title = "", up = "", origin = "import" } = {}) {
    if (!this._prepareMutation(origin)) return null;
    const next = this.project.clone();
    const taken = [...next.assembly.models, ...this.models.keys()];
    const name = taken.includes(model.name) ? glbNameFor(model.name, taken) : model.name;
    const named = name === model.name ? model : { ...model, name };
    const first = !this.loadedModels().length;
    next.assembly.models.push(name);
    if (title && next.assembly.title === new Project().assembly.title && first) next.assembly.title = title;
    // The first model's up axis is the project's.
    if (first && (up === "y" || up === "z")) next.assembly.up = up;
    let current = this.currentStep;
    if (!next.steps.length) {
      next.steps.push(new Step());
      current = 0;
    }
    const models = this._modelState();
    models.map.set(name, named);
    this._rememberBytes(named, bytes);
    const ok = this._commit(origin, next, { kind: "full" }, { models, currentStep: current });
    return ok ? name : null;
  }

  // Replace models by name (simplify): {name: model}.
  replaceModels(changes, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const models = this._modelState();
    for (const [name, model] of Object.entries(changes)) {
      if (!models.map.has(name)) continue;
      models.map.set(name, model);
    }
    return this._commit(origin, this.project.clone(), { kind: "models" }, { models });
  }

  // Delete nodes (and everything under them) from their models, then every
  // group they leave empty; every reference to a deleted id leaves the project.
  deleteParts(ids, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const models = this._modelState();
    const gone = new Set();
    for (const [name, model] of this.models) {
      let m = model;
      let doomed = ids.filter(id => nodeIndex(m, id) >= 0);
      if (!doomed.length) continue;
      while (doomed.length) {
        for (const id of deletedIds(m, doomed)) gone.add(id);
        m = deleteNodes(m, doomed);
        doomed = m.nodes.filter(n => n.mesh < 0 && !n.children.length).map(n => n.id);
      }
      models.map.set(name, m);
    }
    if (!gone.size) return false;
    const next = this.project.clone();
    const keep = id => !gone.has(id);
    next.parts = next.parts.filter(p => keep(p.id));
    for (const step of next.steps) {
      for (const key of ["show", "hide", "highlight", "ghost"]) step[key] = step[key].filter(keep);
      if (step.camera && step.camera.fit) step.camera = withFit(step.camera, step.camera.fit.filter(keep));
      for (const m of step.moves) m.parts = m.parts.filter(keep);
      step.moves = step.moves.filter(m => m.parts.length);
      for (const a of step.arrows) if (gone.has(a.attach)) a.attach = "";
      for (const l of step.labels) if (gone.has(l.attach)) l.attach = "";
    }
    return this._commit(origin, next, { kind: "full" }, { models, selection: { ...this.selection, parts: this.selection.parts.filter(keep) } });
  }

  // Turn a group into one part with the group's id. References to what was
  // under it now name the group; a step shows the merged part when it showed
  // any part of the group.
  mergeGroup(id, origin = "visual") {
    if (!this._prepareMutation(origin)) return false;
    const name = this.registry.model.get(id);
    const model = name && this.models.get(name);
    if (!model || !this.registry.groups.has(id)) return false;
    const merged = mergeModelGroup(model, id);
    if (merged === model) return false;
    const under = new Set(deletedIds(model, [id]));
    under.delete(id);
    const oldParts = new Set(membersOf(this.registry, id));
    const folds = this.folds();
    const models = this._modelState();
    models.map.set(name, merged);
    const reg = buildRegistry(this.project.assembly.models.filter(n => models.map.has(n)).map(n => models.map.get(n)));
    const next = this.project.clone();
    const swap = list => {
      const out = [];
      for (const x of list) {
        const y = under.has(x) ? id : x;
        if (!out.includes(y)) out.push(y);
      }
      return out;
    };
    next.parts = next.parts.filter(p => !under.has(p.id));
    for (const step of next.steps) {
      step.show = step.show.filter(x => !under.has(x));
      step.hide = step.hide.filter(x => !under.has(x));
      step.highlight = swap(step.highlight);
      step.ghost = swap(step.ghost);
      if (step.camera && step.camera.fit) step.camera.fit = swap(step.camera.fit);
      let seen = false;
      for (const m of step.moves) {
        m.parts = swap(m.parts);
        if (m.parts.includes(id)) {
          if (seen) m.parts = m.parts.filter(x => x !== id);
          seen = true;
        }
      }
      step.moves = step.moves.filter(m => m.parts.length);
      for (const a of step.arrows) if (under.has(a.attach)) a.attach = id;
      for (const l of step.labels) if (under.has(l.attach)) l.attach = id;
    }
    const targets = folds.map(s => {
      const t = new Set([...s].filter(p => !oldParts.has(p)));
      if ([...oldParts].some(p => s.has(p))) t.add(id);
      return t;
    });
    this._applyLists(next, rewriteVisibility(next.steps, next.assembly.start, reg, targets, { from: 0, prefer: [id] }));
    const selection = { ...this.selection, parts: swap(this.selection.parts) };
    return this._commit(origin, next, { kind: "full" }, { models, selection });
  }

  // After Save: these models are on disk as written.
  markModelsSaved(saved) {
    for (const [name, bytes] of Object.entries(saved)) {
      const model = this.models.get(name);
      if (!model) continue;
      this._onDisk.set(name, model);
      this._rememberBytes(model, bytes);
    }
    this.emit("dirty-changed", {});
  }
}

// A step camera with a new fit list: without ids left it keeps only its fov
// and projection, or goes (the step inherits again).
function withFit(cam, fit) {
  if (fit.length) return new CameraSpec({ ...cam, fit });
  if (cam.fov !== null || cam.projection) return new CameraSpec({ fov: cam.fov, projection: cam.projection });
  return null;
}

function vec(v, digits = 4) {
  return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v.map(x => round(x, digits)) : undefined;
}

// Arrow and label fields the loader would reject: an attach that is not a
// valid id (empty means not attached), a kind or a side outside its list, a
// label text with nothing in it. The mutators refuse them rather than hold a
// project whose TOML no longer loads.
function refusedFields(f) {
  if (typeof f.attach === "string" && f.attach !== "" && !isValidId(f.attach)) return true;
  if (typeof f.kind === "string" && !ARROW_KINDS.includes(f.kind)) return true;
  if (typeof f.side === "string" && !LABEL_SIDES.includes(f.side)) return true;
  return typeof f.text === "string" && !f.text.trim();
}

function cleanArrow(f) {
  const out = {};
  if (vec(f.from)) out.from = vec(f.from);
  if (vec(f.to)) out.to = vec(f.to);
  for (const key of ["kind", "color", "label", "attach"]) if (typeof f[key] === "string") out[key] = f[key];
  if (Number.isFinite(f.turns) && f.turns !== 0) out.turns = round(f.turns, 4);
  if (Number.isFinite(f.radius) && f.radius > 0) out.radius = round(f.radius, 4);
  return out;
}

function cleanLabel(f) {
  const out = {};
  if (vec(f.at)) out.at = vec(f.at);
  for (const key of ["side", "attach"]) if (typeof f[key] === "string") out[key] = f[key];
  if (typeof f.text === "string") out.text = f.text.replace(/\r\n?/g, "\n");
  return out;
}

export { allParts };
