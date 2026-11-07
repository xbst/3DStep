// Placements read from the designer's state: what a selection moves as, where
// a part sits in the current step, and the frame an attached arrow or label
// is in. The math itself is in geometry.js; this module only knows the state
// (registry, placements, bounding boxes), apart from where an explicit arrow
// sits and goes when a gizmo drags it.

import { membersOf } from "../project-model.js";
import { boxCenter, boxUnion, placePoint, placedCenter, placement, quatRotate, transformedBox, unplacePoint, vadd, vlen, vscale, vsub } from "./geometry.js";

// The current step's placement of a part as a geometry placement (offset,
// rotate and the center it rotates about, which is the center of the id the
// move names: a group's when the part moves with its group), or null when the
// part is assembled.
export function partPlacement(state, partId, placements = state.placements()) {
  const p = placements.get(partId);
  if (!p) return null;
  const box = state.bboxOf([p.named]) || state.bboxOf([partId]);
  return placement(p.offset, p.rotate, box ? boxCenter(box) : [0, 0, 0]);
}

// The placement an attached arrow or label is shown through: viewer.js hangs
// it under the part's pivot, or under the first part of a group (attachParent).
export function attachPlacement(state, id, placements) {
  if (!id || !state.registry.members.has(id)) return null;
  const members = membersOf(state.registry, id);
  return partPlacement(state, members.length ? members[0] : id, placements);
}

// Where an explicit arrow's gizmo sits, shown through its attach placement:
// a straight arrow's midpoint, a rotate arrow's center (its `from`).
export function arrowPivot(arrow, pl) {
  const from = placePoint(pl, arrow.from);
  return arrow.kind === "rotate" ? from : vscale(vadd(from, placePoint(pl, arrow.to)), 0.5);
}

// An arrow's points after a gizmo delta ({pivot, translate, rotate}, shown
// space, as composePlacement takes it), back in its attach frame.
export function moveArrow(arrow, pl, delta) {
  const R = delta.rotate || [0, 0, 0, 1], T = delta.translate || [0, 0, 0];
  const move = (p) => unplacePoint(pl, vadd(vadd(delta.pivot, T), quatRotate(R, vsub(placePoint(pl, p), delta.pivot))));
  return { from: move(arrow.from), to: move(arrow.to) };
}

// A straight arrow's length (the same in its attach frame as shown: a
// placement only moves and turns), and its points at another length with the
// head where it is, the tail moved along the arrow's line; null when the
// arrow has no direction or the length is not positive.
export const arrowLength = (arrow) => vlen(vsub(arrow.to, arrow.from));

export function withLength(arrow, length) {
  const d = vsub(arrow.to, arrow.from), len = vlen(d);
  if (!(len > 1e-9) || !(length > 0)) return null;
  return { from: vsub(arrow.to, vscale(d, length / len)), to: arrow.to.slice() };
}

// What a selection moves as: one unit per selected id (a part, or a group
// whose parts share one placement), else one per part under it. A unit is
// {id, members, box (assembled), center (the center its move rotates about),
// current (its placement now, or null when assembled)}.
export function unitsFor(state, ids) {
  const reg = state.registry;
  const placements = state.placements();
  const out = [];
  const seen = new Set();
  const add = (id) => {
    if (seen.has(id)) return;
    const members = membersOf(reg, id);
    if (!members.length) return;
    const first = placements.get(members[0]) || null;
    const same = members.every((m) => {
      const p = placements.get(m) || null;
      return (!p && !first) || (p && first && p.move === first.move);
    });
    if (!same) {
      members.forEach(add);
      return;
    }
    const box = state.bboxOf([id]);
    if (!box) return;
    seen.add(id);
    members.forEach((m) => seen.add(m));
    let current = null;
    if (first) {
      const cbox = state.bboxOf([first.named]) || box;
      current = placement(first.offset, first.rotate, boxCenter(cbox));
    }
    out.push({ id, members, box, center: boxCenter(box), current });
  };
  for (const id of state.topIds(ids)) add(id);
  return out;
}

// The displayed box of a unit.
export function displayedBox(unit) {
  return transformedBox(unit.box, unit.current);
}

// Where a gizmo for these units sits: one unit's displayed center, or the
// center of the union of several units' displayed boxes.
export function pivotOf(units) {
  if (!units.length) return null;
  if (units.length === 1) return units[0].current ? placedCenter(units[0].current) : units[0].center.slice();
  let box = null;
  for (const u of units) box = boxUnion(box, displayedBox(u));
  return boxCenter(box);
}

// Entries for state.setMoves: one per unit, merged where several units end
// up with the same offset and rotation (one [[step.move]] listing them all).
export function mergeEntries(entries) {
  const out = [];
  const byKey = new Map();
  for (const e of entries) {
    const key = JSON.stringify([e.offset, e.rotate, e.arrow ?? null]);
    const hit = byKey.get(key);
    if (hit) hit.ids.push(...e.ids);
    else {
      const copy = { ...e, ids: e.ids.slice() };
      byKey.set(key, copy);
      out.push(copy);
    }
  }
  return out;
}
