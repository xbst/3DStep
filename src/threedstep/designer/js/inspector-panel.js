// The inspector: what the selection is (SPEC 12.1 item 5). Nothing selected:
// the current step (id, title, text, note, camera, its lists as chips, moves,
// arrows, labels). Parts: id, name, color, this step's visibility, highlight
// and ghost, the move (offset, rotate, auto arrow), Assemble. An arrow or a
// label: its fields, with "pick" buttons the viewport tools enable (chunk 05).
//
// Fields commit on change (Enter, or leaving the field), so a retyped value is
// one undo step. The form is rebuilt only when what it shows changes kind or
// identity; otherwise values update in place and the focused field is left
// alone, so a click between typing and its commit is never lost.

import { ARROW_KINDS, LABEL_SIDES, expandIds, membersOf } from "./project-model.js";
import { esc } from "./dialogs.js";

const fmt = (v) => (Number.isFinite(v) ? String(Number(v.toFixed(4))) : "");
const AXES = ["x", "y", "z"];

function vecInputs(id, title) {
  return `<span class="vec" role="group" aria-label="${esc(title)}">` + AXES.map((a, k) =>
    `<label>${a}<input class="field-input" type="number" step="any" id="${id}-${k}" data-vec="${id}" aria-label="${esc(title)} ${a}"></label>`).join("") + `</span>`;
}

export class InspectorPanel {
  constructor(container, titleEl, state, viewport) {
    this.container = container;
    this.titleEl = titleEl;
    this.state = state;
    this.viewport = viewport;
    this._key = null;
    for (const ev of ["project-changed", "selection-changed", "step-changed", "models-changed"]) state.on(ev, () => this.render());
    container.addEventListener("change", (e) => this._onChange(e));
    container.addEventListener("input", (e) => this._onInput(e));
    container.addEventListener("click", (e) => this._onClick(e));
    this.render();
  }

  // ── What is shown ──────────────────────────────────────────────────

  _mode() {
    const st = this.state;
    const step = st.step();
    const sel = st.selection;
    if (step && sel.arrow >= 0 && step.arrows[sel.arrow]) return { kind: "arrow", index: sel.arrow, item: step.arrows[sel.arrow] };
    if (step && sel.label >= 0 && step.labels[sel.label]) return { kind: "label", index: sel.label, item: step.labels[sel.label] };
    if (sel.parts.length) return { kind: "parts", ids: sel.parts };
    if (step) return { kind: "step" };
    return { kind: st.loadedModels().length ? "nostep" : "none" };
  }

  render() {
    const m = this._mode();
    const st = this.state;
    const key = m.kind === "arrow" ? `arrow:${st.currentStep}:${m.index}:${m.item.kind}`
      : m.kind === "label" ? `label:${st.currentStep}:${m.index}`
      : m.kind === "parts" ? `parts:${m.ids.join(",")}:${st.currentStep >= 0}`
      : m.kind === "step" ? `step:${st.currentStep}` : m.kind;
    if (key !== this._key) {
      this._key = key;
      this.container.innerHTML = this[`_build_${m.kind}`](m);
    }
    this[`_fill_${m.kind}`](m);
  }

  _set(id, value) {
    const el = this.container.querySelector(`#${id}`);
    if (!el || document.activeElement === el) return;
    if (el.type === "checkbox") el.checked = !!value;
    else if (el.value !== value) el.value = value;
  }

  _setVec(id, v, mixed = false) {
    AXES.forEach((_, k) => {
      const el = this.container.querySelector(`#${id}-${k}`);
      if (!el || document.activeElement === el) return;
      el.value = mixed || !v ? "" : fmt(v[k]);
      el.placeholder = mixed ? "mixed" : "";
    });
  }

  _readVec(id) {
    const v = AXES.map((_, k) => Number(this.container.querySelector(`#${id}-${k}`).value));
    return v.every(Number.isFinite) && AXES.every((_, k) => this.container.querySelector(`#${id}-${k}`).value.trim() !== "") ? v : null;
  }

  _idsDatalist() {
    return `<datalist id="insp-ids">${this.state.registry.order.map((id) => `<option value="${esc(id)}"></option>`).join("")}</datalist>`;
  }

