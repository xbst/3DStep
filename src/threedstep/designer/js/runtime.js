// Loads threedstep into the page under Pyodide.
//
// The designer never reimplements the renderer: Generate runs the package's
// own Python (renderer.build_page through bridge.py), so the page it gives
// you is the page `3dstep` writes for the same files, byte for byte. The
// themes and the validation come from the same code.

export const PYODIDE_VERSION = "v314.0.7";

const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
const PAYLOAD_URL = "threedstep.zip";
const ROOT_DIR = "/threedstep";
const PKG_DIR = `${ROOT_DIR}/pkg`;

let _boot = null;
let _bridge = null;
let _py = null;
let _failure = null;
const _listeners = [];

/** Subscribe to boot progress. Phases: runtime, package, ready, error. */
export function onProgress(cb) {
  _listeners.push(cb);
  return () => {
    const i = _listeners.indexOf(cb);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

function emit(phase, detail = "") {
  for (const cb of _listeners) {
    try { cb(phase, detail); } catch (e) { /* a bad listener must not stop boot */ }
  }
}

async function boot() {
  emit("runtime");
  let loadPyodide;
  try {
    ({ loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_BASE}pyodide.mjs`));
  } catch (e) {
    throw new Error(
      "Could not download the Python runtime from cdn.jsdelivr.net. Check your " +
      "network or allowlist that host, or use the 3dstep command line tool."
    );
  }
  let py;
  try {
    py = await loadPyodide({ indexURL: PYODIDE_BASE });
  } catch (e) {
    throw new Error(
      "The Python runtime from cdn.jsdelivr.net did not start" +
      `${e && e.message ? ` (${e.message})` : ""}. Check your network or allowlist ` +
      "that host, or use the 3dstep command line tool."
    );
  }

  emit("package");
  const resp = await fetch(PAYLOAD_URL, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(
      `Could not load ${PAYLOAD_URL} (HTTP ${resp.status}). If you are serving ` +
      "this folder yourself, run python -m threedstep.payload " +
      `<this folder>/${PAYLOAD_URL} first, or open the designer with the ` +
      "3dstep command, which serves it for you."
    );
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());

  // Extract with Python's own zipfile rather than a Pyodide helper, so this
  // depends only on the filesystem API, which is stable across releases.
  py.FS.mkdirTree(ROOT_DIR);
  py.FS.writeFile(`${ROOT_DIR}/payload.zip`, bytes);
  py.runPython(`
import sys, zipfile
with zipfile.ZipFile("${ROOT_DIR}/payload.zip") as z:
    z.extractall("${PKG_DIR}")
if "${PKG_DIR}" not in sys.path:
    sys.path.insert(0, "${PKG_DIR}")
`);

  _bridge = py.pyimport("bridge");
  _py = py;
  emit("ready");
  return py;
}

/** Resolves once threedstep is importable. Safe to call repeatedly. */
export function ready() {
  if (!_boot) {
    _boot = boot().catch((e) => {
      // Keep the rejected promise so a blocked CDN does not restart the whole
      // download on every call. Recovery goes through retry().
      _failure = e;
      emit("error", e && e.message ? e.message : String(e));
      throw e;
    });
  }
  return _boot;
}

/** Discard a failed boot and start over, for a Retry control. */
export function retry() {
  _boot = null;
  _bridge = null;
  _failure = null;
  return ready();
}

export function failure() {
  return _failure;
}

async function bridge() {
  await ready();
  return _bridge;
}

/** True once threedstep is importable, for callers that cannot await. */
export function isReady() {
  return _bridge !== null;
}

/**
 * Turn a Python exception into something worth showing someone.
 *
 * Pyodide puts the whole traceback in .message, so the sentence bridge.py
 * raises on purpose ends up last, behind frames and virtual filesystem paths
 * the reader has never seen. Keep the final line, which is the message.
 */
export function pythonMessage(e) {
  const raw = (e && e.message ? e.message : String(e)).trim();
  if (!raw.includes("Traceback (most recent call last)")) return raw;
  const lines = raw.split("\n").filter((l) => l.trim() && !/^\s+/.test(l));
  const last = lines[lines.length - 1] || raw;
  // Drop the exception class, keep what it says. Multi-line messages keep
  // their tail, which is where bridge.py puts the actionable half.
  const body = last.replace(/^\w[\w.]*(Error|Exception):\s*/, "");
  const tail = raw.slice(raw.indexOf(last) + last.length).trim();
  return tail ? `${body}\n${tail}` : body;
}

async function call(name, ...args) {
  const b = await bridge();
  try {
    return b[name](...args);
  } catch (e) {
    throw new Error(pythonMessage(e));
  }
}

// ── Themes ──────────────────────────────────────────────────────────

/** [{name, display}], default first. */
export async function themeCatalog() {
  return JSON.parse(await call("theme_catalog"));
}

/** {name, light, dark, behavior, warnings} of a bundled theme. */
export async function themeTokens(name) {
  return JSON.parse(await call("theme_tokens", name || "default"));
}

export async function version() {
  return String(await call("version"));
}

// ── Validation and Generate ─────────────────────────────────────────

/**
 * Check a project TOML against the loaded models' trees ({file name: tree},
 * the shape glb.tree() gives). No model bytes cross the bridge.
 * Resolves to {errors, warnings}.
 */
export async function validate(projectToml, trees) {
  return JSON.parse(await call("validate", projectToml, JSON.stringify(trees)));
}

/**
 * Render a project TOML and its models ({file name: Uint8Array}) to a page.
 * Resolves to {html, warnings, size}. Errors carry the Python message.
 */
export async function generate(projectToml, models, themeName = "") {
  const b = await bridge();
  const proxy = _py.toPy(new Map(Object.entries(models)));
  try {
    const out = JSON.parse(b.generate(projectToml, proxy, themeName));
    return { html: out.html, warnings: out.warnings || [], size: out.size };
  } catch (e) {
    throw new Error(pythonMessage(e));
  } finally {
    proxy.destroy();
  }
}
