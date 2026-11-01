// The designer: wires the state, the panels, the viewport, the TOML tab, the
// runtime (Pyodide) and the file handling together (PinConnect's main.js).

import { ProjectState } from "./state.js";
import { Project } from "./project-model.js";
import { EditorPanel } from "./editor-panel.js";
import { PartsPanel } from "./parts-panel.js";
import { StepsPanel } from "./steps-panel.js";
import { InspectorPanel } from "./inspector-panel.js";
import { Viewport } from "./viewport.js";
import { parseProject, serializeProject } from "./toml-io.js";
import * as runtime from "./runtime.js";
import {
  downloadFile, esc, formatBytes, formatCount, maybeShowAboutOnFirstVisit, openAbout, openGenerate, openImport, openModal,
} from "./dialogs.js";
import { readGlb } from "./import/glb-reader.js";
import { treeOf } from "./import/model.js";
import { slugify } from "./import/ids.js";

const state = new ProjectState();
window.threedstepDesigner = { state };   // for the console and the browser tests

// ── Runtime ─────────────────────────────────────────────────────────

// Boot progress lives in the toolbar. Everything but Generate works while the
// renderer starts, and without it: importing, editing, saving.
function setupRuntimeStatus() {
  const el = document.getElementById("runtime-status");
  const genBtn = document.getElementById("generate-btn");
  const labels = { runtime: "Starting renderer…", package: "Loading 3DStep…", ready: "Ready" };
  runtime.onProgress((phase, detail) => {
    if (phase === "error") {
      el.className = "runtime-status error";
      el.textContent = "Renderer unavailable";
      el.title = detail;
      genBtn.disabled = true;
      genBtn.title = `Generate needs the renderer: ${detail}`;
      return;
    }
    el.className = "runtime-status" + (phase === "ready" ? " ready" : "");
    el.textContent = labels[phase] ?? "";
    el.title = phase === "ready" ? "" : "The renderer runs 3DStep's Python in your browser; it downloads once";
    genBtn.disabled = phase !== "ready";
    genBtn.title = phase === "ready" ? "Render the page and download it" : "Waiting for the renderer to start…";
  });
}

// The theme's palettes for the viewport preview, and the theme list.
async function loadThemes(viewport) {
  try {
    state.themes = await runtime.themeCatalog();
    state.emit("themes-loaded", {});
  } catch (e) {
    console.warn("3DStep designer: no theme list", e);
  }
  await applyThemeTokens(viewport);
}

let tokensFor = null;
async function applyThemeTokens(viewport) {
  const name = state.project.assembly.theme || "default";
  if (!runtime.isReady() || tokensFor === name) return;
  tokensFor = name;
  try {
    viewport.setTheme(await runtime.themeTokens(name));
  } catch (e) {
    // A theme the browser cannot see (a project theme_dir): the preview uses
    // the default look; Generate says so too.
    viewport.setTheme(await runtime.themeTokens("default").catch(() => null));
  }
}

// ── Tabs and layout ─────────────────────────────────────────────────

function setupPanelTabs(editorPanel) {
  const tabs = [...document.querySelectorAll(".panel-tab")];
  const storageKey = "threedstep-designer-tab";
  const activate = (tab, remember = true) => {
    // Finish a pending TOML keystroke before showing controls that act on the
    // project. Text that does not parse stays visible with its error.
    const leavingToml = document.getElementById("tab-toml").getAttribute("aria-selected") === "true";
    if (tab.id !== "tab-toml" && leavingToml && !editorPanel.flushChanges()) {
      editorPanel.textarea.focus();
      return false;
    }
    for (const candidate of tabs) {
      const active = candidate === tab;
      candidate.setAttribute("aria-selected", String(active));
      candidate.tabIndex = active ? 0 : -1;
      document.getElementById(candidate.getAttribute("aria-controls")).hidden = !active;
    }
    if (remember) {
      try { localStorage.setItem(storageKey, tab.id); } catch (_) { /* storage can be blocked */ }
    }
    return true;
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (e) => {
      const index = tabs.indexOf(tab);
      let next;
      if (e.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(index + tabs.length - 1) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      else return;
      e.preventDefault();
      if (activate(next)) next.focus();
    });
  }
  let initial = tabs[0];
  try { initial = tabs.find((tab) => tab.id === localStorage.getItem(storageKey)) || initial; } catch (_) { /* use default */ }
  activate(initial, false);
  return (id) => activate(document.getElementById(id));
}