  // ── Nothing to show ────────────────────────────────────────────────

  _build_none() {
    this.titleEl.textContent = "Inspector";
    return `<p class="insp-note">Import a STEP or GLB model to start, or open a saved project. ` +
      `Then add steps in the Steps tab, choose what each step shows in the Parts tab, and click parts in the viewport to move or highlight them.</p>`;
  }

  _fill_none() {}

  _build_nostep() {
    this.titleEl.textContent = "Inspector";
    return `<p class="insp-note">The project has no steps yet.</p><div class="insp-buttons"><button class="small-btn primary" data-act="add-step">+ Add step</button></div>`;
  }

  _fill_nostep() {}

  // ── Step ───────────────────────────────────────────────────────────

  _build_step() {
    this.titleEl.textContent = "Inspector · Step";
    const chipRow = (key, label) => `<div class="insp-row top"><span class="insp-label">${label}</span><div class="insp-value chips" id="insp-chips-${key}"></div></div>`;
    return `<div class="insp">` +
      `<div class="insp-head"><span class="insp-kind" id="insp-step-head"></span><span class="insp-sub" id="insp-step-sub"></span></div>` +
      `<div class="insp-row"><label for="insp-id">Id</label><input id="insp-id" class="field-input" autocomplete="off" spellcheck="false" title="For ?step= links; a slug, unique among the steps. Leave empty for step-N"></div>` +
      `<div class="insp-row"><label for="insp-title">Title</label><input id="insp-title" class="field-input" autocomplete="off"></div>` +
      `<div class="insp-row top"><label for="insp-text">Text</label><textarea id="insp-text" class="field-textarea" rows="5" ` +
      `placeholder="What to do in this step. A blank line starts a paragraph; **bold**, \`code\` and [links](https://…) work."></textarea></div>` +
      `<div class="insp-row top"><span class="insp-label">Preview</span><div class="insp-value text-preview" id="insp-preview"></div></div>` +
      `<div class="insp-row top"><label for="insp-note">Note</label><textarea id="insp-note" class="field-textarea" rows="2" placeholder="Optional: a callout under the text"></textarea></div>` +
      `<div class="insp-section">Camera</div>` +
      `<div class="insp-row"><span class="insp-label">Camera</span><span class="insp-value insp-note" id="insp-cam-state"></span></div>` +
      `<div class="insp-buttons"><button class="small-btn" data-act="cam-use" title="Use the current view as this step's camera">Use view</button>` +
      `<button class="small-btn" data-act="cam-fit" title="Frame the parts this step highlights, from the previous step's direction">Fit highlighted</button>` +
      `<button class="small-btn" data-act="cam-clear" title="Inherit the previous step's camera again">Clear</button></div>` +
      `<div class="insp-section">What this step changes</div>` +
      chipRow("show", "Shows") + chipRow("hide", "Hides") + chipRow("highlight", "Highlights") + chipRow("ghost", "Ghosts") +
      `<div class="insp-section">Moves</div><div class="item-list" id="insp-moves"></div>` +
      `<div class="insp-section">Arrows <button class="small-btn" data-act="add-arrow" title="Add an arrow (edit its points below, or place it with the viewport's arrow tool)">+ Arrow</button></div><div class="item-list" id="insp-arrows"></div>` +
      `<div class="insp-section">Labels <button class="small-btn" data-act="add-label" title="Add a callout label">+ Label</button></div><div class="item-list" id="insp-labels"></div>` +
      `</div>`;
  }

