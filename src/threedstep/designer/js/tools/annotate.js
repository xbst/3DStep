// The annotation tools: Arrow (two clicks on surfaces: tail, then head; Shift
// keeps the head on the tail's surface normal), Rotate arrow (one click: the
// axis is the surface normal, the radius comes from the part's size), Label
// (one click, then type in the inspector field that gets focus), and the pick
// modes behind the inspector's "Pick" buttons and the fit list. Points are
// stored in the picked part's assembled frame (attach), so they travel with
// the part during Play (SPEC 9.7); the inspector can detach them.

import { boxDiagonal, closestPointOnLine, convertAttached, roundTo, vadd, vdot, vlen, vnorm, vscale, vsub } from "./geometry.js";
import { attachPlacement } from "./placement.js";

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
export const ANNOTATE_ICONS = {
  arrow: `<svg ${SVG}><path d="M4 20L18 6"/><path d="M10 5h9v9"/></svg>`,
  rotateArrow: `<svg ${SVG}><path d="M19 12a7 7 0 1 1-2.6-5.4"/><path d="M19 3v5h-5"/></svg>`,
  label: `<svg ${SVG}><path d="M3 12l7-7h11v11l-7 7z"/><circle cx="16" cy="9" r="1.5"/></svg>`,
  pick: `<svg ${SVG}><circle cx="12" cy="12" r="5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>`,
};

const PROMPT_TAIL = "Arrow: click a point on a part for the tail · Esc leaves the tool";
const PROMPT_HEAD = "Arrow: click the head point · Shift keeps it on the tail's surface normal · Esc cancels";
const PROMPT_ROTATE = "Rotate arrow: click a surface; its normal is the axis · Esc leaves the tool";
const PROMPT_LABEL = "Label: click a point on a part, then type its text · Esc leaves the tool";

export class AnnotateTools {
  constructor(viewport) {
    this.vp = viewport;
    this.state = viewport.state;
    this.tail = null;        // the arrow tool's first click: {point, normal, id}
    this.preview = null;     // THREE objects of the rubber-band arrow
    this.pending = null;     // a pick mode: {mode: "point" | "parts", resolve, onPick, prompt, previous}
    this.shift = false;
    this._hoverRaf = 0;
    this._hoverEvent = null;
    viewport.registerTool("arrow", this._arrowTool(), { label: "Arrow", title: "Arrow (A): click the tail point on a part, then the head point; Shift keeps the head on the surface normal", icon: ANNOTATE_ICONS.arrow, group: "annotate" });
    viewport.registerTool("rotate-arrow", this._rotateArrowTool(), { label: "Rotate arrow", title: "Rotate arrow (Shift+A): click a surface; the arrow turns around its normal", icon: ANNOTATE_ICONS.rotateArrow, group: "annotate" });
    viewport.registerTool("label", this._labelTool(), { label: "Label", title: "Label (L): click a point on a part, then type the text", icon: ANNOTATE_ICONS.label, group: "annotate" });
    const pickBtn = viewport.registerTool("pick", this._pickTool(), { label: "Pick", title: "Picking a point", icon: ANNOTATE_ICONS.pick, group: "annotate" });
    pickBtn.hidden = true;
    viewport.canPickPoints = true;
    window.addEventListener("keydown", (e) => { if (e.key === "Shift") this.shift = true; });
    window.addEventListener("keyup", (e) => { if (e.key === "Shift") this.shift = false; });
    viewport.viewerEl.addEventListener("pointermove", (e) => this._queueHover(e), { passive: true });
    viewport.viewerEl.addEventListener("pointerleave", () => this._showPreview(null));
    viewport.on("ready", () => { this.preview = null; });
  }

  // ── Arrow ──────────────────────────────────────────────────────────