function setupResizers(viewport) {
  const drag = (resizer, panel, sign) => {
    resizer.addEventListener("pointerdown", (e) => {
      if (getComputedStyle(resizer).display === "none") return;
      const startX = e.clientX;
      const startW = panel.offsetWidth;
      resizer.classList.add("active");
      resizer.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        panel.style.width = Math.max(180, Math.min(window.innerWidth * 0.6, startW + sign * (ev.clientX - startX))) + "px";
        viewport.resize();
      };
      const onUp = () => {
        resizer.classList.remove("active");
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
    });
  };
  drag(document.getElementById("resizer-left"), document.getElementById("panel-left"), 1);
  drag(document.getElementById("resizer-right"), document.getElementById("panel-inspector"), -1);
}

function setupThemeSelect(viewport) {
  const sel = document.getElementById("theme-select");
  const refresh = () => {
    const cur = state.project.assembly.theme || "default";
    const list = state.themes.slice();
    if (!list.some((t) => t.name === cur)) list.push({ name: cur, display: cur });
    sel.innerHTML = list.map((t) => `<option value="${esc(t.name)}"${t.name === cur ? " selected" : ""}>${esc(t.display)}</option>`).join("");
    applyThemeTokens(viewport);
  };
  refresh();
  sel.addEventListener("change", () => { if (!state.setAssembly({ theme: sel.value })) refresh(); });
  state.on("project-changed", refresh);
  state.on("themes-loaded", refresh);
}

function setupStyleSelect() {
  const sel = document.getElementById("style-select");
  const refresh = () => { sel.value = state.project.assembly.style; };
  refresh();
  sel.addEventListener("change", () => { if (!state.setAssembly({ style: sel.value })) refresh(); });
  state.on("project-changed", refresh);
}

// ── Banners ─────────────────────────────────────────────────────────

const banners = document.getElementById("banners");

function showBanner(key, html, { warn = false, actions = [] } = {}) {
  let el = banners.querySelector(`[data-banner="${key}"]`);
  if (!el) {
    el = document.createElement("div");
    el.dataset.banner = key;
    banners.appendChild(el);
  }
  el.className = `banner${warn ? " warn" : ""}`;
  el.innerHTML = `<span class="banner-text">${html}</span>`;
  for (const { label, onClick } of actions) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", onClick);
    el.appendChild(b);
  }
  const close = document.createElement("button");
  close.className = "banner-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => el.remove());
  el.appendChild(close);
}

function hideBanner(key) {
  banners.querySelector(`[data-banner="${key}"]`)?.remove();
}

// A project naming models the designer has not loaded (opened without them,
// or named in the TOML tab): offer to open each.
function refreshMissingBanner() {
  const missing = state.missingModels();
  if (!missing.length) {
    hideBanner("missing");
    return;
  }
  showBanner("missing",
    `The project names ${missing.map((m) => `<code>${esc(m)}</code>`).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not loaded. ` +
    "Open the GLB file to see and edit its parts; Generate needs every model.",
    { warn: true, actions: missing.slice(0, 3).map((name) => ({ label: `Open ${name}`, onClick: () => pickModelFor(name) })) });
}

function pickModelFor(name) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".glb";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (file) await attachGlb(file, name);
  });
  input.click();
}

async function attachGlb(file, name) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.attachModel(name, readGlb(bytes, { name, units: "mm", up: "z", targetUp: state.project.assembly.up }), bytes);
    return true;
  } catch (e) {
    showBanner("open-error", `${esc(file.name)} could not be read: ${esc(e.message || e)}`, { warn: true });
    return false;
  }
}

// ── Saving and unsaved work ─────────────────────────────────────────

// state.file holds the TOML as last saved or opened. Comparing the editor's
// text with it is what "unsaved" means for the project; the models track their
// own state. It is part of the undo history, so undoing an Open brings back the
// previous project's file name too.
function hasUnsavedChanges(editorPanel) {
  const { savedText } = state.file;
  return (savedText !== null && editorPanel.getValue() !== savedText) || state.dirtyModels.size > 0;
}

function defaultStem() {
  if (state.file.name) return state.file.name;
  const title = state.project.assembly.title;
  if (title && title !== new Project().assembly.title) return slugify(title);
  const first = state.project.assembly.models[0];
  return first ? first.replace(/\.glb$/i, "") : "assembly";
}