  _fill_step() {
    const st = this.state;
    const i = st.currentStep;
    const step = st.step();
    const p = st.project;
    this.container.querySelector("#insp-step-head").textContent = `Step ${i + 1} of ${p.steps.length}`;
    this.container.querySelector("#insp-step-sub").textContent = p.stepTitle(i);
    const idEl = this.container.querySelector("#insp-id");
    idEl.placeholder = `step-${i + 1}`;
    this._set("insp-id", step.id);
    this.container.querySelector("#insp-title").placeholder = `Step ${i + 1}`;
    this._set("insp-title", step.title);
    this._set("insp-text", step.text.replace(/\n$/, ""));
    this._set("insp-note", step.note.replace(/\n$/, ""));
    if (document.activeElement !== this.container.querySelector("#insp-text")) this._preview(step.text);
    let cam;
    if (!step.camera) cam = i === 0 ? (p.camera ? "the home view" : "fits the model") : "inherited from the previous step";
    else if (step.camera.position) cam = `this step's own (${step.camera.projection || "orthographic"}, fov ${fmt(step.camera.fov ?? 35)}°)`;
    else if (step.camera.fit) cam = `fits ${step.camera.fit.join(", ")}`;
    else cam = `inherited, fov ${fmt(step.camera.fov)}`;
    this.container.querySelector("#insp-cam-state").textContent = cam;
    this.container.querySelector('[data-act="cam-clear"]').disabled = !step.camera;
    this.container.querySelector('[data-act="cam-use"]').disabled = !st.loadedModels().length;
    this.container.querySelector('[data-act="cam-fit"]').disabled = !step.highlight.length;
    for (const key of ["show", "hide", "highlight", "ghost"]) {
      const box = this.container.querySelector(`#insp-chips-${key}`);
      box.innerHTML = step[key].length ? step[key].map((id) => {
        const known = st.registry.members.has(id);
        return `<span class="chip${known ? "" : " unknown"}" title="${known ? esc(st.displayName(id)) : "No loaded model has this id"}">` +
          `<span data-select="${esc(id)}">${esc(id)}</span><button data-unlist="${key}" data-id="${esc(id)}" aria-label="Remove ${esc(id)} from ${key}" title="Remove from this list">×</button></span>`;
      }).join("") : `<span class="chips-empty">none</span>`;
    }
    const moves = this.container.querySelector("#insp-moves");
    moves.innerHTML = step.moves.length ? step.moves.map((m, j) =>
      `<div class="item-row" data-move="${j}" title="Select these parts"><span>${esc(m.parts.join(", "))}</span>` +
      `<span class="insp-sub">${m.offset.some((v) => v) ? `[${m.offset.map(fmt).join(", ")}]` : ""}${m.rotate.some((v) => v) ? ` ⟳[${m.rotate.map(fmt).join(", ")}]` : ""}</span></div>`).join("")
      : `<span class="chips-empty">Select parts and give them an offset to explode them in this step.</span>`;
    const arrows = this.container.querySelector("#insp-arrows");
    arrows.innerHTML = step.arrows.map((a, j) => `<div class="item-row" data-arrow="${j}"><span>${a.kind === "rotate" ? "⟳" : "➝"} ${esc(a.label || `Arrow ${j + 1}`)}</span>` +
      `<span class="insp-sub">${esc(a.attach)}</span></div>`).join("") || `<span class="chips-empty">none</span>`;
    const labels = this.container.querySelector("#insp-labels");
    labels.innerHTML = step.labels.map((l, j) => `<div class="item-row" data-label="${j}"><span>${esc(l.text)}</span><span class="insp-sub">${esc(l.attach)}</span></div>`).join("")
      || `<span class="chips-empty">none</span>`;
  }

  _preview(text) {
    const el = this.container.querySelector("#insp-preview");
    if (!el) return;
    const html = window.ThreeDStep ? window.ThreeDStep.renderText(text) : "";
    el.innerHTML = html || '<span class="chips-empty">no text</span>';
  }

  // ── Parts ──────────────────────────────────────────────────────────

