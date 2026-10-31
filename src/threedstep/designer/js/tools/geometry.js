// Pure math for the viewport tools: vectors, quaternions, the Euler XYZ
// degrees of a `[[step.move]] rotate` (Three.js's Euler "XYZ" convention,
// which viewer.js uses to place parts), placements and their composition with
// a gizmo delta, snapping, the spacing of an exploded step, and the frame
// conversion of attached arrows and labels. No DOM, no THREE: this module is
// unit-tested in Node (tests/js/tools-geometry.test.mjs).
//
// A placement is {offset, rotate, center}: the part's displayed pose is
//   D(x) = offset + center + R(x - center)
// with R the rotation of `rotate` (degrees) about the model axes, as
// viewer.js's applyPlacement computes it (SPEC 6, "rotate ... applied about
// the part's assembled bounding-box center"). Quaternions are [x, y, z, w].

export const DEG = Math.PI / 180;
const EPS = 1e-9;

// ── Vectors ──────────────────────────────────────────────────────────

export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export function vnorm(a, fallback = [0, 0, 1]) {
  const l = vlen(a);
  return l > EPS ? vscale(a, 1 / l) : fallback.slice();
}
export const vequal = (a, b, tol = 1e-9) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
export const isZero = (a, tol = 1e-9) => vequal(a, [0, 0, 0], tol);

// ── Quaternions (Three.js's conventions) ─────────────────────────────

export const QUAT_IDENTITY = Object.freeze([0, 0, 0, 1]);

export function quatFromAxisAngle(axis, angle) {
  const u = vnorm(axis);
  const s = Math.sin(angle / 2);
  return [u[0] * s, u[1] * s, u[2] * s, Math.cos(angle / 2)];
}

// a * b: rotate by b first, then by a (Quaternion.multiplyQuaternions).
export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const quatConjugate = (q) => [-q[0], -q[1], -q[2], q[3]];

export function quatNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > EPS ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : QUAT_IDENTITY.slice();
}

// Vector3.applyQuaternion.
export function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx];
}

// Euler XYZ degrees -> quaternion (Quaternion.setFromEuler with order "XYZ").
export function quatFromEuler(deg) {
  const x = (deg[0] || 0) * DEG / 2, y = (deg[1] || 0) * DEG / 2, z = (deg[2] || 0) * DEG / 2;
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
  const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

// Quaternion -> Euler XYZ degrees (Euler.setFromRotationMatrix, order "XYZ").
export function eulerFromQuat(q) {
  const [x, y, z, w] = quatNormalize(q);
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
  const m22 = 1 - (xx + zz), m23 = yz - wx;
  const m32 = yz + wx, m33 = 1 - (xx + yy);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  let ex, ez;
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    ex = Math.atan2(m32, m22);
    ez = 0;
  }
  return [ex / DEG, ey / DEG, ez / DEG].map(cleanZero);
}

// {axis, angle} (radians, 0..PI) of a rotation.
export function quatAxisAngle(q) {
  let [x, y, z, w] = quatNormalize(q);
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, w)));
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const axis = s < 1e-6 ? [1, 0, 0] : [x / s, y / s, z / s];
  return { axis, angle };
}

export const isIdentityQuat = (q, tol = 1e-9) => quatAxisAngle(q).angle <= tol;
export const isIdentityRotate = (deg) => !deg || deg.every((d) => Math.abs(d) < 1e-9);

// ── Placements ───────────────────────────────────────────────────────

export const IDENTITY_PLACEMENT = Object.freeze({ offset: [0, 0, 0], rotate: [0, 0, 0], center: [0, 0, 0] });

export function placement(offset, rotate, center) {
  return { offset: (offset || [0, 0, 0]).slice(), rotate: (rotate || [0, 0, 0]).slice(), center: (center || [0, 0, 0]).slice() };
}

// Where the displayed pose puts an assembled point.
export function placePoint(pl, x) {
  if (!pl) return x.slice();
  const q = quatFromEuler(pl.rotate);
  return vadd(vadd(pl.offset, pl.center), quatRotate(q, vsub(x, pl.center)));
}

// The assembled point a displayed point comes from (the inverse of placePoint).
export function unplacePoint(pl, y) {
  if (!pl) return y.slice();
  const qi = quatConjugate(quatFromEuler(pl.rotate));
  return vadd(pl.center, quatRotate(qi, vsub(vsub(y, pl.offset), pl.center)));
}

// The displayed center of a placement's part.
export const placedCenter = (pl) => vadd(pl.offset, pl.center);