let editorRef = null;
function updateTitle() {
  const dirty = editorRef && hasUnsavedChanges(editorRef);
  document.title = `${dirty ? "• " : ""}${state.project.assembly.title} · 3DStep Designer`;
}

// Text fields commit on change, which the browser fires when a field loses
// focus. Keyboard shortcuts act without moving focus, so a value still being
// typed would be missing from a save, and undo would take back the step
// before it. Run such an action the way its button does: commit the focused
// field first, once, then give it its focus and caret back.
function withActiveField(action = () => {}) {
  const field = document.activeElement;
  const editable = (field instanceof HTMLInputElement && ["text", "search", "number"].includes(field.type))
    || (field instanceof HTMLTextAreaElement && field.id !== "code-input");
  if (!editable) return action();
  const { id } = field;
  const sel = field.type === "number" ? null : [field.selectionStart, field.selectionEnd, field.selectionDirection];
  field.blur();
  action();
  // The commit or the action can re-render the field's form, so find the
  // field again by id when the original is gone.
  const target = field.isConnected ? field : id && document.getElementById(id);
  if (!target) return;
  target.focus();
  if (sel && target.setSelectionRange) target.setSelectionRange(...sel);
}

function setupUnloadGuard(editorPanel) {
  addEventListener("beforeunload", (e) => {
    withActiveField();
    if (!hasUnsavedChanges(editorPanel)) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

async function writeWithPicker(data, suggestedName, types, startIn) {
  const handle = await window.showSaveFilePicker({ suggestedName, types, ...(startIn ? { startIn } : {}) });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
  return handle;
}

// The TOML, then every model not yet saved as it is, each beside the other.
async function saveProject(editorPanel) {
  if (!editorPanel.flushChanges()) {
    state.emit("source-error", {});
    return;
  }
  const text = editorPanel.getValue();
  const stem = defaultStem();
  const dirty = state.project.assembly.models.filter((n) => state.dirtyModels.has(n) && state.models.has(n));
  const written = {};
  const saved = [];
  const notes = [];
  let tomlName = `${stem}.toml`;
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await writeWithPicker(text, tomlName, [{ description: "3DStep project", accept: { "text/plain": [".toml"] } }]);
    } catch (e) {
      if (e.name === "AbortError") return;   // cancelling the picker is not a save
      showBanner("save", `Could not save the project: ${esc(e.message || e)}`, { warn: true });
      return;
    }
    tomlName = handle.name;
    saved.push(tomlName);
    for (const name of dirty) {
      const bytes = state.glbBytes(name);
      try {
        const h = await writeWithPicker(bytes, name, [{ description: "GLB model", accept: { "model/gltf-binary": [".glb"] } }], handle);
        written[name] = bytes;
        saved.push(h.name);
        if (h.name !== name.split("/").pop()) notes.push(`${h.name} must be named ${name} for the project to find it.`);
      } catch (e) {
        notes.push(`${name} was not saved${e.name === "AbortError" ? "" : `: ${e.message || e}`}.`);
      }
    }
  } else {
    downloadFile(text, tomlName, "text/plain");
    saved.push(tomlName);
    for (const name of dirty) {
      const bytes = state.glbBytes(name);
      downloadFile(bytes, name.split("/").pop(), "model/gltf-binary");
      written[name] = bytes;
      saved.push(name);
    }
  }
  state.markFileSaved(tomlName.replace(/\.toml$/i, ""), text);
  state.markModelsSaved(written);
  const models = state.project.assembly.models;
  showBanner("save",
    `Saved ${saved.map((n) => `<code>${esc(n)}</code>`).join(", ")}. ` +
    (models.length ? `Keep ${models.length === 1 ? "the model" : "the models"} (${models.map((m) => `<code>${esc(m)}</code>`).join(", ")}) beside <code>${esc(tomlName)}</code>: the project finds ${models.length === 1 ? "it" : "them"} by file name. ` : "") +
    (notes.length ? esc(notes.join(" ")) : ""),
    { warn: notes.length > 0 });
}

// ── Opening and importing ───────────────────────────────────────────

const importChoices = {};

async function importFiles(files, editorPanel, showTab) {
  for (const file of files) {
    if (!editorPanel.flushChanges()) {
      state.emit("source-error", {});
      return;
    }
    const taken = [...state.project.assembly.models, ...state.models.keys()];
    const fresh = !state.project.assembly.models.length;
    const result = await openImport(file, { taken, up: state.project.assembly.up, fresh, last: importChoices });
    if (!result) continue;
    const name = state.addModel(result.model, { bytes: result.bytes, title: result.title, up: result.up });
    if (name) showTab("tab-parts");
  }
}

// A project TOML with its GLB files (matched by file name); GLB files alone
// fill in models the project names but has not loaded.
async function openFiles(files, editorPanel, showTab) {
  const list = [...files];
  const toml = list.find((f) => /\.toml$/i.test(f.name));
  const glbs = list.filter((f) => /\.glb$/i.test(f.name));
  if (!toml) {
    const missing = state.missingModels();
    const rest = [];
    for (const file of glbs) {
      const name = missing.find((m) => m.split("/").pop() === file.name);
      if (name) await attachGlb(file, name);
      else rest.push(file);
    }
    if (rest.length) await importFiles(rest, editorPanel, showTab);
    return;
  }
  // LF, as the editor (a textarea) holds it, so an opened file is not "unsaved" at once.
  const text = (await toml.text()).replace(/\r\n?/g, "\n");
  let parsed;
  try {
    parsed = parseProject(text);
  } catch (e) {
    // Show the file and its error rather than keep editing the old project
    // as if it were this one.
    editorPanel.setValue(text);
    showTab("tab-toml");
    editorPanel.revealLine(e.line || 1);
    showBanner("open-error", `${esc(toml.name)} has a problem on line ${e.line || "?"}: ${esc(e.message)}`, { warn: true });
    return;
  }
  const models = new Map();
  const bytesMap = new Map();
  const problems = [];
  for (const name of parsed.project.assembly.models) {
    const file = glbs.find((f) => f.name === name.split("/").pop());
    if (!file) continue;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      models.set(name, readGlb(bytes, { name, units: "mm", up: "z", targetUp: parsed.project.assembly.up }));
      bytesMap.set(name, bytes);
    } catch (e) {
      problems.push(`${file.name}: ${e.message || e}`);
    }
  }
  if (!state.loadProject(parsed.project, { models, bytes: bytesMap, origin: "open", sourceText: text, fileName: toml.name.replace(/\.toml$/i, "") })) return;
  hideBanner("open-error");
  hideBanner("save");
  if (problems.length) showBanner("open-error", esc(problems.join(" ")), { warn: true });
}

