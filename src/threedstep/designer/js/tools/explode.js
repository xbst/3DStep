// The explode helpers in the toolbar's "explode" group: -X +X -Y +Y -Z +Z
// move the selection along a model axis by the distance in the field (presses
// accumulate), Assemble clears the selection's moves (or every move of the
// step when nothing is selected), and Explode step stacks the parts the step
// highlights along the up axis so their boxes do not overlap, the field's
// distance apart. Every press is one undo step.

import { expandIds } from "../project-model.js";
import { composePlacement, explodeSpacing, roundTo } from "./geometry.js";
import { mergeEntries, unitsFor } from "./placement.js";

const AXES = ["X", "Y", "Z"];
const DIST_KEY = "threedstep-designer-explode-mm";

export class ExplodeTools {
  constructor(viewport) {
    this.vp = viewport;
    this.state = viewport.state;
    const group = viewport.groups.explode;
    this.axisButtons = [];
    AXES.forEach((name, axis) => {
      for (const sign of [-1, 1]) {
        const b = viewport.addButton({
          id: `explode-${sign < 0 ? "minus" : "plus"}-${name.toLowerCase()}`,
          label: `${sign < 0 ? "−" : "+"}${name}`,
          title: `Move the selection ${sign < 0 ? "−" : "+"}${name} by the distance (presses add up)`,
          group: "explode",
          onClick: () => this.nudge(axis, sign),
        });
        b.classList.add("vp-axis");
        this.axisButtons.push(b);
      }
    });
    this.field = document.createElement("input");
    this.field.type = "number";
    this.field.className = "vp-field";
    this.field.id = "explode-distance";
    this.field.min = "0";
    this.field.step = "1";
    this.field.title = "Explode distance in mm: the axis buttons move by it, Explode step spaces by it";
    this.field.setAttribute("aria-label", "Explode distance in mm");
    let last = "10";
    try { last = localStorage.getItem(DIST_KEY) || last; } catch (e) { /* storage blocked */ }
    this.field.value = last;
    this.field.addEventListener("change", () => {
      if (!(this.distance() > 0)) this.field.value = "10";
      try { localStorage.setItem(DIST_KEY, this.field.value); } catch (e) { /* storage blocked */ }
    });
    const unit = document.createElement("span");
    unit.className = "vp-unit";
    unit.textContent = "mm";
    group.appendChild(this.field);
    group.appendChild(unit);
    this.btnAssemble = viewport.addButton({ id: "assemble", label: "Assemble", title: "Back to the assembled pose: the selection's moves (nothing selected: every move of this step)", group: "explode", onClick: () => this.assemble() });
    this.btnStep = viewport.addButton({ id: "explode-step", label: "Explode step", title: "Stack the parts this step highlights along the up axis, the distance apart, so none overlap", group: "explode", onClick: () => this.explodeStep() });
    for (const ev of ["selection-changed", "project-changed", "step-changed", "models-changed"]) this.state.on(ev, () => this.refresh());
    this.refresh();
  }

  distance() {
    const v = Number(this.field.value);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  refresh() {
    const st = this.state;
    const step = st.step();
    const hasModels = st.loadedModels().length > 0;
    const sel = step && st.selection.parts.length > 0;
    for (const b of this.axisButtons) b.disabled = !hasModels || !sel;
    this.field.disabled = !hasModels;
    this.btnAssemble.disabled = !hasModels || !step || !(sel || step.moves.length);
    this.btnStep.disabled = !hasModels || !step || !step.highlight.length;
  }

  // Move the selection along a model axis by the distance (signed).
  nudge(axis, sign) {
    const d = this.distance();
    if (!(d > 0)) return false;
    const units = unitsFor(this.state, this.state.selection.parts);
    if (!units.length) return false;
    const translate = [0, 0, 0];
    translate[axis] = sign * d;
    const entries = units.map((u) => {
      const next = composePlacement(u.current, { pivot: u.center, translate }, u.center);
      return { ids: [u.id], offset: next.offset.map((v) => roundTo(v, 4)), rotate: next.rotate.map((v) => roundTo(v, 4)) };
    });
    return this.state.setMoves(mergeEntries(entries), "viewport");
  }

  // Clear the selection's moves, or every move of the step.
  assemble() {
    const st = this.state;
    const step = st.step();
    if (!step) return false;
    const ids = st.selection.parts.length ? st.selection.parts : step.moves.flatMap((m) => m.parts);
    return ids.length ? st.clearMove(ids, "viewport") : false;
  }

  // Stack the highlighted ids along the up axis above the rest of what the
  // step shows (or from the lowest one when nothing else is shown).
  explodeStep() {
    const st = this.state;
    const step = st.step();
    if (!step || !step.highlight.length) return false;
    const units = unitsFor(st, step.highlight);
    if (!units.length) return false;
    const axis = st.project.assembly.up === "y" ? 1 : 2;
    const moved = new Set(units.flatMap((u) => u.members));
    const visible = st.folds()[st.currentStep] || new Set();
    const rest = [...visible].filter((p) => !moved.has(p));
    const restBox = rest.length ? st.bboxOf(rest) : null;
    const base = restBox ? restBox.max[axis] : null;
    const gap = this.distance() || 0;
    const offsets = explodeSpacing(units.map((u) => ({ id: u.id, min: u.box.min, max: u.box.max })), axis, { base, gap });
    const entries = units.map((u) => {
      const offset = [0, 0, 0];
      offset[axis] = roundTo(offsets[u.id], 4);
      return { ids: [u.id], offset, rotate: [0, 0, 0] };
    });
    return st.setMoves(mergeEntries(entries), "viewport");
  }
}

// For tests and the inspector: the parts an explode step would move.
export function explodedParts(state) {
  const step = state.step();
  return step ? expandIds(state.registry, step.highlight) : [];
}
