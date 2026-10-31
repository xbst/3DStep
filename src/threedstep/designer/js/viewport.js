// The viewport: the viewer runtime (viewer/viewer.js, window.ThreeDStep) in
// editor mode, fed the scene the project makes and the GLB bytes of the
// loaded models, with an overlay toolbar. Chunk 04 wrote the coordinator:
// selection by clicking, the step camera (use the current view, clear), fit,
// play, the style and projection toggles and the preview scheme. The tools
// (chunk 05) live in tools/: the Move and Rotate gizmos (gizmo.js), the
// explode helpers (explode.js), the Arrow, Rotate arrow and Label tools with
// the pick modes behind the inspector's buttons (annotate.js), and the camera
// helpers with the axis triad (camera.js). They plug in through
// registerTool(), addButton() and the toolbar groups; see the Tools section.
//
// Keys (main.js hands them to keyDown when no field has focus): G move,
// R rotate, A arrow, Shift+A rotate arrow, L label, F fit the view, Escape
// cancels the tool's action or returns to Select; Delete is main.js's.
//
// The viewer reads its colors from CSS variables on its root, so the theme's
// tokens (bridge.theme_tokens) are set on the viewer element. The designer is
// a dark UI: <html data-theme> picks the palette the preview shows (dark by
// default, light on request), which is also what the viewer's own scheme
// detection reads.

