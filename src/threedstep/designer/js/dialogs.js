// The designer's dialogs: Generate, About, importing a model, simplifying,
// selecting tiny parts, confirmations. PinConnect's dialogs.js pattern: a
// modal shell, Escape and the backdrop close it, cleanups run on close.

import * as runtime from "./runtime.js";
import { CDN_BASE, QUALITY, StepImportError, VENDOR_BASE, modelFromRaw, rawTree, readStepRaw } from "./import/step-import.js";
import { GlbError, isGlb, parseGlb, readGlb, threedstepMetadata } from "./import/glb-reader.js";
import { estimateGlbSize, glbNameFor, triangleCount } from "./import/model.js";
import { simplifyModel } from "./import/simplify.js";

export const REPO_URL = "https://github.com/xbst/3DStep";
export const DOCS_URL = "https://doctools.isiks.tech/3dstep/";
const ABOUT_SEEN_KEY = "threedstep-designer-about-seen";

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

export function formatCount(n) {
  return n.toLocaleString("en-US");
}

/** A modal shell. Returns the body element plus a close function. */
export function openModal(title, { size = "", onEscape = null } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML =
    `<div class="modal${size ? ` modal-${size}` : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">` +
    `<div class="modal-head"><span class="modal-title">${esc(title)}</span>` +
    `<button class="modal-close" title="Close" aria-label="Close">&times;</button></div>` +
    `<div class="modal-body"></div></div>`;

  const cleanups = [];
  let closed = false;
  const previous = document.activeElement;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups) { try { fn(); } catch (e) { /* keep closing */ } }
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (previous && previous.isConnected && previous.focus) previous.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (onEscape) onEscape();
    else close();
  };

  backdrop.querySelector(".modal-close").addEventListener("click", () => (onEscape ? onEscape() : close()));
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop && !onEscape) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(backdrop);
  backdrop.querySelector(".modal-close").focus({ preventScroll: true });

  return { body: backdrop.querySelector(".modal-body"), close, onClose: (fn) => cleanups.push(fn), isClosed: () => closed };
}

/** Hand the browser a file to save (a download). */
export function downloadFile(data, name, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later; revoking at once can cancel the download.
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** OK / Cancel. Resolves to true when confirmed. */
export function confirmDialog(title, message, { ok = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const { body, close, onClose } = openModal(title);
    let answer = false;
    onClose(() => resolve(answer));
    body.innerHTML = `<p>${message}</p><div class="modal-foot"><span class="spacer"></span>` +
      `<button class="toolbar-btn" data-act="cancel">Cancel</button>` +
      `<button class="toolbar-btn ${danger ? "danger" : "primary"}" data-act="ok">${esc(ok)}</button></div>`;
    body.querySelector('[data-act="cancel"]').addEventListener("click", close);
    body.querySelector('[data-act="ok"]').addEventListener("click", () => { answer = true; close(); });
    body.querySelector('[data-act="ok"]').focus();
  });
}

// ── Generate ────────────────────────────────────────────────────────