  _arrowTool() {
    return {
      activate: () => { this.tail = null; this.vp.setPrompt(PROMPT_TAIL); },
      deactivate: () => { this.tail = null; this._showPreview(null); this.vp.setPrompt(""); },
      onPick: (hit, event) => {
        if (hit && hit.arrow != null) return false;   // selecting an existing arrow
        if (!this.tail) {
          if (!hit || !hit.id) return true;
          this.tail = { point: hit.point.slice(), normal: vnorm(hit.normal), id: hit.id };
          this.vp.setPrompt(PROMPT_HEAD);
          return true;
        }
        const head = this._headFor(hit, event.clientX, event.clientY, event.shiftKey || this.shift);
        if (!head || vlen(vsub(head, this.tail.point)) < 1e-3) return true;
        this._finishArrow(head);
        return true;
      },
      cancel: () => {
        if (!this.tail) return false;
        this.tail = null;
        this._showPreview(null);
        this.vp.setPrompt(PROMPT_TAIL);
        return true;
      },
    };
  }

  // The head point for the pointer: the surface point, or with Shift the
  // point of the tail's normal line nearest to the pointer ray.
  _headFor(hit, clientX, clientY, constrained) {
    if (constrained) {
      const ed = this.vp.viewer && this.vp.viewer.editor;
      if (hit && hit.point) {
        const t = vdot(vsub(hit.point, this.tail.point), this.tail.normal);
        return vadd(this.tail.point, vscale(this.tail.normal, t));
      }
      const ray = ed && ed.ray(clientX, clientY);
      return ray ? closestPointOnLine(this.tail.point, this.tail.normal, ray) : null;
    }
    return hit && hit.point ? hit.point.slice() : null;
  }

  _finishArrow(head) {
    const st = this.state;
    const attach = this.tail.id;
    const pl = attachPlacement(st, attach);
    const [from, to] = convertAttached([this.tail.point, head], null, pl).map((p) => p.map((v) => roundTo(v, 3)));
    this.tail = null;
    this._showPreview(null);
    st.addArrow({ from, to, kind: "straight", attach }, "viewport");
    this.vp.setPrompt(PROMPT_TAIL);
  }

  // ── Rotate arrow ───────────────────────────────────────────────────

  _rotateArrowTool() {
    return {
      activate: () => this.vp.setPrompt(PROMPT_ROTATE),
      deactivate: () => this.vp.setPrompt(""),
      onPick: (hit) => {
        if (hit && hit.arrow != null) return false;
        if (!hit || !hit.id) return true;
        const st = this.state;
        const box = st.bboxOf([hit.id]);
        const radius = roundTo(Math.min(100, Math.max(0.5, (box ? boxDiagonal(box) : 16) / 4)), 1);
        const n = vnorm(hit.normal);
        const pl = attachPlacement(st, hit.id);
        const [from, to] = convertAttached([hit.point, vadd(hit.point, vscale(n, radius))], null, pl).map((p) => p.map((v) => roundTo(v, 3)));
        st.addArrow({ from, to, kind: "rotate", radius, turns: 0.75, attach: hit.id }, "viewport");
        return true;
      },
      cancel: () => false,
    };
  }

  // ── Label ──────────────────────────────────────────────────────────

  _labelTool() {
    return {
      activate: () => this.vp.setPrompt(PROMPT_LABEL),
      deactivate: () => this.vp.setPrompt(""),
      onPick: (hit) => {
        if (hit && hit.arrow != null) return false;
        if (!hit || !hit.id) return true;
        const st = this.state;
        const pl = attachPlacement(st, hit.id);
        const [at] = convertAttached([hit.point], null, pl).map((p) => p.map((v) => roundTo(v, 3)));
        if (st.addLabel({ text: st.displayName(hit.id), at, attach: hit.id }, "viewport")) {
          // The inspector shows the new label: its text field takes the typing.
          const field = document.getElementById("insp-ltext");
          if (field) { field.focus(); field.select(); }
        }
        return true;
      },
      cancel: () => false,
    };
  }

  // ── Pick modes (the inspector's buttons) ───────────────────────────

  _pickTool() {
    return {
      activate: () => { if (this.pending) this.vp.setPrompt(this.pending.prompt); },
      deactivate: () => {
        this.vp.setPrompt("");
        const p = this.pending;
        this.pending = null;
        if (p && p.resolve) p.resolve(null);
        if (p && p.onDone) p.onDone();
      },
      onPick: (hit) => {
        const p = this.pending;
        if (!p) return false;
        if (!hit || !hit.id) return true;
        if (p.mode === "point") {
          const resolve = p.resolve;
          p.resolve = null;
          this._endPick();
          resolve(hit);
        } else {
          p.onPick(hit.id, hit);
        }
        return true;
      },
      cancel: () => { this._endPick(); return true; },
    };
  }

