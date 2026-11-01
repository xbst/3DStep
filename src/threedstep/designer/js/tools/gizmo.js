// The Move and Rotate tools: Three.js's TransformControls attached to a pivot
// at the selection's displayed center. One part or many: many move as a rigid
// group about their combined center, and each gets the move that shows it
// there (geometry.composePlacement). While dragging, the viewer previews the
// placements (previewPlacement, no scene rebuild); on release one
// state.setMoves commits them (one undo step per drag); Escape mid-drag puts
// the parts back. Shift snaps to 1 mm and 5 degrees; a readout follows the
// pointer.

import { DEG, composePlacement, isIdentityQuat, isZero, quatAxisAngle, roundTo, snapQuat, snapVector, vdot, vsub } from "./geometry.js";
import { mergeEntries, pivotOf, unitsFor } from "./placement.js";

export const SNAP_MM = 1;
export const SNAP_DEG = 5;

const fmt1 = (v) => (Math.abs(v) < 0.05 ? "0" : v.toFixed(1));

export class GizmoTools {
  constructor(viewport) {
    this.vp = viewport;
    this.state = viewport.state;
    this.tc = null;          // the TransformControls
    this.helper = null;      // its drawable
    this.pivot = null;       // the Object3D it drives
    this.mode = null;        // "translate" | "rotate" while a tool is active
    this.units = [];
    this.P = null;           // the pivot's start position for the drag in progress
    this.dragging = false;
    this.shift = false;
    this.last = null;        // {translate, rotate, results} of the drag in progress
    this.pointer = { x: 0, y: 0 };
    viewport.on("ready", () => this._rebuild());
    viewport.on("camera", () => { if (this.tc && this.vp.viewer && this.vp.viewer.editor) this.tc.camera = this.vp.viewer.editor.camera(); });
    for (const ev of ["selection-changed", "project-changed", "step-changed", "models-changed"]) {
      this.state.on(ev, () => { if (this.mode && !this.dragging) this._attach(); });
    }
    window.addEventListener("keydown", (e) => { if (e.key === "Shift") this._setShift(true); });
    window.addEventListener("keyup", (e) => { if (e.key === "Shift") this._setShift(false); });
    window.addEventListener("blur", () => this._setShift(false));
    // Capture phase: before the controls' own pointermove handler, so the
    // Shift state of the event itself is what that handler's drag uses.
    viewport.viewerEl.addEventListener("pointermove", (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      if (e.shiftKey !== this.shift) this._setShift(e.shiftKey);
    }, { passive: true, capture: true });
  }

  // The tool object for registerTool: mode "translate" (Move) or "rotate".
  tool(mode) {
    return {
      activate: () => { this.mode = mode; this._attach(); },
      deactivate: () => { this.mode = null; this._detach(); },
      // A click on a gizmo handle is the gizmo's: it must not change the selection.
      onPick: () => !!(this.tc && (this.tc.dragging || this.tc.axis)),
      // Escape mid-drag puts the parts back and keeps the tool; else it leaves.
      cancel: () => {
        if (!this._abortDrag()) return false;
        this._attach();
        return true;
      },
    };
  }

  // Lazily create the controls once the viewer (and its editor hooks) exist.
  _ensure() {
    const viewer = this.vp.viewer;
    if (this.tc) return true;
    if (!viewer || !viewer.ready || !viewer.editor || !window.THREE || !window.THREE.TransformControls) return false;
    const ed = viewer.editor;
    const THREE = window.THREE;
    const tc = new THREE.TransformControls(ed.camera(), ed.canvas);
    // The stylesheet gates touch-action (the editor viewport is always active).
    ed.canvas.style.touchAction = "";
    tc.setSpace("world");
    tc.size = 0.85;
    this.pivot = new THREE.Object3D();
    this.pivot.name = "gizmo-pivot";
    ed.overlay().add(this.pivot);
    this.helper = typeof tc.getHelper === "function" ? tc.getHelper() : tc;
    ed.overlay().add(this.helper);
    tc.addEventListener("change", () => ed.requestRender());
    tc.addEventListener("objectChange", () => this._onDrag());
    tc.addEventListener("dragging-changed", (e) => this._onDragging(!!e.value));
    tc.enabled = false;
    this.tc = tc;
    return true;
  }

  // The viewer was recreated (a theme change): start over with its new canvas.
  _rebuild() {
    if (this.tc) {
      this._abortDrag();
      try { this.tc.detach(); this.tc.dispose(); } catch (e) { /* ignore */ }
      this.tc = null;
      this.helper = null;
      this.pivot = null;
    }
    if (this.mode) this._attach();
  }

  _setShift(on) {
    if (this.shift === on) return;
    this.shift = on;
    if (this.dragging) this._onDrag();
  }

  // Put the gizmo on the current selection (or hide it).
  _attach() {
    if (!this._ensure()) return;
    const ids = this.state.selection.parts;
    this.units = ids.length && this.state.currentStep >= 0 ? unitsFor(this.state, ids) : [];
    if (!this.units.length) {
      this._detach();
      return;
    }
    const ed = this.vp.viewer.editor;
    this.P = pivotOf(this.units);
    this.pivot.position.set(this.P[0], this.P[1], this.P[2]);
    this.pivot.quaternion.set(0, 0, 0, 1);
    this.pivot.updateMatrixWorld(true);
    this.tc.camera = ed.camera();
    this.tc.setMode(this.mode);
    this.tc.enabled = true;
    this.tc.attach(this.pivot);
    ed.requestRender();
  }

  _detach() {
    if (!this.tc) return;
    this._abortDrag();
    this.tc.detach();
    this.tc.enabled = false;
    this.vp.viewer.editor.requestRender();
  }

