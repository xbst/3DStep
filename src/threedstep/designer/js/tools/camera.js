// Camera helpers: "Fit list" (the step's camera becomes a fit over the
// selection, or over what the step highlights) and the view cube in the
// viewport's corner: the model's box as the camera sees it, drawn on a 2D
// canvas. Clicking a face flies the view around to look from that side, an
// edge from between two sides, a corner from three (an isometric view).

import { vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from "./geometry.js";

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
export const CAMERA_ICONS = {
  fitList: `<svg ${SVG}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M9 10h6M9 14h6"/></svg>`,
};

const SIZE = 140;           // CSS pixels; the canvas is drawn at twice that
const HALF = 0.27;          // the cube's half edge, in canvas widths (a corner view just fits)
const BAND = 0.36;          // the edge and corner strips, in half edges
const FLY_MS = 450;
const AXIS_COLORS = ["#e06c75", "#98c379", "#61afef"];
const AXIS_NAMES = ["X", "Y", "Z"];
const CUBE_TITLE = "View cube: click a face, an edge or a corner to look from there";

// The sides as Fusion names them: with Z up the front is -Y, with Y up +Z.
export function cubeFrame(upAxis) {
  return upAxis === "y" ? { up: [0, 1, 0], front: [0, 0, 1] } : { up: [0, 0, 1], front: [0, -1, 0] };
}

// The six faces: normal, name, and the face's own right and up (the way its
// name reads when the view looks straight at it).
export function cubeFaces(upAxis) {
  const { up, front } = cubeFrame(upAxis);
  const faces = [];
  for (let k = 0; k < 3; k++) {
    for (const s of [1, -1]) {
      const n = [0, 0, 0];
      n[k] = s;
      const u = vdot(n, up), f = vdot(n, front);
      const name = u > 0.5 ? "Top" : u < -0.5 ? "Bottom" : f > 0.5 ? "Front" : f < -0.5 ? "Back" : n[0] > 0 ? "Right" : "Left";
      // A top view has the back at the top of the screen, a bottom view the front.
      const textUp = Math.abs(u) > 0.5 ? vscale(front, -u) : up;
      faces.push({ n, name, up: textUp, right: vcross(textUp, n), axis: k, sign: s });
    }
  }
  return faces;
}

// "Top front right (+X −Y +Z)" for a direction of -1/0/1 components.
export function cubeRegionName(dir, upAxis) {
  const { up, front } = cubeFrame(upAxis);
  const words = [];
  const u = vdot(dir, up), f = vdot(dir, front);
  if (u) words.push(u > 0 ? "top" : "bottom");
  if (f) words.push(f > 0 ? "front" : "back");
  if (dir[0]) words.push(dir[0] > 0 ? "right" : "left");
  const axes = dir.map((v, k) => (v ? `${v > 0 ? "+" : "−"}${AXIS_NAMES[k]}` : "")).filter(Boolean);
  const text = words.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} (${axes.join(" ")})`;
}

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
    this.canvas.className = "vp-cube";
    this.canvas.width = SIZE * 2;
    this.canvas.height = SIZE * 2;
    this.canvas.title = CUBE_TITLE;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", CUBE_TITLE);
    viewport.el.appendChild(this.canvas);
    this.cam = null;
    this.hover = null;       // the region under the pointer: {dir, key}
    this._fly = 0;           // the animation frame of a flight in progress
    this.canvas.addEventListener("click", (e) => this._onClick(e));
    this.canvas.addEventListener("pointermove", (e) => this._setHover(this.hit(e.clientX, e.clientY)));
    this.canvas.addEventListener("pointerleave", () => this._setHover(null));
    // Orbiting by hand takes the view back from a flight.
    viewport.viewerEl.addEventListener("pointerdown", () => this._stopFlight(), { capture: true });
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

  // ── The view cube ──────────────────────────────────────────────────

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

  // The faces the camera sees, with the basis that drawing and hit testing need.
  _visibleFaces() {
    if (!this.cam) return [];
    const basis = this._basis(this.cam);
    return cubeFaces(this.state.project.assembly.up)
      .map((f) => ({ ...f, facing: -vdot(f.n, basis.forward), basis }))
      .filter((f) => f.facing > 1e-6);
  }

  draw(cam) {
    this.cam = cam || this.cam;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const s = SIZE * 2, c = s / 2, S = s * HALF;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, s, s);
    const faces = this._visibleFaces();
    if (!faces.length) return;
    const { right, upv, forward } = faces[0].basis;
    // A point of the cube ([-1, 1] on every axis) to canvas pixels: an
    // orthographic view of it.
    const at = (f, u, v) => {
      const p = vadd(f.n, vadd(vscale(f.right, u), vscale(f.up, v)));
      return [c + vdot(p, right) * S, c - vdot(p, upv) * S];
    };
    const path = (pts) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    };
    const accent = getComputedStyle(this.canvas).getPropertyValue("--accent").trim() || "#4c8dff";
    // Lit from the viewer's upper left, so the sides read apart.
    const light = vnorm(vadd(vadd(vscale(right, -0.35), vscale(upv, 0.6)), vscale(forward, -0.7)));
    const cuts = [-1, -1 + BAND, 1 - BAND, 1];
    for (const f of faces) {
      const g = Math.round(50 + 42 * Math.max(0, vdot(f.n, light)));
      path([at(f, -1, -1), at(f, 1, -1), at(f, 1, 1), at(f, -1, 1)]);
      ctx.fillStyle = `rgba(${g}, ${g + 4}, ${g + 12}, 0.94)`;
      ctx.fill();
      // The hovered face, edge or corner, on every side that shows it.
      for (let iu = 0; iu < 3 && this.hover; iu++) {
        for (let iv = 0; iv < 3; iv++) {
          if (this._key(this._cellDir(f, iu - 1, iv - 1)) !== this.hover.key) continue;
          path([at(f, cuts[iu], cuts[iv]), at(f, cuts[iu + 1], cuts[iv]), at(f, cuts[iu + 1], cuts[iv + 1]), at(f, cuts[iu], cuts[iv + 1])]);
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = accent;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      path([at(f, -1, -1), at(f, 1, -1), at(f, 1, 1), at(f, -1, 1)]);
      ctx.strokeStyle = "rgba(180, 186, 198, 0.9)";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    // The names and axes, printed on their faces (the face's plane mapped to
    // the canvas, 100 units to the half edge), fading as a face turns edge-on.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const f of faces) {
      const alpha = Math.min(1, Math.max(0, (f.facing - 0.12) / 0.25));
      if (!alpha) continue;
      const o = at(f, 0, 0), x = at(f, 1, 0), y = at(f, 0, -1);
      ctx.setTransform((x[0] - o[0]) / 100, (x[1] - o[1]) / 100, (y[0] - o[0]) / 100, (y[1] - o[1]) / 100, o[0], o[1]);
      ctx.globalAlpha = alpha;
      const name = f.name.toUpperCase();
      ctx.font = "600 30px system-ui, sans-serif";
      const w = ctx.measureText(name).width;
      if (w > 150) ctx.font = `600 ${Math.floor(30 * 150 / w)}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(232, 235, 240, 0.95)";
      ctx.fillText(name, 0, -10);
      ctx.font = "700 26px system-ui, sans-serif";
      ctx.fillStyle = AXIS_COLORS[f.axis];
      ctx.fillText(`${f.sign > 0 ? "+" : "−"}${AXIS_NAMES[f.axis]}`, 0, 24);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  // The look-from direction of a cell of a face: -1, 0 or 1 along the face's
  // right and up (0, 0 is the face itself, the others its edges and corners).
  _cellDir(f, du, dv) {
    return vadd(f.n, vadd(vscale(f.right, du), vscale(f.up, dv)));
  }

  _key(dir) {
    return dir.map((v) => Math.round(v) || 0).join(",");
  }

  // The face, edge or corner under a client point ({dir, key, name}) or null:
  // a ray through the point along the view, against the faces that show.
  hit(clientX, clientY) {
    const faces = this._visibleFaces();
    const rect = this.canvas.getBoundingClientRect();
    if (!faces.length || !rect.width) return null;
    const s = SIZE * 2, S = s * HALF;
    const px = (clientX - rect.left) * s / rect.width, py = (clientY - rect.top) * s / rect.height;
    const { right, upv, forward } = faces[0].basis;
    const origin = vadd(vadd(vscale(right, (px - s / 2) / S), vscale(upv, (s / 2 - py) / S)), vscale(forward, -4));
    const band = (t) => (t < -1 + BAND ? -1 : t > 1 - BAND ? 1 : 0);
    for (const f of faces) {
      const k = f.axis;
      const p = vadd(origin, vscale(forward, (f.sign - origin[k]) / forward[k]));
      if ([0, 1, 2].some((j) => j !== k && Math.abs(p[j]) > 1 + 1e-6)) continue;
      const dir = this._cellDir(f, band(vdot(p, f.right)), band(vdot(p, f.up))).map((v) => Math.round(v) || 0);
      return { dir, key: this._key(dir), name: cubeRegionName(dir, this.state.project.assembly.up) };
    }
    return null;
  }

  _setHover(hit) {
    if ((hit && hit.key) === (this.hover && this.hover.key)) return;
    this.hover = hit;
    this.canvas.style.cursor = hit ? "pointer" : "";
    this.canvas.title = hit ? hit.name : CUBE_TITLE;
    this.draw(null);
  }

  _onClick(e) {
    const hit = this.hit(e.clientX, e.clientY);
    if (hit) this.lookFrom(hit.dir);
  }

  // Fly the view around its target to look from `dir` (toward the camera, in
  // model space), keeping the distance: along the arc between the two
  // directions, so the model turns instead of the camera passing through it.
  lookFrom(dir) {
    const cam = this.vp.getCamera();
    if (!cam) return false;
    const { up, front } = cubeFrame(this.state.project.assembly.up);
    let to = vnorm(dir);
    // Straight along the up axis the view has no natural up: tilt it a hair
    // toward the front, so a top view has the front at the bottom.
    if (Math.abs(vdot(to, up)) > 1 - 1e-9) to = vnorm(vadd(to, vscale(front, 0.0005)));
    const target = cam.target.slice();
    const dist = vlen(vsub(cam.position, target)) || 100;
    const from = vnorm(vsub(cam.position, target), to);
    const place = (d) => ({ position: vadd(target, vscale(d, dist)), target: target.slice(), fov: cam.fov, projection: cam.projection });
    this._stopFlight();
    const angle = Math.acos(Math.max(-1, Math.min(1, vdot(from, to))));
    if (angle < 1e-4) {
      this.vp.setCamera(place(to));
      return true;
    }
    // Opposite directions: turn about the up axis (looking along it, the front).
    let axis = vcross(from, to);
    if (vlen(axis) < 1e-6) axis = vlen(vcross(from, up)) > 1e-6 ? up : front;
    axis = vnorm(axis);
    // Rodrigues: `from` turned by `a` about `axis`.
    const turn = (a) => vadd(vadd(vscale(from, Math.cos(a)), vscale(vcross(axis, from), Math.sin(a))),
      vscale(axis, vdot(axis, from) * (1 - Math.cos(a))));
    const ms = FLY_MS * (0.5 + 0.5 * angle / Math.PI);
    const t0 = performance.now();
    const frame = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0) / ms));
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.vp.setCamera(place(k >= 1 ? to : vnorm(turn(angle * e))));
      this._fly = k < 1 ? requestAnimationFrame(frame) : 0;
    };
    this._fly = requestAnimationFrame(frame);
    return true;
  }

  // The view from the + or - end of a model axis (k: 0 x, 1 y, 2 z).
  lookAlong(k, sign) {
    const dir = [0, 0, 0];
    dir[k] = sign;
    return this.lookFrom(dir);
  }

  _stopFlight() {
    if (this._fly) cancelAnimationFrame(this._fly);
    this._fly = 0;
  }
}
