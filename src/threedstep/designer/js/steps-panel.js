// The Steps tab: the assembly's own settings, then the ordered list of steps
// with add (after the current step), duplicate, delete, drag to reorder and
// the keyboard (PinConnect's connector list pattern). Reordering keeps what
// every step displays: state.moveStep rewrites the show / hide deltas.

import { esc } from "./dialogs.js";

export class StepsPanel {
  constructor(container, state, viewport) {
    this.container = container;
    this.state = state;
    this.viewport = viewport;
    this._dragIndex = null;
    this._buildDOM();
    this._bind();
    this.render();
  }

  _buildDOM() {
    let open = true;
    try { open = localStorage.getItem("threedstep-designer-assembly-open") !== "0"; } catch (e) { /* storage blocked */ }
    this.container.innerHTML = `
      <div class="steps-panel">
        <details class="assembly-box" id="assembly-box"${open ? " open" : ""}>
          <summary>Assembly</summary>
          <div class="insp">
            <div class="insp-row"><label for="asm-title">Title</label><input id="asm-title" class="field-input" autocomplete="off" spellcheck="false" title="The page's title, shown above the steps"></div>
            <div class="insp-row top"><label for="asm-desc">Description</label><textarea id="asm-desc" class="field-textarea" rows="2" placeholder="Optional: the subtitle and the page's description"></textarea></div>
            <div class="insp-row"><label for="asm-start">Before step 1</label><select id="asm-start" class="field-select">
              <option value="visible">Every part visible</option><option value="hidden">Every part hidden</option></select></div>
            <div class="insp-row"><label for="asm-up">Up axis</label><select id="asm-up" class="field-select">
              <option value="z">Z (most CAD tools)</option><option value="y">Y (Fusion, glTF)</option></select></div>
            <div class="insp-row"><span class="insp-label">Home view</span><span class="insp-value insp-buttons">
              <span class="insp-note" id="asm-home-state"></span>
              <button class="small-btn" id="asm-home-use" title="The current view becomes the page's home view ([camera]); step 1 starts there">Use view</button>
              <button class="small-btn" id="asm-home-clear" title="Fit the model instead">Clear</button></span></div>
          </div>
        </details>
        <div class="steps-toolbar">
          <span class="steps-count" id="steps-count">0 steps</span>
          <button class="small-btn" id="step-up" aria-label="Move the current step up" title="Move the current step up (Alt+↑)">↑</button>
          <button class="small-btn" id="step-down" aria-label="Move the current step down" title="Move the current step down (Alt+↓)">↓</button>
          <button class="small-btn primary" id="step-add" title="Add a step after the current one: same parts visible, nothing moved or highlighted">+ Add step</button>
        </div>
        <p class="steps-hint">Drag to reorder · Alt+↑/↓ moves a step · every step keeps what it shows</p>
        <ol class="step-list" id="step-list" aria-label="Steps"></ol>
        <div class="steps-empty" id="steps-empty" hidden>No steps yet. <strong>+ Add step</strong> starts the first one.</div>
        <div class="sr-only" id="steps-status" role="status"></div>
      </div>`;
    this.list = this.container.querySelector("#step-list");
    this.empty = this.container.querySelector("#steps-empty");
    this.statusEl = this.container.querySelector("#steps-status");
    this.box = this.container.querySelector("#assembly-box");
  }

  _bind() {
    const st = this.state;
    const $ = (id) => this.container.querySelector(id);
    for (const ev of ["project-changed", "models-changed"]) st.on(ev, () => this.render());
    st.on("step-changed", () => this._paintCurrent());
    this.box.addEventListener("toggle", () => {
      try { localStorage.setItem("threedstep-designer-assembly-open", this.box.open ? "1" : "0"); } catch (e) { /* storage blocked */ }
    });
    // Fields commit on change (Enter, or leaving the field): one undo step each.
    // Pending TOML that does not parse refuses the change; show what stands.
    $("#asm-title").addEventListener("change", (e) => {
      const v = e.target.value.trim();
      if (!v) { e.target.value = st.project.assembly.title; return; }
      if (!st.setAssembly({ title: v })) this.render();
    });
    $("#asm-desc").addEventListener("change", (e) => { if (!st.setAssembly({ description: e.target.value.trim() })) this.render(); });
    $("#asm-start").addEventListener("change", (e) => { if (!st.setAssembly({ start: e.target.value })) this.render(); });
    $("#asm-up").addEventListener("change", (e) => { if (!st.setAssembly({ up: e.target.value })) this.render(); });
    $("#asm-home-use").addEventListener("click", () => this.viewport.useViewAsHome());
    $("#asm-home-clear").addEventListener("click", () => st.setCamera(null));
    $("#step-add").addEventListener("click", () => {
      if (st.addStep()) this._focusStep(st.currentStep);
    });
    $("#step-up").addEventListener("click", () => this._move(-1));
    $("#step-down").addEventListener("click", () => this._move(1));
    this.list.addEventListener("click", (e) => this._onClick(e));
    this.list.addEventListener("keydown", (e) => this._onKeyDown(e));
    this._bindDrag();
  }

