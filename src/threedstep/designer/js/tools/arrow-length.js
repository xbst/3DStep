// The length handle of a straight arrow under the Move tool: a dot on the
// arrow's tail that drags along the arrow's line while the head stays where
// it is (placement.withLength). The gizmo puts it on the arrow it sits on
// (show) and takes it off (hide). Pressing the dot starts its own drag ahead
// of the viewer, the orbit and the gizmo: in steps of 1 mm, freely with Alt,
// previewed by the viewer (editor.previewArrow) with a readout, and committed
// on release as one state.updateArrow of the tail, unless the project or the
// step changed meanwhile. Escape (cancel) puts the arrow back.

import { closestPointOnLine, placePoint, roundTo, snapValue, unplacePoint, vdot, vlen, vnorm, vscale, vsub } from "./geometry.js";
import { arrowLength, withLength } from "./placement.js";

const MIN_MM = 0.5;

export class ArrowLength {
  constructor(gizmo, snapMM) {
    this.g = gizmo;
    this.vp = gizmo.vp;
    this.state = gizmo.state;
    this.snapMM = snapMM;
    this.arrow = null;       // the arrow it is on: {index, item, pl}
    this.mesh = null;        // the dot, in the viewer's overlay
    this.drag = null;        // the drag in progress: {head, dir, length, from, project, step, pointerId}
    this.hover = false;
    const el = this.vp.viewerEl;
    // Capture phase on the viewer's element: a press on the dot never reaches
    // the canvas, so neither the orbit, the gizmo nor a pick starts.
    el.addEventListener("pointerdown", (e) => this._down(e), { capture: true });
    el.addEventListener("pointermove", (e) => this._move(e), { capture: true });
    el.addEventListener("pointerup", (e) => this._up(e), { capture: true });
    el.addEventListener("pointercancel", () => this.cancel(), { capture: true });
    this.vp.on("camera", () => this._place());
  }

  get dragging() {
    return !!this.drag;
  }

  // Put the dot on a straight arrow ({index, item, pl}), or hide it (null).
  show(arrow) {
    this.arrow = arrow && arrow.item.kind !== "rotate" && arrowLength(arrow.item) > 1e-9 ? arrow : null;
    this._place();
  }

  hide() {
    this.cancel();
    this.show(null);
  }

  // The viewer was recreated: its overlay went with the old one.
  reset() {
    this.drag = null;
    this.mesh = null;
    this._setHover(false);
  }

  // The displayed tail and head, and the unit direction from tail to head.
  _ends(item = this.arrow.item) {
    const tail = placePoint(this.arrow.pl, item.from), head = placePoint(this.arrow.pl, item.to);
    return { tail, head, dir: vnorm(vsub(head, tail)) };
  }

  _ensureMesh() {
    const viewer = this.vp.viewer;
    if (!viewer || !viewer.editor || !window.THREE) return null;
    if (this.mesh && this.mesh.parent) return this.mesh;
    const THREE = window.THREE;
    const color = new THREE.Color();
    try { color.setStyle(getComputedStyle(this.vp.viewerEl).getPropertyValue("--accent").trim() || "#60a5fa"); } catch (e) { color.set(0x60a5fa); }
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
    this.mesh.name = "arrow-length-handle";
    this.mesh.renderOrder = 11;
    viewer.editor.overlay().add(this.mesh);
    return this.mesh;
  }

  // The dot's radius: a share of the gizmo's size, so it keeps its size on screen.
  _radius(point) {
    const scale = this.g.screenScale(point);
    return scale ? scale * 0.06 : 1;
  }

  // Show the dot at the tail the arrow has now (or the drag gives it).
  _place() {
    const viewer = this.vp.viewer;
    if (!this.arrow || !viewer || !viewer.ready) {
      if (this.mesh && this.mesh.visible) { this.mesh.visible = false; if (viewer && viewer.editor) viewer.editor.requestRender(); }
      return;
    }
    const mesh = this._ensureMesh();
    if (!mesh) return;
    const tail = this.drag ? this.drag.tail : this._ends().tail;
    mesh.position.set(tail[0], tail[1], tail[2]);
    mesh.scale.setScalar(this._radius(tail) * (this.hover || this.drag ? 1.35 : 1));
    mesh.visible = true;
    viewer.editor.requestRender();
  }