// getToml returns the project TOML as it stands (the Theme dropdown edits it,
// so each render reads it afresh), getModels the GLB bytes of every model,
// stem the file name the download gets before ".3dstep.html".
export async function openGenerate(state, { getToml, getModels, stem }) {
  const { body, close, onClose } = openModal("Generate page", { size: "wide" });
  const themes = runtime.isReady() ? await runtime.themeCatalog().catch(() => []) : [];
  const current = state.project.assembly.theme || "default";
  if (!themes.some((t) => t.name === current)) themes.push({ name: current, display: current });

  body.innerHTML =
    `<div class="gen-bar">` +
    `<label class="gen-theme">Theme <select id="gen-theme">` +
    themes.map((t) => `<option value="${esc(t.name)}"${t.name === current ? " selected" : ""}>${esc(t.display)}</option>`).join("") +
    `</select></label>` +
    `<span class="gen-status" id="gen-status" role="status">Rendering…</span>` +
    `<span class="gen-spacer"></span>` +
    `<button id="gen-download" class="primary">Download</button>` +
    `</div>` +
    `<div class="gen-warn" id="gen-warn" hidden></div>` +
    `<div class="gen-preview" id="gen-preview"></div>` +
    `<p class="gen-note">The page is one self-contained file: the viewer, the steps and the models are inside it. ` +
    `Run <code>3dstep ${esc(stem)}.toml</code> on the saved project and the GLB files beside it to get the same bytes.</p>`;

  const statusEl = body.querySelector("#gen-status");
  const previewEl = body.querySelector("#gen-preview");
  const themeEl = body.querySelector("#gen-theme");
  const downloadBtn = body.querySelector("#gen-download");
  let previewUrl = null;
  onClose(() => { if (previewUrl) URL.revokeObjectURL(previewUrl); });

  // The generated page reports its height with md-iframe's protocol; the
  // preview frame takes it, as a docs page would.
  const onMessage = (e) => {
    const frame = previewEl.querySelector("iframe");
    if (!frame || e.source !== frame.contentWindow) return;
    const data = e.data;
    if (!data || typeof data !== "object" || !("mdIframeHeight" in data)) return;
    const h = Number(data.mdIframeHeight);
    frame.style.height = h > 0 ? `${Math.min(h, 20000)}px` : "";
  };
  addEventListener("message", onMessage);
  onClose(() => removeEventListener("message", onMessage));

  // html is only read while ok is true, so a failed render can never hand
  // over the previous page as though it were current.
  let html = null;
  let ok = false;
  const setOk = (value) => {
    ok = value;
    downloadBtn.disabled = !value;
    downloadBtn.title = value ? `Save ${stem}.3dstep.html` : "Nothing to download until the page renders.";
  };
  setOk(false);

  const showWarnings = (warnings) => {
    const el = body.querySelector("#gen-warn");
    el.hidden = !warnings.length;
    el.innerHTML = warnings.length ? `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
  };

  const refresh = async () => {
    statusEl.textContent = "Rendering…";
    setOk(false);
    try {
      const models = getModels();
      const out = await runtime.generate(getToml(), models);
      html = out.html;
      setOk(true);
      showWarnings(out.warnings);
      // The runtime's share of the page, for the size estimate in the Parts panel.
      const inlined = Object.values(models).reduce((sum, b) => sum + Math.ceil(b.length / 3) * 4, 0);
      if (out.size > inlined) state.runtimeBytes = out.size - inlined;
      state.emit("models-measured", {});
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      previewEl.innerHTML = `<iframe src="${previewUrl}" title="Page preview"></iframe>`;
      statusEl.textContent = formatBytes(out.size);
    } catch (e) {
      setOk(false);
      showWarnings([]);
      previewEl.innerHTML = `<pre class="gen-error">${esc(e && e.message ? e.message : e)}</pre>`;
      statusEl.textContent = "Failed";
    }
  };

  // The dropdown is the project's theme, the same setting as the toolbar's.
  // Pending TOML that does not parse refuses the change: put it back.
  themeEl.addEventListener("change", () => {
    if (state.setAssembly({ theme: themeEl.value }, "visual") || state.project.assembly.theme === themeEl.value) refresh();
    else themeEl.value = state.project.assembly.theme || "default";
  });
  downloadBtn.addEventListener("click", () => {
    if (ok) downloadFile(html, `${stem}.3dstep.html`, "text/html");
  });

  await refresh();
  return close;
}

// ── About ───────────────────────────────────────────────────────────

export async function openAbout() {
  const { body } = openModal("About 3DStep");
  body.innerHTML =
    `<p>3DStep turns a CAD assembly into step-by-step interactive 3D assembly instructions. ` +
    `Import a STEP or GLB model, build the steps (which parts show, where they move, what is highlighted, ` +
    `arrows, labels, a camera and text for each), then press <strong>Generate</strong> to get one HTML ` +
    `file you can open in a browser or embed in a documentation site.</p>` +
    `<p>The designer runs everything in your browser, so nothing is uploaded. Save writes the project ` +
    `TOML and one GLB per model; the <code>3dstep</code> command turns those into the same page.</p>` +
    `<p class="about-version" id="about-version">Version: …</p>` +
    `<p class="about-links">` +
    `<a href="${DOCS_URL}" target="_blank" rel="noopener">Documentation</a>` +
    `<a href="${REPO_URL}" target="_blank" rel="noopener">Source on GitHub</a>` +
    `</p>`;
  const el = body.querySelector("#about-version");
  if (!runtime.isReady()) {
    el.textContent = runtime.failure()
      ? `Version: unknown (the renderer did not start). Viewer ${window.ThreeDStep ? window.ThreeDStep.VERSION : ""}`
      : "Version: waiting for the renderer to start…";
  }
  try {
    const v = await runtime.version();
    if (el.isConnected) el.textContent = `Version ${v}`;
  } catch (e) {
    if (el.isConnected && window.ThreeDStep) el.textContent = `Version: unknown (the renderer did not start). Viewer ${window.ThreeDStep.VERSION}`;
  }
}

/** Show the About box once per browser, for someone arriving with no context. */
export function maybeShowAboutOnFirstVisit() {
  let seen = null;
  try { seen = localStorage.getItem(ABOUT_SEEN_KEY); } catch (e) { seen = "1"; }
  if (seen) return;
  try { localStorage.setItem(ABOUT_SEEN_KEY, "1"); } catch (e) { /* private window */ }
  openAbout();
}

// ── Import ──────────────────────────────────────────────────────────

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

// Where occt-import-js comes from (SPEC 13.2): the local server serves the
// vendored copy; the hosted designer tries jsDelivr first (brotli, a long
// cache) and falls back to its own copy.
export function occtBaseUrls() {
  const local = LOCAL_HOSTS.includes(location.hostname) || location.protocol === "file:";
  return local ? [VENDOR_BASE] : [CDN_BASE, VENDOR_BASE];
}

const QUALITY_LABELS = {
  fine: "Fine",
  normal: "Normal",
  coarse: "Coarse",
};

function qualityText(q) {
  const p = QUALITY[q];
  return `${QUALITY_LABELS[q]} (deflection ${p.linearDeflection * 100}% of the size, ${Math.round(p.angularDeflection * 180 / Math.PI)}°)`;
}

function modelSummary(model) {
  const parts = model.meshes.length;
  const groups = model.nodes.length - parts;
  return `<strong>${formatCount(parts)}</strong> part${parts === 1 ? "" : "s"}` +
    (groups ? ` in <strong>${formatCount(groups)}</strong> group${groups === 1 ? "" : "s"}` : "") +
    `, <strong>${formatCount(triangleCount(model))}</strong> triangles, about <strong>${formatBytes(estimateGlbSize(model))}</strong> as GLB`;
}

// Import one file. Resolves to {model, bytes, title} or null when cancelled.
// options: {taken: file names in use, up: the project's up axis, fresh: the
// project has no models yet (its first model sets its up axis), last: the
// previous import's choices to start from}.
export function openImport(file, { taken = [], up = "z", fresh = false, last = {} } = {}) {
  const lower = file.name.toLowerCase();
  const isStep = lower.endsWith(".step") || lower.endsWith(".stp");
  // A first STEP model is Y-up unless chosen otherwise: Fusion, where most
  // of them come from, is.
  if (isStep) return importStepDialog(file, { taken, up: fresh ? (last.up || "y") : up, last });
  return importGlbDialog(file, { taken, up, last });
}

function importStepDialog(file, { taken, up, last }) {
  return new Promise((resolve) => {
    let result = null;
    let abort = null;
    let timer = null;
    const cancel = () => {
      if (abort) abort.abort();
      close();
    };
    const { body, close, onClose } = openModal("Import a STEP model", { size: "medium", onEscape: () => cancel() });
    onClose(() => {
      if (timer) clearInterval(timer);
      if (abort) abort.abort();
      resolve(result);
    });
    const opts = {
      quality: last.quality || "normal",
      minSize: last.minSize ?? 2,
      merge: last.merge !== false,
      simplify: last.simplify ?? 100,
      up: up || "z",
    };
    const title = file.name.replace(/\.[^.]*$/, "");
    const name = glbNameFor(file.name, taken);

    const head = `<div class="file-head"><span class="file-name">${esc(file.name)}</span>` +
      `<span class="file-size">${formatBytes(file.size)}</span><span class="file-size">→ ${esc(name)}</span></div>`;

    const showOptions = (error = "") => {
      body.innerHTML = head +
        `<div class="form-grid">` +
        `<label for="imp-quality">Quality</label><select id="imp-quality" class="field-select">` +
        Object.keys(QUALITY).map((q) => `<option value="${q}"${q === opts.quality ? " selected" : ""}>${esc(qualityText(q))}</option>`).join("") +
        `</select>` +
        `<label for="imp-min">Drop bodies</label><span class="inline">smaller than <input id="imp-min" class="field-input" type="number" min="0" step="0.5" value="${opts.minSize}"> mm</span>` +
        `<span class="hint">2 mm drops the passives and pins of an EDA export; 0 keeps every body.</span>` +
        `<label for="imp-merge">Bodies</label><label class="check"><input id="imp-merge" type="checkbox"${opts.merge ? " checked" : ""}> Merge each product's bodies into one part</label>` +
        `<span class="hint">After reading you can split single nodes into their bodies.</span>` +
        `<label for="imp-simplify">Simplify</label><span class="inline">to <input id="imp-simplify" class="field-input" type="number" min="5" max="100" step="5" value="${opts.simplify}"> % of the triangles</span>` +
        `<label for="imp-up">Up axis</label><select id="imp-up" class="field-select">` +
        `<option value="y"${opts.up === "y" ? " selected" : ""}>Y (Fusion, glTF)</option><option value="z"${opts.up === "z" ? " selected" : ""}>Z (most other CAD tools)</option></select>` +
        `</div>` +
        (error ? `<div class="dialog-error">${esc(error)}</div>` : "") +
        `<div class="modal-foot"><span class="spacer"></span>` +
        `<button class="toolbar-btn" data-act="cancel">Cancel</button>` +
        `<button class="toolbar-btn primary" data-act="read">Import</button></div>`;
      body.querySelector('[data-act="cancel"]').addEventListener("click", cancel);
      body.querySelector('[data-act="read"]').addEventListener("click", () => {
        opts.quality = body.querySelector("#imp-quality").value;
        opts.minSize = Math.max(0, Number(body.querySelector("#imp-min").value) || 0);
        opts.merge = body.querySelector("#imp-merge").checked;
        opts.simplify = Math.min(100, Math.max(5, Number(body.querySelector("#imp-simplify").value) || 100));
        opts.up = body.querySelector("#imp-up").value;
        read();
      });
      body.querySelector('[data-act="read"]').focus();
    };

    const read = async () => {
      abort = new AbortController();
      const started = performance.now();
      let message = `Reading ${file.name} (${formatBytes(file.size)})…`;
      body.innerHTML = head +
        `<div class="progress-line"><span class="spinner"></span><span id="imp-msg"></span><span id="imp-time"></span></div>` +
        `<p class="insp-note" style="margin-top:10px">Large assemblies take a while: the STEP reader runs OpenCascade in your browser, off the page's thread.</p>` +
        `<div class="modal-foot"><span class="spacer"></span><button class="toolbar-btn" data-act="cancel">Cancel</button></div>`;
      const msgEl = body.querySelector("#imp-msg");
      const timeEl = body.querySelector("#imp-time");
      const tick = () => {
        msgEl.textContent = message;
        timeEl.textContent = `${((performance.now() - started) / 1000).toFixed(0)} s`;
      };
      tick();
      timer = setInterval(tick, 500);
      body.querySelector('[data-act="cancel"]').addEventListener("click", cancel);
      try {
        const raw = await readStepRaw(file, {
          baseUrls: occtBaseUrls(), quality: opts.quality, signal: abort.signal, name: file.name,
          onProgress: (p) => { message = p.message; tick(); },
        });
        raw.source = { name: file.name, bytes: file.size };
        clearInterval(timer);
        timer = null;
        abort = null;
        review(raw);
      } catch (e) {
        clearInterval(timer);
        timer = null;
        abort = null;
        if (e && e.name === "AbortError") return;
        showOptions(e instanceof StepImportError || (e && e.message) ? e.message : String(e));
      }
    };

    // After reading: the parts it gives, nodes with several bodies to split,
    // the size filter and simplification to adjust. Building is quick, so
    // every change rebuilds; only the quality needs another read.
    const review = (raw) => {
      const tree = [];
      const walk = (n, depth) => {
        if (n.bodies > 1) tree.push({ ...n, depth });
        n.children.forEach((c) => walk(c, depth + 1));
      };
      rawTree(raw.result).forEach((n) => walk(n, 0));
      const meshes = raw.result.meshes || [];
      const names = new Map();
      const nodeAt = (src) => src.split("/").reduce((node, k) => (node && node.children ? node.children[Number(k)] : null), raw.result.root);
      for (const n of tree) {
        const node = nodeAt(n.src);
        const counts = new Map();
        for (const i of (node && node.meshes) || []) {
          // EDA exports number repeated bodies ("TopSilkscreen (12)"): one entry each.
          const nm = ((meshes[i] && meshes[i].name) || "unnamed").replace(/ \(\d+\)$/, "");
          counts.set(nm, (counts.get(nm) || 0) + 1);
        }
        const listed = [...counts].map(([nm, c]) => (c > 1 ? `${nm} ×${c}` : nm));
        names.set(n.src, listed.slice(0, 12).join(", ") + (listed.length > 12 ? `, and ${listed.length - 12} more names` : ""));
      }
      const split = new Set(opts.merge ? [] : tree.map((n) => n.src));
      let model = null;

      body.innerHTML = head +
        `<div class="form-grid">` +
        `<label for="rev-min">Drop bodies</label><span class="inline">smaller than <input id="rev-min" class="field-input" type="number" min="0" step="0.5" value="${opts.minSize}"> mm</span>` +
        `<label for="rev-simplify">Simplify</label><span class="inline">to <input id="rev-simplify" class="field-input" type="number" min="5" max="100" step="5" value="${opts.simplify}"> % of the triangles</span>` +
        `</div>` +
        `<p class="review-summary" id="rev-summary"></p>` +
        (tree.length
          ? `<p class="insp-note">These nodes have several bodies. A merged node is one part; split it to move or highlight its bodies one by one (a part cannot be split after import, but parts can always be merged).</p>` +
            `<div class="review-scroll"><table class="review-table"><thead><tr><th>Split</th><th>Node</th><th>Bodies</th><th>Triangles</th></tr></thead><tbody>` +
            tree.map((n) => `<tr><td><input type="checkbox" data-src="${esc(n.src)}"${split.has(n.src) ? " checked" : ""} aria-label="Split ${esc(n.label)} into its bodies"></td>` +
              `<td style="padding-left:${6 + n.depth * 12}px">${esc(n.label)}<div class="names">${esc(names.get(n.src) || "")}</div></td>` +
              `<td class="num">${formatCount(n.bodies)}</td><td class="num">${formatCount(n.triangles)}</td></tr>`).join("") +
            `</tbody></table></div>`
          : "") +
        `<div class="dialog-error" id="rev-error" hidden></div>` +
        `<div class="modal-foot"><button class="toolbar-btn" data-act="back">Other quality…</button><span class="spacer"></span>` +
        `<button class="toolbar-btn" data-act="cancel">Cancel</button>` +
        `<button class="toolbar-btn primary" data-act="add">Add to project</button></div>`;
      const summary = body.querySelector("#rev-summary");
      const errEl = body.querySelector("#rev-error");
      const addBtn = body.querySelector('[data-act="add"]');
      const rebuild = () => {
        errEl.hidden = true;
        try {
          model = modelFromRaw(raw, {
            name, minSize: opts.minSize, up: opts.up,
            mergeBodies: ({ src }) => !split.has(src.replace(/#own$/, "")),
          });
          const dropped = model.stats.counts.droppedBodies;
          summary.innerHTML = modelSummary(model) + (dropped ? `; ${formatCount(dropped)} small bod${dropped === 1 ? "y" : "ies"} dropped` : "") +
            (opts.simplify < 100 ? `, before simplifying to ${opts.simplify}%` : "") + ".";
          addBtn.disabled = false;
        } catch (e) {
          model = null;
          summary.textContent = "";
          errEl.hidden = false;
          errEl.textContent = e.message || String(e);
          addBtn.disabled = true;
        }
      };
      body.querySelectorAll("input[data-src]").forEach((box) => box.addEventListener("change", () => {
        if (box.checked) split.add(box.dataset.src);
        else split.delete(box.dataset.src);
        rebuild();
      }));
      body.querySelector("#rev-min").addEventListener("change", (e) => {
        opts.minSize = Math.max(0, Number(e.target.value) || 0);
        rebuild();
      });
      body.querySelector("#rev-simplify").addEventListener("change", (e) => {
        opts.simplify = Math.min(100, Math.max(5, Number(e.target.value) || 100));
        rebuild();
      });
      body.querySelector('[data-act="back"]').addEventListener("click", () => showOptions());
      body.querySelector('[data-act="cancel"]').addEventListener("click", cancel);
      addBtn.addEventListener("click", async () => {
        if (!model) return;
        addBtn.disabled = true;
        let out = model;
        if (opts.simplify < 100) {
          summary.textContent = "Simplifying…";
          try {
            out = (await simplifyModel(model, [], { ratio: opts.simplify / 100 })).model;
          } catch (e) {
            errEl.hidden = false;
            errEl.textContent = `Could not simplify: ${e.message || e}`;
            addBtn.disabled = false;
            return;
          }
        }
        Object.assign(last, opts);
        result = { model: out, bytes: null, title, up: opts.up };
        close();
      });
      rebuild();
      addBtn.focus();
    };

    showOptions();
  });
}