function setupFileIO(editorPanel, viewport, showTab) {
  const importInput = document.getElementById("import-input");
  importInput.addEventListener("change", async () => {
    const files = [...importInput.files];
    importInput.value = "";
    await importFiles(files, editorPanel, showTab);
  });
  const openInput = document.getElementById("open-input");
  openInput.addEventListener("change", async () => {
    const files = [...openInput.files];
    openInput.value = "";
    await openFiles(files, editorPanel, showTab);
  });
  document.getElementById("save-btn").addEventListener("click", () => saveProject(editorPanel));

  // Drop on the viewport: a TOML opens a project, anything else imports.
  const vp = viewport.el;
  let depth = 0;
  const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  vp.addEventListener("dragenter", (e) => { if (isFiles(e)) { depth++; vp.classList.add("dragover"); } });
  vp.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; vp.classList.remove("dragover"); } });
  vp.addEventListener("dragover", (e) => { if (isFiles(e)) e.preventDefault(); });
  vp.addEventListener("drop", async (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    depth = 0;
    vp.classList.remove("dragover");
    const files = [...e.dataTransfer.files];
    const toml = files.find((f) => /\.toml$/i.test(f.name));
    // Name what the chosen path leaves out, so a drop never does nothing silently.
    const skipped = toml
      ? files.filter((f) => f !== toml && !/\.glb$/i.test(f.name))
      : files.filter((f) => !/\.(step|stp|glb|gltf)$/i.test(f.name));
    if (skipped.length) {
      showBanner("drop",
        `Skipped ${skipped.map((f) => `<code>${esc(f.name)}</code>`).join(", ")}: ` +
        (toml ? `a drop with a project .toml opens <code>${esc(toml.name)}</code> and its .glb files only; drop .step, .stp, .glb or .gltf files on their own to import them.`
          : "drop .step, .stp, .glb or .gltf files to import models, or a project .toml with its .glb files."),
        { warn: true });
    } else {
      hideBanner("drop");
    }
    if (toml) await openFiles(files, editorPanel, showTab);
    else if (files.every((f) => /\.glb$/i.test(f.name)) && state.missingModels().length) await openFiles(files, editorPanel, showTab);
    else await importFiles(files.filter((f) => /\.(step|stp|glb|gltf)$/i.test(f.name)), editorPanel, showTab);
  });
  // A file dropped anywhere else (a panel, the toolbar, a dialog's backdrop)
  // is refused: left alone, the browser would open it and leave the designer.
  // The viewport's handlers run first and have already accepted their drops.
  document.addEventListener("dragover", (e) => {
    if (!isFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  });
  document.addEventListener("drop", (e) => { if (isFiles(e)) e.preventDefault(); });
}

