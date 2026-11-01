// The id rule (SPEC 7): how a CAD name becomes a node id. glb.py's slugify
// and assign_ids implement the same rule in Python, and the shared case list
// tests/fixtures/ids-cases.json keeps the two in step.

// NFKD-normalize and drop what is not ASCII, lowercase, collapse every run of
// characters outside [a-z0-9] into one "_", strip "_" from both ends; an empty
// result is "part". A label that is not a string counts as empty.
export function slugify(label) {
  const text = typeof label === "string" ? label : "";
  const slug = text
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "part";
}

// Unique ids for labels in document order. The first label with a given slug
// keeps it; later ones get slug_N with the smallest N >= 2 not already taken,
// whether by a suffixed id or by another label's bare slug (m3x12, m3x12_2).
export function assignIds(labels) {
  return uniqueIds(labels.map(slugify));
}

// A model's ids with a prefix in front (tq2_pi4_bolt), each made unique the
// same way against the ids in `taken` (other models') and the ones before
// it: what a model gets when it joins a project whose models already use some
// of its ids. On ids from assignIds, with nothing in `taken` that starts with
// the prefix, this is what glb.assign_ids(labels, prefix=...) gives, so
// `3dstep model.step --id-prefix` writes the same ids.
export function prefixIds(ids, prefix, taken = []) {
  return uniqueIds(ids.map(id => `${prefix}${id}`), taken);
}

function uniqueIds(slugs, already = []) {
  const taken = new Set(already);
  const nextSuffix = new Map();
  const ids = [];
  for (const slug of slugs) {
    let candidate = slug;
    if (taken.has(candidate)) {
      // Every suffix below nextSuffix[slug] is taken already, so the search
      // can resume there instead of at 2.
      let n = nextSuffix.get(slug) || 2;
      while (taken.has(`${slug}_${n}`)) n++;
      candidate = `${slug}_${n}`;
      nextSuffix.set(slug, n + 1);
    }
    taken.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

// What a node name must look like for a project to refer to it (SPEC 6).
export const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}
