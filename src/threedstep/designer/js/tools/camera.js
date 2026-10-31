// Camera helpers: "Fit list" (the step's camera becomes a fit over the
// selection, or over what the step highlights) and the axis triad in the
// viewport's corner: the model axes as seen by the camera, drawn on a 2D
// canvas; clicking an axis bubble flies the view to look along it.

import { vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from "./geometry.js";

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
export const CAMERA_ICONS = {
  fitList: `<svg ${SVG}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M9 10h6M9 14h6"/></svg>`,
};

const SIZE = 96;
const AXIS_COLORS = ["#e06c75", "#98c379", "#61afef"];
const AXIS_NAMES = ["X", "Y", "Z"];

export class CameraTools {
  constructor(viewport) {
    this.vp = viewport;
    this.state = viewport.state;
    this.btnFitList = viewport.addButton({
      id: "fit-list", group: "camera", label: "Fit list", icon: CAMERA_ICONS.fitList,
      title: "This step's camera frames the selection (nothing selected: what the step highlights) from the inherited direction",
      onClick: () => this.fitList(),
    });
    this.canvas = document.createElement("canvas");
    this.canvas.className = "vp-triad";
    this.canvas.width = SIZE * 2;
    this.canvas.height = SIZE * 2;
    this.canvas.title = "The model axes as seen; click an axis to look along it";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Axis triad: click an axis to look along it");
    viewport.el.appendChild(this.canvas);
    this.bubbles = [];
    this.cam = null;
    this.canvas.addEventListener("click", (e) => this._onClick(e));
    viewport.on("camera", (cam) => this.draw(cam));
    viewport.on("ready", () => this.draw(viewport.getCamera()));
    for (const ev of ["selection-changed", "project-changed", "step-changed", "models-changed"]) this.state.on(ev, () => this.refresh());
    this.refresh();
    this.draw(null);
  }

  refresh() {
    const st = this.state;
    const step = st.step();
    const ids = this._fitIds();
    this.btnFitList.disabled = !st.loadedModels().length || !step || !ids.length;
    this.canvas.hidden = !st.loadedModels().length;
    if (!this.canvas.hidden && this.vp.viewer && this.vp.viewer.ready) this.draw(this.vp.getCamera());
  }

  _fitIds() {
    const st = this.state;
    const sel = st.topIds(st.selection.parts).filter((id) => st.registry.members.has(id));
    if (sel.length) return sel;
    const step = st.step();
    return step ? step.highlight.filter((id) => st.registry.members.has(id)) : [];
  }

  fitList() {
    const ids = this._fitIds();
    if (!ids.length || this.state.currentStep < 0) return false;
    return this.state.setStepCamera(this.state.currentStep, { fit: ids }, "viewport");
  }

  // ── The triad ──────────────────────────────────────────────────────

  // The camera basis: right, up and forward unit vectors in model space.
  _basis(cam) {
    const up = this.state.project.assembly.up === "y" ? [0, 1, 0] : [0, 0, 1];
    const forward = vnorm(vsub(cam.target, cam.position), [0, -1, 0]);
    let right = vcross(forward, up);
    if (vlen(right) < 1e-6) right = vcross(forward, up[2] ? [0, 1, 0] : [0, 0, 1]);
    right = vnorm(right);
    const upv = vnorm(vcross(right, forward));
    return { right, upv, forward };
  }

  draw(cam) {
    this.cam = cam || this.cam;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const s = SIZE * 2, c = s / 2, R = s * 0.34, r = s * 0.085;
    ctx.clearRect(0, 0, s, s);
    this.bubbles = [];
    if (!this.cam) return;
    const { right, upv, forward } = this._basis(this.cam);
    const items = [];
    for (let k = 0; k < 3; k++) {
      const axis = [0, 0, 0];
      axis[k] = 1;
      for (const sign of [1, -1]) {
        const v = vscale(axis, sign);
        items.push({ k, sign, x: c + vdot(v, right) * R, y: c - vdot(v, upv) * R, depth: -vdot(v, forward) });
      }
    }
    items.sort((a, b) => a.depth - b.depth);   // far first
    ctx.lineWidth = 3;
    ctx.font = `bold ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const it of items) {
      const color = AXIS_COLORS[it.k];
      const near = it.depth >= 0;
      ctx.globalAlpha = near ? 1 : 0.55;
      if (it.sign > 0) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(it.x, it.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(it.x, it.y, r, 0, Math.PI * 2);
      if (it.sign > 0) {
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = "#111";
        ctx.fillText(AXIS_NAMES[it.k], it.x, it.y + 1);
      } else {
        ctx.fillStyle = "rgba(20,20,20,.75)";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.fillStyle = color;
        ctx.fillText(`−${AXIS_NAMES[it.k]}`, it.x, it.y + 1);
      }
      this.bubbles.push({ k: it.k, sign: it.sign, x: it.x / 2, y: it.y / 2, r: r / 2 });
    }
    ctx.globalAlpha = 1;
  }

  _onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    // The nearest bubble on top wins (they were drawn far to near).
    let hit = null;
    for (const b of this.bubbles) if (Math.hypot(x - b.x, y - b.y) <= b.r) hit = b;
    if (hit) this.lookAlong(hit.k, hit.sign);
  }

  // Fly the view to look at the target from the +/- axis, keeping the distance.
  lookAlong(k, sign) {
    const cam = this.vp.getCamera();
    if (!cam) return false;
    const up = this.state.project.assembly.up === "y" ? 1 : 2;
    const dir = [0, 0, 0];
    dir[k] = sign;
    // Along the up axis the view has no natural up: nudge it so the screen's
    // up is predictable (the far side of the default view direction).
    if (k === up) dir[up === 2 ? 1 : 2] = up === 2 ? -0.0005 : 0.0005;
    const dist = vlen(vsub(cam.position, cam.target)) || 100;
    const next = { position: vadd(cam.target, vscale(vnorm(dir), dist)), target: cam.target.slice(), fov: cam.fov, projection: cam.projection };
    this.vp.setCamera(next, { animate: true });
    return true;
  }
}