  _detail(step) {
    const bits = [];
    if (step.show.length) bits.push(`+${step.show.length}`);
    if (step.hide.length) bits.push(`−${step.hide.length}`);
    if (step.highlight.length) bits.push(`★${step.highlight.length}`);
    if (step.ghost.length) bits.push(`◌${step.ghost.length}`);
    if (step.moves.length) bits.push(`${step.moves.length} move${step.moves.length === 1 ? "" : "s"}`);
    if (step.arrows.length) bits.push(`${step.arrows.length} arrow${step.arrows.length === 1 ? "" : "s"}`);
    if (step.labels.length) bits.push(`${step.labels.length} label${step.labels.length === 1 ? "" : "s"}`);
    if (step.camera) bits.push(step.camera.position ? "camera" : step.camera.fit ? "fit" : "fov");
    return bits.join(" · ") || "no changes";
  }

  render() {
    const st = this.state;
    const p = st.project;
    const $ = (id) => this.container.querySelector(id);
    const setValue = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
    setValue($("#asm-title"), p.assembly.title);
    setValue($("#asm-desc"), p.assembly.description.replace(/\n$/, ""));
    setValue($("#asm-start"), p.assembly.start);
    setValue($("#asm-up"), p.assembly.up);
    $("#asm-home-state").textContent = p.camera ? "captured" : "fits the model";
    $("#asm-home-clear").disabled = !p.camera;
    $("#asm-home-use").disabled = !st.loadedModels().length;

    const focused = this.list.contains(document.activeElement) ? document.activeElement : null;
    const focusAction = focused?.dataset.action || "select";
    const html = p.steps.map((s, i) => {
      const title = p.stepTitle(i);
      return `<li class="step-row" draggable="true" data-index="${i}">` +
        `<span class="step-handle" aria-hidden="true" title="Drag to reorder">⠿</span>` +
        `<button class="step-select" data-action="select" aria-label="Step ${i + 1}: ${esc(title)}" title="${esc(title)} (${esc(p.stepId(i))})">` +
        `<span class="step-num">${i + 1}</span><span class="step-text"><span class="step-title">${esc(title)}</span>` +
        `<span class="step-detail">${esc(this._detail(s))}</span></span></button>` +
        `<button class="step-action" data-action="duplicate" aria-label="Duplicate step ${i + 1}" title="Duplicate step ${i + 1} (Ctrl+D)">⧉</button>` +
        `<button class="step-action danger" data-action="delete" aria-label="Delete step ${i + 1}" title="Delete step ${i + 1}">×</button></li>`;
    }).join("");
    this.list.innerHTML = html;
    this.empty.hidden = p.steps.length > 0;
    $("#steps-count").textContent = `${p.steps.length} step${p.steps.length === 1 ? "" : "s"}`;
    this._paintCurrent();
    if (focused && st.currentStep >= 0) this._focusStep(st.currentStep, focusAction);
  }

  _paintCurrent() {
    const cur = this.state.currentStep;
    const n = this.state.project.steps.length;
    for (const row of this.list.children) {
      const on = Number(row.dataset.index) === cur;
      row.classList.toggle("selected", on);
      const sel = row.querySelector(".step-select");
      sel.setAttribute("aria-current", on ? "step" : "false");
      sel.tabIndex = on || (cur < 0 && row === this.list.firstElementChild) ? 0 : -1;
    }
    this.container.querySelector("#step-up").disabled = cur <= 0;
    this.container.querySelector("#step-down").disabled = cur < 0 || cur >= n - 1;
    this.container.querySelector("#step-add").disabled = !this.state.loadedModels().length && !n;
  }