// ── Validation and the status bar ───────────────────────────────────

let problems = { errors: [], warnings: [] };
let validateTimer = null;

function scheduleValidation(editorPanel) {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(async () => {
    if (!runtime.isReady()) return;
    // An empty start has nothing to check yet (the command line would say it names no model).
    if (!state.project.assembly.models.length) {
      problems = { errors: [], warnings: [] };
      renderStatus();
      return;
    }
    const trees = {};
    for (const model of state.loadedModels()) trees[model.name] = treeOf(model);
    try {
      problems = await runtime.validate(editorPanel.getValue(), trees);
    } catch (e) {
      problems = { errors: [e.message || String(e)], warnings: [] };
    }
    renderStatus();
  }, 600);
}

function renderStatus() {
  const bar = document.getElementById("statusbar");
  const st = state;
  const bits = [];
  if (st.currentStep >= 0) bits.push(`<span>Step ${st.currentStep + 1} of ${st.project.steps.length}</span>`);
  else if (st.loadedModels().length) bits.push("<span>No steps</span>");
  const sel = st.selection;
  if (sel.parts.length) bits.push(`<span>${sel.parts.length} selected</span>`);
  else if (sel.arrow >= 0) bits.push(`<span>Arrow ${sel.arrow + 1} selected</span>`);
  else if (sel.label >= 0) bits.push(`<span>Label ${sel.label + 1} selected</span>`);
  bits.push('<span class="status-spacer"></span>');
  if (st.loadedModels().length) {
    bits.push(`<span>${formatCount(st.triangles())} triangles</span>`);
    bits.push(`<span>≈ ${formatBytes(st.pageSize())} page</span>`);
  }
  const ne = problems.errors.length, nw = problems.warnings.length;
  if (ne || nw) {
    bits.push(`<button id="status-problems" class="${ne ? "status-error" : "status-warn"}" title="Show what the 3dstep command would report">` +
      `${ne ? `${ne} error${ne === 1 ? "" : "s"}` : ""}${ne && nw ? ", " : ""}${nw ? `${nw} warning${nw === 1 ? "" : "s"}` : ""}</button>`);
  } else if (runtime.isReady() && st.loadedModels().length) {
    bits.push('<span title="The project passes the checks the 3dstep command makes">✓ valid</span>');
  }
  bar.innerHTML = bits.join("");
  bar.querySelector("#status-problems")?.addEventListener("click", () => {
    const { body } = openModal("Problems the 3dstep command would report", { size: "medium" });
    const list = (items, cls) => items.map((p) => `<li class="${cls}">${esc(p)}</li>`).join("");
    body.innerHTML = `<ul style="padding-left:18px;display:flex;flex-direction:column;gap:6px">${list(problems.errors, "status-error")}${list(problems.warnings, "status-warn")}</ul>`;
  });
  updateTitle();
}

// ── Start ───────────────────────────────────────────────────────────