  _onDragging(on) {
    const ed = this.vp.viewer.editor;
    const orbit = ed.controls();
    if (on === this.dragging) return;   // the echo of an aborted drag
    this.dragging = on;
    if (on) {
      this.last = null;
      if (orbit) { this._orbitWas = orbit.enabled; orbit.enabled = false; }
      this.vp.el.classList.add("is-dragging");
    } else {
      if (orbit) orbit.enabled = this._orbitWas !== false;
      this.vp.el.classList.remove("is-dragging");
      this._commit();
    }
  }

  // End the drag in progress without committing it: the parts go back where
  // they were. Escape calls it, and so does anything that detaches the gizmo
  // mid-drag (TransformControls ignores the release once disabled, so its
  // "dragging-changed" would never come). True when there was a drag.
  _abortDrag() {
    if (!this.dragging) return false;
    const orbit = this.vp.viewer.editor.controls();
    this.dragging = false;
    this.last = null;
    if (orbit) {
      // Orbiting resumes once the button is up: the rest of a press that
      // began on a handle must not turn the view.
      const was = this._orbitWas !== false;
      const resume = () => {
        window.removeEventListener("pointerup", resume, true);
        window.removeEventListener("pointercancel", resume, true);
        orbit.enabled = was;
      };
      window.addEventListener("pointerup", resume, true);
      window.addEventListener("pointercancel", resume, true);
    }
    this.vp.el.classList.remove("is-dragging");
    this.vp.hideReadout();
    if (this.P) this._preview([0, 0, 0], [0, 0, 0, 1]);
    // The controls' own drag state too; its "dragging-changed" is ignored above.
    this.tc.dragging = false;
    this.tc.axis = null;
    return true;
  }

  // The delta of the drag in progress: the pivot's position and rotation
  // against where it started, snapped with Shift, previewed on every unit.
  _onDrag() {
    if (!this.dragging || !this.P) return;
    const p = this.pivot.position;
    let translate = vsub([p.x, p.y, p.z], this.P);
    let rotate = [this.pivot.quaternion.x, this.pivot.quaternion.y, this.pivot.quaternion.z, this.pivot.quaternion.w];
    if (this.mode === "translate") rotate = [0, 0, 0, 1];
    else translate = [0, 0, 0];
    if (this.shift) {
      translate = snapVector(translate, SNAP_MM);
      rotate = snapQuat(rotate, SNAP_DEG);
      this.pivot.position.set(this.P[0] + translate[0], this.P[1] + translate[1], this.P[2] + translate[2]);
      this.pivot.quaternion.set(rotate[0], rotate[1], rotate[2], rotate[3]);
    }
    const results = this._preview(translate, rotate);
    this.last = { translate, rotate, results };
    this.vp.showReadout(this._readout(translate, rotate), this.pointer.x, this.pointer.y);
  }

  // Show every unit moved by a delta about the pivot; returns the placements.
  _preview(translate, rotate) {
    const delta = { pivot: this.P, translate, rotate };
    const results = this.units.map((u) => ({ unit: u, next: composePlacement(u.current, delta, u.center) }));
    const viewer = this.vp.viewer;
    for (const r of results) viewer.previewPlacement(r.unit.id, { offset: r.next.offset, rotate: r.next.rotate });
    return results;
  }

  _readout(translate, rotate) {
    if (this.mode === "translate") return `Δ ${translate.map(fmt1).join(", ")} mm${this.shift ? " · snapped" : ""}`;
    const { axis, angle } = quatAxisAngle(rotate);
    const names = ["X", "Y", "Z"];
    let name = "", sign = 1;
    const major = axis.map(Math.abs).indexOf(Math.max(...axis.map(Math.abs)));
    if (Math.abs(axis[major]) > 0.98) {
      name = names[major];
      sign = Math.sign(axis[major]) || 1;
    }
    const deg = angle / DEG * sign;
    return `${fmt1(deg)}°${name ? ` about ${name}` : ""}${this.shift ? " · snapped" : ""}`;
  }

  // Release: one setMoves for the drag, or nothing when nothing moved.
  _commit() {
    const last = this.last;
    this.last = null;
    this.vp.hideReadout();
    if (!last || (isZero(last.translate, 1e-6) && isIdentityQuat(last.rotate, 1e-7))) {
      this._attach();
      return;
    }
    const entries = mergeEntries(last.results.map((r) => ({
      ids: [r.unit.id],
      offset: r.next.offset.map((v) => roundTo(v, 4)),
      rotate: r.next.rotate.map((v) => roundTo(v, 4)),
    })));
    if (!this.state.setMoves(entries, "viewport")) this._attach();
  }

  // For the browser tests: the client coordinates of a translate handle's
  // grab point (the gizmo scales with the view as TransformControlsGizmo does).
  handleScreen(axis = "X") {
    if (!this.tc || !this.P || !this.vp.viewer || !this.vp.viewer.editor) return null;
    const ed = this.vp.viewer.editor;
    const cam = ed.camera();
    let factor;
    if (cam.isOrthographicCamera) factor = (cam.top - cam.bottom) / cam.zoom;
    else factor = Math.hypot(this.P[0] - cam.position.x, this.P[1] - cam.position.y, this.P[2] - cam.position.z) * Math.min(1.9 * Math.tan(Math.PI * cam.fov / 360) / cam.zoom, 7);
    const s = factor * this.tc.size / 4;
    const dir = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[axis] || [1, 0, 0];
    const point = this.P.map((v, k) => v + dir[k] * 0.45 * s);
    const out = ed.project(point);
    return out ? { ...out, world: point, scale: s, along: vdot(dir, dir) } : null;
  }
}