function importGlbDialog(file, { taken, up, last }) {
  return new Promise((resolve) => {
    let result = null;
    const { body, close, onClose } = openModal("Import a GLB model", { size: "medium" });
    onClose(() => resolve(result));
    const name = glbNameFor(file.name, taken);
    const title = file.name.replace(/\.[^.]*$/, "");
    body.innerHTML = `<div class="file-head"><span class="file-name">${esc(file.name)}</span>` +
      `<span class="file-size">${formatBytes(file.size)}</span><span class="file-size">→ ${esc(name)}</span></div>` +
      `<div class="progress-line"><span class="spinner"></span><span>Reading…</span></div>`;
    file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let meta = null;
      try {
        meta = isGlb(bytes) ? threedstepMetadata(parseGlb(bytes).json) : threedstepMetadata(JSON.parse(new TextDecoder().decode(bytes)));
      } catch (e) {
        meta = null;
      }
      const units = last.units || "m";
      const fileUp = last.fileUp || "y";
      body.innerHTML = `<div class="file-head"><span class="file-name">${esc(file.name)}</span>` +
        `<span class="file-size">${formatBytes(file.size)}</span><span class="file-size">→ ${esc(name)}</span></div>` +
        (meta
          ? `<p>A 3DStep model (${esc(meta.units || "mm")}, ${esc((meta.up || "z").toUpperCase())}-up): it is used as it is.</p>`
          : `<p class="insp-note">A GLB from another tool: say which unit and up axis it uses, and it is converted to millimeters and the project's ${esc(up.toUpperCase())}-up axes.</p>` +
            `<div class="form-grid">` +
            `<label for="glb-units">Unit</label><select id="glb-units" class="field-select">` +
            ["mm", "m", "in"].map((u) => `<option value="${u}"${u === units ? " selected" : ""}>${{ mm: "Millimeters", m: "Meters (glTF's unit)", in: "Inches" }[u]}</option>`).join("") +
            `</select>` +
            `<label for="glb-up">Up axis</label><select id="glb-up" class="field-select">` +
            `<option value="y"${fileUp === "y" ? " selected" : ""}>Y (glTF's convention)</option><option value="z"${fileUp === "z" ? " selected" : ""}>Z</option></select>` +
            `</div>`) +
        `<div class="dialog-error" id="glb-error" hidden></div>` +
        `<div class="modal-foot"><span class="spacer"></span>` +
        `<button class="toolbar-btn" data-act="cancel">Cancel</button>` +
        `<button class="toolbar-btn primary" data-act="add">Add to project</button></div>`;
      body.querySelector('[data-act="cancel"]').addEventListener("click", close);
      const addBtn = body.querySelector('[data-act="add"]');
      addBtn.focus();
      addBtn.addEventListener("click", () => {
        const errEl = body.querySelector("#glb-error");
        try {
          const unitsSel = body.querySelector("#glb-units");
          const upSel = body.querySelector("#glb-up");
          if (unitsSel) last.units = unitsSel.value;
          if (upSel) last.fileUp = upSel.value;
          const model = readGlb(bytes, {
            name, units: unitsSel ? unitsSel.value : "mm", up: upSel ? upSel.value : "z", targetUp: up || "z",
          });
          // A 3DStep GLB keeps its bytes: that is the file Save writes.
          result = { model, bytes: meta ? bytes : null, title, up: meta ? (meta.up || "z") : (up || "z") };
          close();
        } catch (e) {
          errEl.hidden = false;
          errEl.textContent = e instanceof GlbError || (e && e.message) ? `${file.name}: ${e.message}` : String(e);
        }
      });
    }, (e) => {
      body.innerHTML = `<div class="dialog-error">${esc(file.name)} could not be read: ${esc(e.message || e)}</div>`;
    });
  });
}