function init() {
  setupRuntimeStatus();
  const editorPanel = new EditorPanel(document.getElementById("editor-container"), state);
  editorRef = editorPanel;
  const viewport = new Viewport(document.getElementById("viewport"), state);
  viewport.setTheme(null);
  new PartsPanel(document.getElementById("parts-tab-panel"), state);
  new StepsPanel(document.getElementById("steps-tab-panel"), state, viewport);
  new InspectorPanel(document.getElementById("inspector-body"), document.getElementById("inspector-title"), state, viewport);
  window.threedstepDesigner.viewport = viewport;
  window.threedstepDesigner.editor = editorPanel;

  const showTab = setupPanelTabs(editorPanel);
  state.on("source-error", () => {
    showTab("tab-toml");
    editorPanel.textarea.focus();
  });
  setupResizers(viewport);
  setupFileIO(editorPanel, viewport, showTab);
  setupThemeSelect(viewport);
  setupStyleSelect();

  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const updateUndoButtons = () => {
    undoBtn.disabled = !state.canUndo;
    redoBtn.disabled = !state.canRedo;
  };
  state.on("undo-changed", updateUndoButtons);
  // Commit pending typing before going through history, in a field as in the
  // TOML tab. A parse error must not disable Undo: going back to a snapshot is
  // also a way to fix it.
  const undo = () => withActiveField(() => { editorPanel.flushChanges(); state.undo(); });
  const redo = () => withActiveField(() => { editorPanel.flushChanges(); state.redo(); });
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);

  document.addEventListener("keydown", (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const mod = e.ctrlKey || e.metaKey;
    // A dialog is on top: its keys are its own, and the project must not
    // change behind it. Ctrl+S still never reaches the browser's Save Page.
    if (e.defaultPrevented) return;
    if (document.querySelector(".modal-backdrop")) {
      if (key === "s" && mod) e.preventDefault();
      return;
    }
    const active = document.activeElement;
    const typing = active && (active.matches("input, textarea, select") || active.isContentEditable);
    if (key === "s" && mod) {
      e.preventDefault();
      withActiveField(() => saveProject(editorPanel));
      return;
    }
    if (key === "z" && mod && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if ((key === "y" && mod) || (key === "z" && mod && e.shiftKey)) {
      e.preventDefault();
      redo();
      return;
    }
    // Escape in an inspector field (the Label tool leaves the focus in its
    // text) hands the keyboard back: the field commits as on leaving it, and
    // the key cancels the tool as it does from the viewport.
    if (typing && key === "Escape" && active.closest("#panel-inspector")) {
      active.blur();
      if (viewport.cancelTool()) e.preventDefault();
      return;
    }
    if (typing) return;
    if (viewport.keyDown(e)) {
      e.preventDefault();
      return;
    }
    const inList = active && active.closest && active.closest(".tree, .step-list");
    if (key === "Delete" || key === "Backspace") {
      const sel = state.selection;
      if (sel.arrow >= 0) state.removeArrow(sel.arrow);
      else if (sel.label >= 0) state.removeLabel(sel.label);
      else if (sel.parts.length) state.removeFromStep(sel.parts);
      else return;
      e.preventDefault();
    } else if (key === "d" && mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (state.currentStep >= 0) state.duplicateStep(state.currentStep);
    } else if (key === "Escape") {
      if (viewport.cancelTool()) e.preventDefault();
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && !inList && !mod && !e.altKey) {
      if (state.currentStep < 0) return;
      e.preventDefault();
      state.setCurrentStep(state.currentStep + (key === "ArrowRight" ? 1 : -1));
    }
  });

  // The empty start: a project with no model yet. Nothing to lose.
  const start = new Project();
  const text = serializeProject(start);
  state.loadProject(start, { origin: "init", sourceText: text });
  setupUnloadGuard(editorPanel);

  for (const ev of ["project-changed", "models-changed"]) {
    state.on(ev, () => {
      refreshMissingBanner();
      scheduleValidation(editorPanel);
    });
  }
  for (const ev of ["project-changed", "models-changed", "step-changed", "selection-changed", "dirty-changed", "models-measured", "source-synced"]) {
    state.on(ev, renderStatus);
  }
  renderStatus();

  document.getElementById("generate-btn").addEventListener("click", () => {
    if (!editorPanel.flushChanges()) {
      state.emit("source-error", {});
      return;
    }
    openGenerate(state, {
      getToml: () => editorPanel.getValue(),
      getModels: () => {
        const out = {};
        for (const name of state.project.assembly.models) if (state.models.has(name)) out[name] = state.glbBytes(name);
        return out;
      },
      stem: defaultStem(),
    });
  });
  document.getElementById("about-btn").addEventListener("click", openAbout);

  // The renderer boots in the background; the themes, the validation and
  // Generate wait for it, nothing else does.
  runtime.ready().then(() => {
    loadThemes(viewport);
    scheduleValidation(editorPanel);
    renderStatus();
  }, () => renderStatus());

  maybeShowAboutOnFirstVisit();
}

init();