  _focusStep(index, action = "select") {
    const row = this.list.children[index];
    if (!row) return;
    row.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }

  _select(index) {
    this.state.setCurrentStep(index);
    this._focusStep(index);
  }

  _move(direction) {
    const from = this.state.currentStep;
    if (!this.state.moveStep(from, from + direction)) return;
    this._focusStep(from + direction);
    this.statusEl.textContent = `Moved step to position ${from + direction + 1}.`;
  }

  _duplicate(index) {
    if (this.state.duplicateStep(index)) {
      this._focusStep(index + 1);
      this.statusEl.textContent = `Duplicated step ${index + 1}.`;
    }
  }

  _remove(index) {
    if (this.state.removeStep(index)) {
      if (this.state.currentStep >= 0) this._focusStep(this.state.currentStep);
      else this.container.querySelector("#step-add").focus();
      this.statusEl.textContent = `Deleted step ${index + 1}.`;
    }
  }

  _onClick(e) {
    const row = e.target.closest(".step-row");
    if (!row) return;
    const index = Number(row.dataset.index);
    const action = e.target.closest("button")?.dataset.action || "select";
    if (action === "duplicate") this._duplicate(index);
    else if (action === "delete") this._remove(index);
    else this._select(index);
  }

  _onKeyDown(e) {
    if (document.querySelector(".modal-backdrop")) return;
    const row = e.target.closest(".step-row");
    if (!row) return;
    const index = Number(row.dataset.index);
    const n = this.state.project.steps.length;
    const key = e.key.toLowerCase();
    if (key === "delete") {
      e.preventDefault();
      e.stopPropagation();
      this._remove(index);
    } else if (key === "d" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this._duplicate(index);
    } else if (!e.ctrlKey && !e.metaKey && ["arrowup", "arrowdown", "home", "end"].includes(key)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey && (key === "arrowup" || key === "arrowdown")) {
        if (this.state.currentStep !== index) this.state.setCurrentStep(index);
        this._move(key === "arrowup" ? -1 : 1);
      } else if (!e.altKey) {
        const next = key === "home" ? 0 : key === "end" ? n - 1 : Math.max(0, Math.min(n - 1, index + (key === "arrowup" ? -1 : 1)));
        this._select(next);
      }
    }
  }

  _clearDrag() {
    for (const row of this.list.children) row.classList.remove("dragging", "drop-before", "drop-after");
  }

  _dropTarget(e) {
    const rows = [...this.list.children];
    const row = e.target.closest(".step-row");
    if (!row) return { row: rows[rows.length - 1], after: true, boundary: rows.length };
    const rect = row.getBoundingClientRect();
    const after = e.clientY >= rect.top + rect.height / 2;
    return { row, after, boundary: rows.indexOf(row) + (after ? 1 : 0) };
  }

  _bindDrag() {
    this.list.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".step-row");
      if (!row || !e.dataTransfer) return;
      this._dragIndex = Number(row.dataset.index);
      this.state.setCurrentStep(this._dragIndex);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(this._dragIndex));
      row.classList.add("dragging");
    });
    this.list.addEventListener("dragover", (e) => {
      if (this._dragIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      this._clearDrag();
      const t = this._dropTarget(e);
      t.row?.classList.add(t.after ? "drop-after" : "drop-before");
    });
    this.list.addEventListener("dragleave", (e) => {
      if (!this.list.contains(e.relatedTarget)) this._clearDrag();
    });
    this.list.addEventListener("drop", (e) => {
      if (this._dragIndex === null) return;
      e.preventDefault();
      const from = this._dragIndex;
      const { boundary } = this._dropTarget(e);
      const to = boundary - (from < boundary ? 1 : 0);
      this._dragIndex = null;
      this._clearDrag();
      if (this.state.moveStep(from, to)) {
        this._focusStep(to);
        this.statusEl.textContent = `Moved step to position ${to + 1}.`;
      }
    });
    this.list.addEventListener("dragend", () => {
      this._dragIndex = null;
      this._clearDrag();
    });
  }
}