// ── Simplify and tiny parts ─────────────────────────────────────────

// Resolves to {ratio, error, permissive, scope: "selection" | "all"} or null.
export function openSimplify({ selected = 0, triangles = 0 } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const { body, close, onClose } = openModal("Simplify meshes");
    onClose(() => resolve(result));
    body.innerHTML =
      `<p class="insp-note">Fewer triangles make a smaller page that loads faster on a phone. Simplifying keeps the outline and the creases; the error bound stops it where the shape would change visibly.</p>` +
      `<div class="form-grid">` +
      `<label for="simp-ratio">Target</label><span class="inline"><input id="simp-ratio" class="field-input" type="number" min="5" max="95" step="5" value="50"> % of the triangles</span>` +
      `<label for="simp-error">Error bound</label><span class="inline"><input id="simp-error" class="field-input" type="number" min="0.1" max="10" step="0.1" value="1"> % of each mesh's size</span>` +
      `<label for="simp-permissive">Face borders</label><label class="check"><input id="simp-permissive" type="checkbox" checked> Simplify across the borders between faces</label>` +
      `<span class="hint">Needed to get EDA parts, made of many small faces, much smaller; turn it off to keep every face's outline exact.</span>` +
      `<label>Parts</label><span class="inline">` +
      `<label class="check"><input type="radio" name="simp-scope" value="selection"${selected ? " checked" : " disabled"}> ${selected ? `The ${formatCount(selected)} selected` : "The selection (none)"}</label>` +
      `<label class="check"><input type="radio" name="simp-scope" value="all"${selected ? "" : " checked"}> All (${formatCount(triangles)} triangles)</label></span>` +
      `</div>` +
      `<div class="modal-foot"><span class="spacer"></span><button class="toolbar-btn" data-act="cancel">Cancel</button>` +
      `<button class="toolbar-btn primary" data-act="ok">Simplify</button></div>`;
    body.querySelector('[data-act="cancel"]').addEventListener("click", close);
    body.querySelector('[data-act="ok"]').addEventListener("click", () => {
      const ratio = Math.min(95, Math.max(5, Number(body.querySelector("#simp-ratio").value) || 50)) / 100;
      const error = Math.min(10, Math.max(0.1, Number(body.querySelector("#simp-error").value) || 1)) / 100;
      const scope = body.querySelector('input[name="simp-scope"]:checked').value;
      result = { ratio, error, permissive: body.querySelector("#simp-permissive").checked, scope };
      close();
    });
    body.querySelector('[data-act="ok"]').focus();
  });
}

// Resolves to a size in mm, or null.
export function openSelectTiny({ last = 2 } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const { body, close, onClose } = openModal("Select tiny parts");
    onClose(() => resolve(result));
    body.innerHTML =
      `<p class="insp-note">Selects every part whose bounding box is smaller than this, such as the passives of an EDA board, so they can be deleted together.</p>` +
      `<div class="form-grid"><label for="tiny-mm">Smaller than</label><span class="inline"><input id="tiny-mm" class="field-input" type="number" min="0.1" step="0.5" value="${last}"> mm (bounding-box diagonal)</span></div>` +
      `<div class="modal-foot"><span class="spacer"></span><button class="toolbar-btn" data-act="cancel">Cancel</button>` +
      `<button class="toolbar-btn primary" data-act="ok">Select</button></div>`;
    body.querySelector('[data-act="cancel"]').addEventListener("click", close);
    body.querySelector('[data-act="ok"]').addEventListener("click", () => {
      result = Math.max(0.01, Number(body.querySelector("#tiny-mm").value) || last);
      close();
    });
    body.querySelector("#tiny-mm").select();
  });
}