  _build_parts(m) {
    const st = this.state;
    const ids = m.ids;
    const single = ids.length === 1 ? ids[0] : null;
    const isGroup = single && st.registry.groups.has(single);
    this.titleEl.textContent = single ? (isGroup ? "Inspector · Group" : "Inspector · Part") : "Inspector · Parts";
    const hasStep = st.currentStep >= 0;
    let html = `<div class="insp">`;
    if (single) {
      const label = st.registry.label.get(single) || single;
      html += `<div class="insp-head"><span class="insp-kind">${isGroup ? "Group" : "Part"}</span><span class="insp-sub" title="The model file">${esc(st.registry.model.get(single) || "not in a loaded model")}</span></div>` +
        `<div class="insp-row"><span class="insp-label">Id</span><code class="insp-value" title="Ids never change after import, so the steps' references stay valid">${esc(single)}</code></div>` +
        `<div class="insp-row"><span class="insp-label">CAD name</span><span class="insp-value insp-sub">${esc(label)}</span></div>` +
        (isGroup ? `<div class="insp-row"><span class="insp-label">Parts</span><span class="insp-value insp-sub">${membersOf(st.registry, single).length}</span></div>` : "") +
        `<div class="insp-row"><label for="insp-name">Name</label><input id="insp-name" class="field-input" autocomplete="off" placeholder="${esc(label)}" title="The display name, for labels and the designer"></div>` +
        `<div class="insp-row"><label for="insp-color">Color</label><span class="color-row"><input type="color" id="insp-color" title="Overrides the model's color in the shaded style">` +
        `<span class="insp-sub" id="insp-color-text"></span><button class="small-btn" data-act="color-clear">Model's</button></span></div>`;
    } else {
      html += `<div class="insp-head"><span class="insp-kind">${ids.length} selected</span><span class="insp-sub">${expandIds(st.registry, ids).length} parts</span></div>` +
        `<div class="chips">${ids.map((id) => `<span class="chip"><span data-select="${esc(id)}" title="Select only this">${esc(id)}</span></span>`).join("")}</div>`;
    }
    if (hasStep) {
      html += `<div class="insp-section">In step ${st.currentStep + 1}</div>` +
        `<div class="checks"><label class="check"><input type="checkbox" id="insp-vis"> Visible</label>` +
        `<label class="check"><input type="checkbox" id="insp-hi"> Highlight</label>` +
        `<label class="check"><input type="checkbox" id="insp-gh"> Ghost</label></div>` +
        `<div class="insp-section">Move <button class="small-btn" data-act="assemble" title="Back to the assembled pose in this step">Assemble</button></div>` +
        `<div class="insp-row"><span class="insp-label">Offset mm</span>${vecInputs("insp-offset", "Offset")}</div>` +
        `<div class="insp-row"><span class="insp-label">Rotate °</span>${vecInputs("insp-rotate", "Rotate")}</div>` +
        `<div class="insp-row"><span class="insp-label"></span><label class="check"><input type="checkbox" id="insp-arrow"> Auto arrow to the assembled pose</label></div>` +
        `<p class="insp-note" id="insp-move-note"></p>` +
        `<div class="insp-buttons"><button class="small-btn" data-act="fit-sel">Fit view</button>` +
        `<button class="small-btn" data-act="isolate">Isolate</button>` +
        `<button class="small-btn" data-act="remove-from-step" title="Take the selection out of this step's lists and moves (Delete)">Remove from step</button></div>`;
    }
    return html + `</div>`;
  }

  _fill_parts(m) {
    const st = this.state;
    const ids = m.ids;
    const single = ids.length === 1 ? ids[0] : null;
    if (single) {
      const meta = st.project.partMeta(single);
      this._set("insp-name", meta ? meta.name : "");
      const color = meta && meta.color ? meta.color : "";
      const colorEl = this.container.querySelector("#insp-color");
      if (colorEl && document.activeElement !== colorEl) colorEl.value = /^#[0-9a-fA-F]{6}$/.test(color) ? color : color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : "#cccccc";
      const txt = this.container.querySelector("#insp-color-text");
      if (txt) txt.textContent = color || "from the model";
      const clear = this.container.querySelector('[data-act="color-clear"]');
      if (clear) clear.disabled = !color;
    }
    const step = st.step();
    if (!step) return;
    const parts = expandIds(st.registry, ids);
    const visible = st.folds()[st.currentStep];
    const tri = (set) => {
      const n = parts.filter((p) => set.has(p)).length;
      return n === 0 ? false : n === parts.length ? true : null;
    };
    const setTri = (id, v) => {
      const el = this.container.querySelector(`#${id}`);
      if (!el) return;
      el.indeterminate = v === null;
      el.checked = v === true;
      el.disabled = !parts.length;
    };
    setTri("insp-vis", tri(visible));
    setTri("insp-hi", tri(new Set(expandIds(st.registry, step.highlight))));
    setTri("insp-gh", tri(new Set(expandIds(st.registry, step.ghost))));
    const placements = st.placements();
    const first = placements.get(parts[0]);
    const same = parts.every((p) => JSON.stringify(placements.get(p) || null) === JSON.stringify(first || null));
    this._setVec("insp-offset", first ? first.offset : [0, 0, 0], !same);
    this._setVec("insp-rotate", first ? first.rotate : [0, 0, 0], !same);
    const arrowEl = this.container.querySelector("#insp-arrow");
    if (arrowEl) {
      arrowEl.indeterminate = !same;
      arrowEl.checked = same ? (first ? first.arrow : true) : false;
      arrowEl.disabled = !first;
    }
    const note = this.container.querySelector("#insp-move-note");
    if (note) {
      const named = first && first.named;
      const hidden = parts.length && parts.every((p) => !visible.has(p));
      note.textContent = hidden ? "Hidden in this step: show it to see the move."
        : named && !ids.includes(named) && same ? `Moved with ${named} (a group move); editing gives the selection its own move.` : "";
      note.classList.toggle("warn", !!hidden);
    }
    this.container.querySelector('[data-act="assemble"]').disabled = !parts.some((p) => placements.has(p));
  }