// Apply a gizmo delta to a current placement. The delta rotates by `rotate`
// (a quaternion) about the pivot point P, then translates by `translate`:
//   D1(x) = P + T + Rd (D0(x) - P)
// The result is expressed as a placement about `newCenter` (the center the
// stored move will rotate about: the part's or the group's assembled center),
// so a new move about a different center shows the same pose.
export function composePlacement(current, delta, newCenter) {
  const cur = current || placement(null, null, newCenter);
  const c1 = newCenter || cur.center;
  const Rd = delta.rotate || QUAT_IDENTITY;
  const T = delta.translate || [0, 0, 0];
  const P = delta.pivot || c1;
  const R1 = quatMultiply(Rd, quatFromEuler(cur.rotate));
  const d1 = vadd(vadd(P, T), quatRotate(Rd, vsub(placePoint(cur, c1), P)));
  return { offset: vsub(d1, c1), rotate: eulerFromQuat(R1), center: c1.slice() };
}

// ── Boxes ────────────────────────────────────────────────────────────

export const boxCenter = (b) => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
export const boxSize = (b) => vsub(b.max, b.min);
export const boxDiagonal = (b) => vlen(boxSize(b));

export function boxUnion(a, b) {
  if (!a) return b ? { min: b.min.slice(), max: b.max.slice() } : null;
  if (!b) return { min: a.min.slice(), max: a.max.slice() };
  return { min: a.min.map((v, k) => Math.min(v, b.min[k])), max: a.max.map((v, k) => Math.max(v, b.max[k])) };
}

// The axis-aligned box of a box's eight corners in their displayed pose.
export function transformedBox(box, pl) {
  if (!pl || (isZero(pl.offset) && isIdentityRotate(pl.rotate))) return { min: box.min.slice(), max: box.max.slice() };
  let out = null;
  for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) {
    const p = placePoint(pl, [dx ? box.max[0] : box.min[0], dy ? box.max[1] : box.min[1], dz ? box.max[2] : box.min[2]]);
    out = boxUnion(out, { min: p, max: p });
  }
  return out;
}

export const boxesOverlap = (a, b, tol = 1e-9) => [0, 1, 2].every((k) => a.min[k] <= b.max[k] + tol && b.min[k] <= a.max[k] + tol);

// ── Snapping ─────────────────────────────────────────────────────────

export function snapValue(v, step) {
  if (!(step > 0)) return v;
  return cleanZero(Math.round(v / step) * step);
}

export const snapVector = (v, step) => v.map((x) => snapValue(x, step));

// The rotation with its angle rounded to multiples of `stepDeg` about the same axis.
export function snapQuat(q, stepDeg) {
  if (!(stepDeg > 0)) return q.slice();
  const { axis, angle } = quatAxisAngle(q);
  const snapped = snapValue(angle / DEG, stepDeg) * DEG;
  return snapped === 0 ? QUAT_IDENTITY.slice() : quatFromAxisAngle(axis, snapped);
}

// ── Explode spacing ──────────────────────────────────────────────────

// Offsets along one model axis that stack boxes so they do not overlap:
// items [{id, min, max}] (assembled boxes), axis 0 | 1 | 2, `base` the
// coordinate everything is stacked above (null: the lowest item stays where
// it is), `gap` between neighbors. Items keep their order along the axis.
// Returns {id: scalar offset}.
export function explodeSpacing(items, axis, { base = null, gap = 0 } = {}) {
  const out = {};
  const sorted = items.map((it, k) => ({ it, k, c: (it.min[axis] + it.max[axis]) / 2 }))
    .sort((a, b) => a.c - b.c || a.k - b.k)
    .map((x) => x.it);
  if (!sorted.length) return out;
  let cursor = base === null || base === undefined ? sorted[0].min[axis] : base + gap;
  for (const it of sorted) {
    const offset = cleanZero(cursor - it.min[axis]);
    out[it.id] = offset;
    cursor = it.max[axis] + offset + gap;
  }
  return out;
}

// ── Attached frames (arrows and labels, SPEC 9.7) ────────────────────

// Convert points between the frames two attachments give: `from` and `to` are
// the placements of the old and the new attached part (null: model space, no
// attachment). Points attached to a part are in its assembled frame and are
// shown through its displayed pose, so a point moves frames without moving
// on screen.
export function convertAttached(points, from, to) {
  return points.map((p) => unplacePoint(to, placePoint(from, p)));
}

// ── Rays ─────────────────────────────────────────────────────────────

// The point of the line through `origin` along `dir` nearest to the ray
// {origin, direction} (the pointer): a constrained pick without a surface.
export function closestPointOnLine(origin, dir, ray) {
  const u = vnorm(dir), v = vnorm(ray.direction);
  const w = vsub(origin, ray.origin);
  const b = vdot(u, v), d = vdot(u, w), e = vdot(v, w);
  const denom = 1 - b * b;
  if (denom < 1e-9) return origin.slice();   // parallel: no closest point to speak of
  const s = (b * e - d) / denom;
  return vadd(origin, vscale(u, s));
}

// ── Numbers ──────────────────────────────────────────────────────────

export function roundTo(v, digits = 4) {
  const f = 10 ** digits;
  return cleanZero(Math.round(v * f) / f);
}

function cleanZero(v) {
  return Object.is(v, -0) || Math.abs(v) < 1e-12 ? 0 : v;
}