import { GizmoTools } from "./tools/gizmo.js";
import { ExplodeTools } from "./tools/explode.js";
import { AnnotateTools } from "./tools/annotate.js";
import { CameraTools } from "./tools/camera.js";

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
export const ICONS = {
  select: `<svg ${SVG}><path d="M5 3l14 8-6 2-2 6z"/></svg>`,
  move: `<svg ${SVG}><path d="M12 2v20M2 12h20"/><path d="M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/></svg>`,
  rotate: `<svg ${SVG}><path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 3v5h-5"/><circle cx="12" cy="12" r="1.5"/></svg>`,
  fit: `<svg ${SVG}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>`,
  camera: `<svg ${SVG}><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  clear: `<svg ${SVG}><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  play: `<svg ${SVG}><path d="M7 4l12 8-12 8z"/></svg>`,
  reset: `<svg ${SVG}><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
  style: `<svg ${SVG}><circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>`,
  projection: `<svg ${SVG}><path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>`,
  scheme: `<svg ${SVG}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`,
};

// [behavior] keys (bridge) -> the viewer's behavior overrides that matter in
// editor mode.
const BEHAVIOR_KEYS = { edge_width: "edgeWidth", edge_angle: "edgeAngle", arrow_scale: "arrowScale", transition_ms: "transitionMs", play_ms: "playMs" };

const SCHEME_KEY = "threedstep-designer-preview-scheme";

export class Viewport {
  constructor(el, state) {
    this.el = el;
    this.state = state;
    this.viewer = null;
    this.tools = new Map();
    this.activeTool = "select";
    this._listeners = { pick: [], camera: [], ready: [] };
    this._themeTokens = null;
    this._behavior = {};
    this._hadModels = false;
    this._camSig = "";
    this._loading = 0;
    // Set by the annotation tools, which implement pickPoint() for the
    // inspector's "pick" buttons.
    this.canPickPoints = false;
    try { this.scheme = localStorage.getItem(SCHEME_KEY) === "light" ? "light" : "dark"; } catch (e) { this.scheme = "dark"; }
    document.documentElement.setAttribute("data-theme", this.scheme);

    el.innerHTML =
      `<div class="vp-viewer" id="vp-viewer"></div>` +
      `<div class="vp-toolbar" id="vp-toolbar" role="toolbar" aria-label="Viewport tools">` +
      `<div class="vp-group" data-group="tools"></div>` +
      `<div class="vp-group" data-group="explode"></div>` +
      `<div class="vp-group" data-group="annotate"></div>` +
      `<div class="vp-group" data-group="view"></div>` +
      `<div class="vp-group" data-group="camera"></div>` +
      `</div>` +
      `<div class="vp-empty" id="vp-empty">` +
      `<h2>Start with a model</h2>` +
      `<p>Import a STEP or GLB file, or open a saved project (its TOML with the GLB files beside it). You can also drop the files here.</p>` +
      `<div class="vp-empty-actions"><button class="toolbar-btn primary" data-act="import">Import model</button>` +
      `<button class="toolbar-btn" data-act="open">Open project</button></div>` +
      `</div>` +
      `<div class="vp-busy" id="vp-busy" hidden></div>` +
      `<div class="vp-prompt" id="vp-prompt" role="status" hidden></div>` +
      `<div class="vp-readout" id="vp-readout" aria-live="off" hidden></div>` +
      `<div class="vp-drop">Drop STEP, GLB or project files</div>`;
    this.viewerEl = el.querySelector("#vp-viewer");
    this.toolbar = el.querySelector("#vp-toolbar");
    this.emptyEl = el.querySelector("#vp-empty");
    this.busyEl = el.querySelector("#vp-busy");
    this.promptEl = el.querySelector("#vp-prompt");
    this.readoutEl = el.querySelector("#vp-readout");
    this.groups = {};
    for (const g of this.toolbar.querySelectorAll(".vp-group")) this.groups[g.dataset.group] = g;

    this._buildToolbar();
    this._buildTools();
    this._bindState();
    this._create();
  }

  // The tools of chunk 05, in their toolbar groups. They read the viewer's
  // editor hooks lazily (the viewer exists after _create, and is recreated on
  // a theme change: they listen to "ready").
  _buildTools() {
    this.gizmo = new GizmoTools(this);
    this.registerTool("move", this.gizmo.tool("translate"), { label: "Move", title: "Move the selection (G): drag the gizmo's arrows or planes; Shift snaps to 1 mm", icon: ICONS.move });
    this.registerTool("rotate", this.gizmo.tool("rotate"), { label: "Rotate", title: "Rotate the selection about its center (R): drag the gizmo's rings; Shift snaps to 5°", icon: ICONS.rotate });
    this.explode = new ExplodeTools(this);
    this.annotate = new AnnotateTools(this);
    this.cameraTools = new CameraTools(this);
    // Labels (and arrows, by their tail label) are selected by clicking them.
    this.viewerEl.addEventListener("click", (e) => {
      const label = e.target.closest && e.target.closest(".tds-label");
      if (!label) return;
      if (label.dataset.tdsLabel !== undefined) this.state.setSelection({ label: Number(label.dataset.tdsLabel) });
      else if (label.dataset.tdsArrow !== undefined) this.state.setSelection({ arrow: Number(label.dataset.tdsArrow) });
    });
  }

  // ── Toolbar ────────────────────────────────────────────────────────

  // A button in a toolbar group: {id, label, title, icon, onClick, group}.
  // Returns the button; chunk 05 adds its tools this way too.
  addButton({ id, label = "", title = "", icon = "", onClick, group = "view", showLabel = true }) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "vp-btn";
    if (id) b.dataset.id = id;
    b.title = title || label;
    b.setAttribute("aria-label", title || label);
    b.innerHTML = icon + (label && showLabel ? `<span class="vp-label">${label}</span>` : "");
    if (onClick) b.addEventListener("click", onClick);
    (this.groups[group] || this.groups.view).appendChild(b);
    return b;
  }

  _buildToolbar() {
    this.registerTool("select", {}, { label: "Select", title: "Select parts: click a part, Shift+click to add or remove, Alt+click for its group, click empty space to clear", icon: ICONS.select });
    this.btnFit = this.addButton({ id: "fit", label: "Fit", title: "Fit the view to the selection, or to everything shown", icon: ICONS.fit, onClick: () => this.fit() });
    this.btnPlay = this.addButton({ id: "play", label: "Play", title: "Play this step's moves (again: back to the start)", icon: ICONS.play, onClick: () => this.play() });
    this.btnStyle = this.addButton({ id: "style", title: "Switch the project between line art and shaded", icon: ICONS.style, showLabel: false, onClick: () => this.setStyle(this.state.project.assembly.style === "lineart" ? "shaded" : "lineart") });
    this.btnProj = this.addButton({ id: "projection", title: "Switch the view between orthographic and perspective (Use view stores it in the step)", icon: ICONS.projection, showLabel: false, onClick: () => this.setProjection(this.getProjection() === "perspective" ? "orthographic" : "perspective") });
    this.btnScheme = this.addButton({ id: "scheme", title: "Preview the page's light or dark palette", icon: ICONS.scheme, showLabel: false, onClick: () => this.setScheme(this.scheme === "dark" ? "light" : "dark") });
    this.camState = document.createElement("span");
    this.camState.className = "vp-camera-state";
    this.groups.camera.appendChild(this.camState);
    this.btnUseView = this.addButton({ id: "use-view", group: "camera", label: "Use view", title: "Use the current view as this step's camera", icon: ICONS.camera, onClick: () => this.useCurrentView() });
    this.btnClearCam = this.addButton({ id: "clear-camera", group: "camera", label: "Clear", title: "Clear this step's camera: it inherits the previous step's again", icon: ICONS.clear, onClick: () => this.clearStepCamera() });
    this.el.querySelector('[data-act="import"]').addEventListener("click", () => document.getElementById("import-input").click());
    this.el.querySelector('[data-act="open"]').addEventListener("click", () => document.getElementById("open-input").click());
    this._refreshToolbar();
  }

  _refreshToolbar() {
    const step = this.state.step();
    const hasStep = !!step;
    const hasModels = this.state.loadedModels().length > 0;
    this.emptyEl.hidden = hasModels || this.state.missingModels().length > 0;
    for (const b of [this.btnFit, this.btnPlay, this.btnUseView, this.btnProj]) b.disabled = !hasModels;
    this.btnUseView.disabled = !hasModels || !hasStep;
    this.btnClearCam.disabled = !hasStep || !step.camera;
    const moved = hasStep && step.moves.length > 0;
    this.btnPlay.disabled = !hasModels || !moved;
    const played = this.viewerEl.classList.contains("is-played");
    this.btnPlay.innerHTML = (played ? ICONS.reset : ICONS.play) + `<span class="vp-label">${played ? "Reset" : "Play"}</span>`;
    this.btnStyle.classList.toggle("active", this.state.project.assembly.style === "shaded");
    this.btnProj.classList.toggle("active", this.getProjection() === "perspective");
    this.btnScheme.classList.toggle("active", this.scheme === "light");
    for (const [name, tool] of this.tools) if (name !== "select" && tool.button) tool.button.disabled = !hasModels;
    if (!hasModels && this.activeTool !== "select") this.setTool("select");
    let cam = "Camera: none";
    if (hasStep) {
      if (!step.camera) cam = this.state.currentStep === 0 ? (this.state.project.camera ? "Camera: home view" : "Camera: auto-fit") : "Camera: inherited";
      else if (step.camera.position) cam = "Camera: this step's";
      else if (step.camera.fit) cam = `Camera: fit ${step.camera.fit.length} id${step.camera.fit.length === 1 ? "" : "s"}`;
      else cam = "Camera: inherited (own fov)";
    }
    this.camState.textContent = cam;
  }

  // ── The viewer ─────────────────────────────────────────────────────

  _modelBytes() {
    const out = {};
    for (const model of this.state.loadedModels()) {
      try {
        out[model.name] = this.state.glbBytes(model.name);
      } catch (e) {
        console.error(`3DStep designer: could not write ${model.name}`, e);
      }
    }
    return out;
  }

  _create(camera = null) {
    if (this.viewer) this.viewer.dispose();
    if (!window.ThreeDStep) {
      this.viewerEl.innerHTML = '<div class="vp-empty"><p>The viewer runtime (viewer/viewer.js) did not load.</p></div>';
      return;
    }
    const models = this._modelBytes();
    this._hadModels = Object.keys(models).length > 0;
    this._setBusy(this._hadModels ? "Loading the models…" : "");
    // While the designer drives the viewer (start, setScene, setModels) its
    // step changes are echoes, not the user's: only the viewer's own keys and
    // buttons change the current step.
    this._driving = true;
    this.viewer = window.ThreeDStep.createViewer(this.viewerEl, {
      scene: this.state.project.toScene(),
      models,
      editor: true,
      initialStep: Math.max(0, this.state.currentStep),
      behavior: this._behavior,
      reducedMotion: false,
      onReady: (v) => {
        if (this._sceneDirty) v.setScene(this.state.project.toScene(), { keepCamera: true });
        this._sceneDirty = false;
        this._driving = false;
        this._setBusy("");
        this._syncStep();
        v.setSelection(this.state.selection.parts);
        if (v.editor) v.editor.setAnnotationSelection(this.state.selection);
        if (camera) v.setCamera(camera);
        this._camSig = this._cameraSignature();
        this._refreshToolbar();
        this._emit("ready", v);
      },
      onError: (e) => {
        this._driving = false;
        this._setBusy("");
        console.error("3DStep designer: the viewer failed", e);
      },
      onPick: (hit, event) => this._onPick(hit, event),
      onCamera: (cam) => this._emit("camera", cam),
      onStep: (index) => {
        if (!this._driving && index !== this.state.currentStep) this.state.setCurrentStep(index, "viewport");
        this._refreshToolbar();
      },
    });
    if (this.viewer.ready) this._driving = false;
    // The played state lives on the viewer root; follow it for the Play button.
    if (!this._playObserver) {
      this._playObserver = new MutationObserver(() => this._refreshToolbar());
      this._playObserver.observe(this.viewerEl, { attributes: true, attributeFilter: ["class"] });
    }
  }

  _setBusy(text) {
    this.busyEl.hidden = !text;
    this.busyEl.textContent = text;
  }

  // What decides the current step's camera: the home view and every step
  // camera up to it. When it changes (TOML edits, Clear, undo), the view
  // follows; otherwise edits keep the camera where the user put it.
  _cameraSignature() {
    const p = this.state.project;
    const c = Math.max(0, this.state.currentStep);
    return JSON.stringify([p.camera, p.steps.slice(0, c + 1).map(s => s.camera), p.assembly.up]);
  }

  // Show the state's current step (a step change shows that step's camera).
  _syncStep() {
    const i = this.state.currentStep;
    if (!this.viewer || i < 0 || this.viewer.getStep() === i) return;
    this._driving = true;
    try {
      this.viewer.goToStep(i, { animate: false });
    } finally {
      this._driving = false;
    }
  }

  _bindState() {
    const st = this.state;
    st.on("project-changed", ({ origin }) => {
      if (!this.viewer || !this.viewer.ready) {
        this._sceneDirty = true;
        this._refreshToolbar();
        return;
      }
      const sig = this._cameraSignature();
      const keepCamera = sig === this._camSig || origin === "viewport";
      this._camSig = sig;
      this._driving = true;
      try {
        this.viewer.setScene(st.project.toScene(), { keepCamera });
        if (st.project.assembly.style !== this.viewer.getStyle()) this.viewer.setStyle(st.project.assembly.style);
      } finally {
        this._driving = false;
      }
      this._syncStep();
      this._refreshToolbar();
    });
    st.on("models-changed", () => this._reloadModels());
    st.on("step-changed", ({ origin }) => {
      if (this.viewer && this.viewer.ready && origin !== "viewport") {
        this._camSig = this._cameraSignature();
        this._syncStep();
      }
      this._refreshToolbar();
    });
    st.on("selection-changed", ({ selection }) => {
      if (!this.viewer) return;
      this.viewer.setSelection(selection.parts);
      if (this.viewer.editor) this.viewer.editor.setAnnotationSelection(selection);
    });
  }

  async _reloadModels() {
    if (!this.viewer) return;
    const models = this._modelBytes();
    const first = !this._hadModels && Object.keys(models).length > 0;
    this._hadModels = Object.keys(models).length > 0;
    const token = ++this._loading;
    this._setBusy(this._hadModels ? "Loading the models…" : "");
    this._refreshToolbar();
    if (!this.viewer.ready) {
      // The first load has not finished: start over with the new models.
      this._create();
      return;
    }
    this._driving = true;
    try {
      await this.viewer.setModels(models);
    } finally {
      this._driving = false;
    }
    if (token !== this._loading) return;
    this._setBusy("");
    this._driving = true;
    try {
      // The scene may have changed while the models loaded; a first model is
      // framed by the step's camera rather than the empty scene's.
      this.viewer.setScene(this.state.project.toScene(), { keepCamera: !first });
    } finally {
      this._driving = false;
    }
    this._syncStep();
    this.viewer.setSelection(this.state.selection.parts);
    this._camSig = this._cameraSignature();
    this._refreshToolbar();
  }

  _onPick(hit, event) {
    const tool = this.tools.get(this.activeTool);
    if (tool && tool.onPick && tool.onPick(hit, event) === true) return;
    for (const fn of this._listeners.pick) if (fn(hit, event) === true) return;
    if (!hit) {
      if (!event.shiftKey) this.state.clearSelection();
      return;
    }
    // An explicit arrow of the step (the viewer picks them in editor mode).
    if (hit.arrow !== undefined && hit.arrow !== null) {
      this.state.setSelection({ arrow: hit.arrow });
      return;
    }
    let id = hit.id;
    if (event.altKey) id = this.state.registry.parent.get(id) || id;
    this.state.selectParts([id], event.shiftKey || event.ctrlKey || event.metaKey ? "toggle" : "replace");
  }

  // ── Actions ────────────────────────────────────────────────────────

  // The current view becomes the current step's camera.
  useCurrentView() {
    const cam = this.getCamera();
    if (!cam || this.state.currentStep < 0) return false;
    return this.state.setStepCamera(this.state.currentStep, cam, "viewport");
  }

  // The current step inherits the previous step's camera again.
  clearStepCamera() {
    if (this.state.currentStep < 0) return false;
    return this.state.setStepCamera(this.state.currentStep, null, "visual");
  }

  // The current view becomes the home view ([camera]); null clears it.
  useViewAsHome() {
    const cam = this.getCamera();
    return cam ? this.state.setCamera(cam, "viewport") : false;
  }

  // Frame ids (default: the selection, else everything the step shows).
  fit(ids) {
    if (!this.viewer) return;
    let list = ids || this.state.selection.parts;
    if (!list || !list.length) {
      const state = this.viewer.getState();
      list = state ? Object.keys(state.visible) : null;
    }
    this.viewer.fit(list && list.length ? list : null);
  }

  // Play the step's moves; a second press puts them back.
  play() {
    if (!this.viewer) return;
    if (this.viewerEl.classList.contains("is-played")) this.viewer.reset();
    else this.viewer.play();
  }

  // The project's style (undoable), which the viewport follows.
  setStyle(style) {
    return this.state.setAssembly({ style }, "visual");
  }

  // The live view's projection; "Use view" stores it in the step.
  setProjection(projection) {
    if (!this.viewer) return;
    this.viewer.setProjection(projection);
    this._refreshToolbar();
  }

  getProjection() {
    return this.viewer && this.viewer.ready ? this.viewer.getProjection() : "orthographic";
  }

  getCamera() {
    return this.viewer ? this.viewer.getCamera() : null;
  }

  setCamera(cam, opts) {
    if (this.viewer) this.viewer.setCamera(cam, opts);
  }

  // The preview's palette: the theme's dark (default) or light colors.
  setScheme(scheme) {
    this.scheme = scheme === "light" ? "light" : "dark";
    try { localStorage.setItem(SCHEME_KEY, this.scheme); } catch (e) { /* storage blocked */ }
    document.documentElement.setAttribute("data-theme", this.scheme);
    this._applyTokens();
    this._refreshToolbar();
  }

  // The theme's palettes and behaviors ({light, dark, behavior}, from
  // bridge.theme_tokens, or the viewer's defaults before the renderer runs).
  setTheme(tokens) {
    this._themeTokens = tokens;
    const behavior = {};
    for (const [key, name] of Object.entries(BEHAVIOR_KEYS)) {
      if (tokens && tokens.behavior && tokens.behavior[key] !== undefined) behavior[name] = tokens.behavior[key];
    }
    this._applyTokens();
    if (JSON.stringify(behavior) !== JSON.stringify(this._behavior)) {
      this._behavior = behavior;
      // Behaviors are read when the viewer starts: start it again, same view.
      if (this.viewer) this._create(this.viewer.ready ? this.viewer.getCamera() : null);
    }
  }

  _applyTokens() {
    const t = this._themeTokens;
    const palette = (t && t[this.scheme]) || (window.ThreeDStep && window.ThreeDStep.defaults[this.scheme]) || {};
    // Every token is set on the viewer root, so none falls back to the
    // designer's own variables of the same name (--bg, --text, --accent).
    for (const [name, value] of Object.entries(palette)) this.viewerEl.style.setProperty(`--${name}`, value);
    if (this.viewer) this.viewer.refreshTheme();
  }

  resize() {
    if (this.viewer) this.viewer.resize();
  }

  // ── Tools (the hooks chunk 05 extends) ─────────────────────────────
  //
  // A tool is an object with any of:
  //   activate(viewport) / deactivate(viewport)  when it becomes (in)active
  //   onPick(hit, event)   every click without a drag ({id, point, normal,
  //                        distance} or null); return true when handled, and
  //                        the click does not change the selection
  //   onCamera(cam)        after every orbit, zoom or pan
  //   onKeyDown(event)     keys while the tool is active; return true when handled
  //   cancel()             Escape: leave the tool's current action
  // registerTool(name, tool, {label, title, icon, group}) adds its button to a
  // toolbar group ("tools", "explode", "annotate", "view", "camera").
  // Listeners that are not tools: on("pick" | "camera" | "ready", fn).

  registerTool(name, tool, { label = name, title = "", icon = "", group = "tools" } = {}) {
    const button = this.addButton({ id: `tool-${name}`, label, title, icon, group, onClick: () => this.setTool(name) });
    this.tools.set(name, Object.assign(tool, { button }));
    if (name === this.activeTool) button.classList.add("active");
    return button;
  }

  setTool(name) {
    if (!this.tools.has(name) || name === this.activeTool) return;
    const prev = this.tools.get(this.activeTool);
    if (prev && prev.deactivate) prev.deactivate(this);
    if (prev && prev.button) prev.button.classList.remove("active");
    this.activeTool = name;
    const next = this.tools.get(name);
    if (next.button) next.button.classList.add("active");
    if (next.activate) next.activate(this);
  }

  getTool() {
    return this.activeTool;
  }

  // Escape: the active tool cancels what it is doing, or the select tool
  // clears the selection. Returns true when something was cancelled.
  cancelTool() {
    const tool = this.tools.get(this.activeTool);
    if (this.activeTool !== "select") {
      if (tool && tool.cancel && tool.cancel() === true) return true;
      this.setTool("select");
      return true;
    }
    return this.state.clearSelection();
  }

  // Keys while no field has focus: the active tool first, then the tool
  // shortcuts (G, R, A, Shift+A, L) and F (fit the view). True when handled.
  keyDown(event) {
    const tool = this.tools.get(this.activeTool);
    if (tool && tool.onKeyDown && tool.onKeyDown(event) === true) return true;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const hasModels = this.state.loadedModels().length > 0;
    if (key === "f" && !event.shiftKey) {
      if (hasModels) this.fit();
      return hasModels;
    }
    const name = key === "g" && !event.shiftKey ? "move"
      : key === "r" && !event.shiftKey ? "rotate"
      : key === "a" ? (event.shiftKey ? "rotate-arrow" : "arrow")
      : key === "l" && !event.shiftKey ? "label" : null;
    if (!name || !this.tools.has(name) || !hasModels) return false;
    this.setTool(name);
    return true;
  }

  // Text the active tool asks the user for (empty hides it).
  setPrompt(text) {
    this.promptEl.hidden = !text;
    this.promptEl.textContent = text || "";
  }

  // A value readout beside the pointer (client coordinates) while dragging.
  showReadout(text, clientX, clientY) {
    const r = this.el.getBoundingClientRect();
    this.readoutEl.hidden = false;
    this.readoutEl.textContent = text;
    const x = Math.min(Math.max(8, clientX - r.left + 18), r.width - 8 - this.readoutEl.offsetWidth);
    const y = Math.min(Math.max(8, clientY - r.top + 18), r.height - 8 - this.readoutEl.offsetHeight);
    this.readoutEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  hideReadout() {
    this.readoutEl.hidden = true;
  }

  on(event, fn) {
    if (this._listeners[event]) this._listeners[event].push(fn);
  }

  _emit(event, data) {
    if (event === "camera") {
      const tool = this.tools.get(this.activeTool);
      if (tool && tool.onCamera) tool.onCamera(data);
    }
    for (const fn of this._listeners[event] || []) fn(data);
  }

  // A point picked in the viewport for the inspector's "pick" buttons:
  // resolves to a hit {id, point, normal} (model space) or null on Escape.
  pickPoint(opts) {
    if (!this.annotate) return Promise.reject(new Error("the viewport tools are not ready"));
    return this.annotate.pickPoint(opts || {});
  }

  // Parts picked one by one until Escape: {prompt, onPick(id, hit), onDone}.
  pickParts(opts) {
    if (this.annotate) this.annotate.pickParts(opts || {});
  }
}