  _endPick() {
    const p = this.pending;
    const previous = p && p.previous && this.vp.tools.has(p.previous) && p.previous !== "pick" ? p.previous : "select";
    this.vp.setTool(previous);   // deactivate() settles the pending request
  }

  // One point on a part: a Promise of the hit ({id, point, normal}) or null
  // when cancelled with Escape.
  pickPoint({ prompt = "Click a point on a part · Esc cancels" } = {}) {
    if (this.pending) this._endPick();
    return new Promise((resolve) => {
      this.pending = { mode: "point", resolve, prompt: `${prompt} · Esc cancels`, previous: this.vp.getTool() };
      this.vp.setTool("pick");
    });
  }

  // Parts, one click each, until Escape: onPick(id, hit) per click.
  pickParts({ prompt = "Click parts", onPick, onDone } = {}) {
    if (this.pending) this._endPick();
    this.pending = { mode: "parts", onPick, onDone, prompt: `${prompt} · Esc finishes`, previous: this.vp.getTool() };
    this.vp.setTool("pick");
  }

  // ── Rubber-band preview of the arrow being placed ──────────────────

  _queueHover(e) {
    if (!this.tail || this.vp.getTool() !== "arrow") return;
    this._hoverEvent = e;
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      const ev = this._hoverEvent;
      if (!ev || !this.tail || !this.vp.viewer || !this.vp.viewer.ready) return;
      const hit = this.vp.viewer.pick(ev.clientX, ev.clientY);
      const head = this._headFor(hit && hit.id ? hit : null, ev.clientX, ev.clientY, ev.shiftKey || this.shift);
      this._showPreview(head);
    });
  }

  _ensurePreview() {
    const viewer = this.vp.viewer;
    if (!viewer || !viewer.editor || !window.THREE) return null;
    if (this.preview && this.preview.group.parent) return this.preview;
    const THREE = window.THREE;
    const color = new THREE.Color();
    try { color.setStyle(getComputedStyle(this.vp.viewerEl).getPropertyValue("--accent").trim() || "#60a5fa"); } catch (e) { color.set(0x60a5fa); }
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
    const group = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1, false), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 16, 1, false), mat);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat);
    group.add(shaft, head, dot);
    group.renderOrder = 10;
    viewer.editor.overlay().add(group);
    this.preview = { group, shaft, head, dot, mat };
    return this.preview;
  }

  _showPreview(head) {
    const viewer = this.vp.viewer;
    if (!this.tail || !head || !viewer) {
      if (this.preview && this.preview.group.visible) { this.preview.group.visible = false; if (viewer && viewer.editor) viewer.editor.requestRender(); }
      return;
    }
    const pv = this._ensurePreview();
    if (!pv) return;
    const THREE = window.THREE;
    const box = this.state.bboxOf(null);
    const diameter = box ? boxDiagonal(box) : 100;
    const shaftR = Math.min(6, Math.max(0.5, diameter * 0.006)), headL = Math.min(20, Math.max(2, diameter * 0.03));
    const f = new THREE.Vector3().fromArray(this.tail.point), t = new THREE.Vector3().fromArray(head);
    const d = t.clone().sub(f), len = d.length();
    pv.group.visible = true;
    pv.dot.position.copy(f);
    pv.dot.scale.setScalar(shaftR * 1.5);
    if (len < headL) {
      pv.shaft.visible = pv.head.visible = false;
    } else {
      d.divideScalar(len);
      const y = new THREE.Vector3(0, 1, 0);
      const shaftLen = len - headL;
      pv.shaft.visible = pv.head.visible = true;
      pv.shaft.scale.set(shaftR, shaftLen, shaftR);
      pv.shaft.position.copy(f).addScaledVector(d, shaftLen / 2);
      pv.shaft.quaternion.setFromUnitVectors(y, d);
      pv.head.scale.set(shaftR * 2, headL, shaftR * 2);
      pv.head.position.copy(f).addScaledVector(d, shaftLen + headL / 2);
      pv.head.quaternion.setFromUnitVectors(y, d);
    }
    viewer.editor.requestRender();
  }
}