  // ── Arrow ──────────────────────────────────────────────────────────

  _pickButton(field) {
    const can = this.viewport && this.viewport.canPickPoints;
    return `<button class="small-btn pick-btn" data-pick="${field}"${can ? "" : " disabled"} ` +
      `title="${can ? "Click a point in the viewport" : "Picking points in the viewport comes with the viewport tools; type the numbers for now"}">Pick</button>`;
  }

  _build_arrow(m) {
    this.titleEl.textContent = "Inspector · Arrow";
    const rotate = m.item.kind === "rotate";
    return `<div class="insp">` + this._idsDatalist() +
      `<div class="insp-head"><span class="insp-kind">Arrow ${m.index + 1}</span><span class="insp-sub">step ${this.state.currentStep + 1}</span>` +
      `<button class="small-btn" data-act="back" style="margin-left:auto">Step</button></div>` +
      `<div class="insp-row"><label for="insp-kind">Kind</label><select id="insp-kind" class="field-select">` +
      ARROW_KINDS.map((k) => `<option value="${k}">${k === "rotate" ? "Rotate (around an axis)" : "Straight"}</option>`).join("") + `</select></div>` +
      `<div class="insp-row"><span class="insp-label">${rotate ? "Center" : "From"}</span>${vecInputs("insp-from", "From")}${this._pickButton("from")}</div>` +
      `<div class="insp-row"><span class="insp-label">${rotate ? "Axis to" : "To"}</span>${vecInputs("insp-to", "To")}${this._pickButton("to")}</div>` +
      (rotate ? `<div class="insp-row"><label for="insp-turns">Turns</label><input id="insp-turns" class="field-input" type="number" step="0.05" title="A fraction of a turn; negative turns counterclockwise seen from the center toward the axis point"></div>` +
        `<div class="insp-row"><label for="insp-radius">Radius mm</label><input id="insp-radius" class="field-input" type="number" step="0.5" min="0.1"></div>` : "") +
      `<div class="insp-row"><label for="insp-acolor">Color</label><input id="insp-acolor" class="field-input" placeholder="the theme's arrow color" autocomplete="off" spellcheck="false"></div>` +
      `<div class="insp-row"><label for="insp-alabel">Label</label><input id="insp-alabel" class="field-input" placeholder="Optional text at the tail" autocomplete="off"></div>` +
      `<div class="insp-row"><label for="insp-aattach">Attach</label><input id="insp-aattach" class="field-input" list="insp-ids" placeholder="Optional part id: follows its move" autocomplete="off" spellcheck="false"></div>` +
      `<div class="insp-buttons"><button class="small-btn danger" data-act="remove-arrow">Delete arrow</button></div>` +
      `</div>`;
  }

  _fill_arrow(m) {
    const a = m.item;
    this._set("insp-kind", a.kind);
    this._setVec("insp-from", a.from);
    this._setVec("insp-to", a.to);
    this._set("insp-turns", fmt(a.turns));
    this._set("insp-radius", fmt(a.radius));
    this._set("insp-acolor", a.color);
    this._set("insp-alabel", a.label);
    this._set("insp-aattach", a.attach);
  }