  // Is the dot under the pointer: the pointer ray passes within its radius
  // (a little more, to be easy to grab), in front of the camera.
  _hits(e) {
    const ed = this.vp.viewer && this.vp.viewer.editor;
    if (!this.arrow || !ed || !this.mesh || !this.mesh.visible) return false;
    const ray = ed.ray(e.clientX, e.clientY);
    if (!ray) return false;
    const c = this.mesh.position.toArray();
    const w = vsub(c, ray.origin), t = vdot(w, ray.direction);
    if (t < 0) return false;
    return vlen(vsub(w, vscale(ray.direction, t))) <= this.mesh.scale.x * 1.6;
  }

  _setHover(on) {
    if (on === this.hover) return;
    this.hover = on;
    this.vp.viewerEl.style.cursor = on ? "grab" : "";
    this._place();
  }

  _down(e) {
    if (e.button !== 0 || this.drag || !this._hits(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const { tail, head, dir } = this._ends();
    this.drag = { tail, head, dir, length: arrowLength(this.arrow.item), from: null,
      project: this.state.project, step: this.state.currentStep, pointerId: e.pointerId };
    try { this.vp.viewerEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    this.vp.el.classList.add("is-dragging");
    this.vp.viewerEl.style.cursor = "grabbing";
    this._place();
  }

  _move(e) {
    if (!this.drag) {
      if (!this.arrow || this.g.dragging || e.buttons) return;
      const hit = this._hits(e);
      this._setHover(hit);
      // Over the dot, the gizmo's handles (whose X pick zone may run along
      // the arrow past its tail) do not light up: the press is the dot's.
      if (hit) {
        e.stopPropagation();
        const tc = this.g.tc;
        if (tc && tc.axis) { tc.axis = null; this.vp.viewer.editor.requestRender(); }
      }
      return;
    }
    const ed = this.vp.viewer && this.vp.viewer.editor;
    const ray = ed && ed.ray(e.clientX, e.clientY);
    if (!ray) return;
    const d = this.drag;
    // The point of the arrow's line nearest the pointer ray: its distance
    // behind the head is the length.
    const p = closestPointOnLine(d.head, d.dir, ray);
    let length = vdot(vsub(d.head, p), d.dir);
    if (!e.altKey) length = snapValue(length, this.snapMM);
    length = Math.max(length, e.altKey ? MIN_MM : this.snapMM);
    const next = withLength(this.arrow.item, length);
    if (!next) return;
    d.length = length;
    d.from = next.from;
    d.tail = vsub(d.head, vscale(d.dir, length));
    ed.previewArrow(this.arrow.index, next);
    this._place();
    const how = e.altKey ? " · free" : ` · ${this.snapMM} mm steps (Alt: free)`;
    this.vp.showReadout(`Length ${length.toFixed(1)} mm${how}`, e.clientX, e.clientY);
  }

  _up(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    this._end();
    const arrow = this.arrow;
    if (!d.from || d.project !== this.state.project || d.step !== this.state.currentStep) {
      if (this.vp.viewer && this.vp.viewer.editor) this.vp.viewer.editor.previewArrow(arrow.index, null);
      this._place();
      return;
    }
    const from = d.from.map((v) => roundTo(v, 3));
    if (!this.state.updateArrow(arrow.index, { from }, "viewport")) {
      this.vp.viewer.editor.previewArrow(arrow.index, null);
      this._place();
    }
  }

  // Leave the drag in progress, the arrow where it was. True when there was one.
  cancel() {
    if (!this.drag) return false;
    this._end();
    const ed = this.vp.viewer && this.vp.viewer.editor;
    if (ed && this.arrow) ed.previewArrow(this.arrow.index, null);
    this._place();
    return true;
  }

  _end() {
    const d = this.drag;
    this.drag = null;
    try { this.vp.viewerEl.releasePointerCapture(d.pointerId); } catch (err) { /* ignore */ }
    this.vp.el.classList.remove("is-dragging");
    this.vp.viewerEl.style.cursor = this.hover ? "grab" : "";
    this.vp.hideReadout();
  }

  // For the browser tests: the client coordinates of the dot.
  handleScreen() {
    const ed = this.vp.viewer && this.vp.viewer.editor;
    if (!this.arrow || !ed || !this.mesh || !this.mesh.visible) return null;
    return ed.project(this.mesh.position.toArray());
  }
}