  // ── Label ──────────────────────────────────────────────────────────

  _build_label(m) {
    this.titleEl.textContent = "Inspector · Label";
    return `<div class="insp">` + this._idsDatalist() +
      `<div class="insp-head"><span class="insp-kind">Label ${m.index + 1}</span><span class="insp-sub">step ${this.state.currentStep + 1}</span>` +
      `<button class="small-btn" data-act="back" style="margin-left:auto">Step</button></div>` +
      `<div class="insp-row"><label for="insp-ltext">Text</label><input id="insp-ltext" class="field-input" autocomplete="off"></div>` +
      `<div class="insp-row"><span class="insp-label">Anchor</span>${vecInputs("insp-at", "Anchor")}${this._pickButton("at")}</div>` +
      `<div class="insp-row"><label for="insp-side">Side</label><select id="insp-side" class="field-select">` +
      LABEL_SIDES.map((s) => `<option value="${s}">${s === "auto" ? "Auto (away from the center)" : s[0].toUpperCase() + s.slice(1)}</option>`).join("") + `</select></div>` +
      `<div class="insp-row"><label for="insp-lattach">Attach</label><input id="insp-lattach" class="field-input" list="insp-ids" placeholder="Optional part id: follows its move" autocomplete="off" spellcheck="false"></div>` +
      `<div class="insp-buttons"><button class="small-btn danger" data-act="remove-label">Delete label</button></div>` +
      `</div>`;
  }

  _fill_label(m) {
    const l = m.item;
    this._set("insp-ltext", l.text);
    this._setVec("insp-at", l.at);
    this._set("insp-side", l.side);
    this._set("insp-lattach", l.attach);
  }

  // ── Edits ──────────────────────────────────────────────────────────

  _onInput(e) {
    if (e.target.id === "insp-text") this._preview(e.target.value);
  }

  _onChange(e) {
    const st = this.state;
    const t = e.target;
    const m = this._mode();
    const i = st.currentStep;
    let ok = true;
    if (t.dataset.vec) {
      const v = this._readVec(t.dataset.vec);
      if (!v) { this.render(); return; }
      const vid = t.dataset.vec;
      if (vid === "insp-offset") ok = st.setMove(m.ids, { offset: v });
      else if (vid === "insp-rotate") ok = st.setMove(m.ids, { rotate: v });
      else if (vid === "insp-from") ok = st.updateArrow(m.index, { from: v });
      else if (vid === "insp-to") ok = st.updateArrow(m.index, { to: v });
      else if (vid === "insp-at") ok = st.updateLabel(m.index, { at: v });
    } else {
      switch (t.id) {
        case "insp-id": ok = st.updateStep(i, { id: t.value.trim() }); break;
        case "insp-title": ok = st.updateStep(i, { title: t.value.trim() }); break;
        case "insp-text": ok = st.updateStep(i, { text: t.value.replace(/\s+$/, "") }); break;
        case "insp-note": ok = st.updateStep(i, { note: t.value.trim() }); break;
        case "insp-name": ok = st.renamePart(m.ids[0], t.value); break;
        case "insp-color": ok = st.setPartColor(m.ids[0], t.value); break;
        case "insp-vis": ok = st.setVisibility(m.ids, t.checked); break;
        case "insp-hi": ok = st.setHighlight(m.ids, t.checked); break;
        case "insp-gh": ok = st.setGhost(m.ids, t.checked); break;
        case "insp-arrow": ok = st.setMove(m.ids, { arrow: t.checked }); break;
        case "insp-kind": ok = st.updateArrow(m.index, { kind: t.value }); break;
        case "insp-turns": ok = Number(t.value) ? st.updateArrow(m.index, { turns: Number(t.value) }) : false; break;
        case "insp-radius": ok = Number(t.value) > 0 ? st.updateArrow(m.index, { radius: Number(t.value) }) : false; break;
        case "insp-acolor": ok = st.updateArrow(m.index, { color: t.value.trim() }); break;
        case "insp-alabel": ok = st.updateArrow(m.index, { label: t.value.trim() }); break;
        case "insp-aattach": ok = st.updateArrow(m.index, { attach: t.value.trim() }); break;
        case "insp-ltext": ok = t.value.trim() ? st.updateLabel(m.index, { text: t.value.trim() }) : false; break;
        case "insp-side": ok = st.updateLabel(m.index, { side: t.value }); break;
        case "insp-lattach": ok = st.updateLabel(m.index, { attach: t.value.trim() }); break;
        default: return;
      }
    }
    // Refused (pending TOML that does not parse, or a value the format
    // rejects): show the value that stands.
    if (!ok) {
      this._key = null;
      this.render();
    }
  }

  _defaultPoint() {
    const st = this.state;
    const ids = st.selection.parts.length ? st.selection.parts : null;
    const box = st.bboxOf(ids) || st.bboxOf(null) || { min: [0, 0, 0], max: [10, 10, 10] };
    const up = st.project.assembly.up === "y" ? 1 : 2;
    const center = box.min.map((v, k) => (v + box.max[k]) / 2);
    const size = Math.hypot(...box.max.map((v, k) => v - box.min[k])) || 10;
    return { center, top: center.map((v, k) => (k === up ? box.max[k] : v)), size, up };
  }

  _onClick(e) {
    const st = this.state;
    const t = e.target.closest("button, [data-select], [data-move], [data-arrow], [data-label]");
    if (!t) return;
    const m = this._mode();
    if (t.dataset.unlist) { st.removeListedId(t.dataset.unlist, t.dataset.id); return; }
    if (t.dataset.select !== undefined && t.tagName !== "BUTTON") { st.selectParts([t.dataset.select], "replace"); return; }
    if (t.dataset.move !== undefined) { st.selectParts(st.step().moves[Number(t.dataset.move)].parts, "replace"); return; }
    if (t.dataset.arrow !== undefined) { st.setSelection({ arrow: Number(t.dataset.arrow) }); return; }
    if (t.dataset.label !== undefined) { st.setSelection({ label: Number(t.dataset.label) }); return; }
    if (t.dataset.pick) {
      if (!this.viewport || !this.viewport.canPickPoints) return;
      const field = t.dataset.pick;
      this.viewport.pickPoint({ prompt: `Click the ${field === "at" ? "anchor" : field} point` }).then((hit) => {
        if (!hit) return;
        if (field === "at") st.updateLabel(m.index, { at: hit.point });
        else st.updateArrow(m.index, { [field]: hit.point });
      }, () => {});
      return;
    }
    switch (t.dataset.act) {
      case "add-step": st.addStep(); break;
      case "cam-use": this.viewport.useCurrentView(); break;
      case "cam-clear": this.viewport.clearStepCamera(); break;
      case "cam-fit": st.setStepCamera(st.currentStep, { fit: st.step().highlight.slice() }); break;
      case "add-arrow": {
        // Above the selection (or the model), pointing down the up axis: a
        // start for the numbers or the viewport's arrow tool.
        const { top, size, up } = this._defaultPoint();
        const from = top.slice(), to = top.slice();
        from[up] += size * 0.25;
        to[up] += size * 0.05;
        const attach = st.selection.parts.length === 1 ? st.selection.parts[0] : "";
        st.addArrow({ from, to, attach });
        break;
      }
      case "add-label": {
        const { center } = this._defaultPoint();
        const attach = st.selection.parts.length === 1 ? st.selection.parts[0] : "";
        st.addLabel({ text: attach ? st.displayName(attach) : "Label", at: center, attach });
        break;
      }
      case "back": st.setSelection({ parts: [], arrow: -1, label: -1 }); break;
      case "remove-arrow": st.removeArrow(m.index); break;
      case "remove-label": st.removeLabel(m.index); break;
      case "color-clear": st.setPartColor(m.ids[0], ""); break;
      case "assemble": st.clearMove(m.ids); break;
      case "fit-sel": this.viewport.fit(m.ids); break;
      case "isolate": st.isolate(m.ids); break;
      case "remove-from-step": st.removeFromStep(m.ids); break;
      default: break;
    }
  }
}
