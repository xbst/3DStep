// The Parts tab: every loaded model's tree with search and multi-select, the
// current step's eye / highlight / ghost toggles per row, and the model
// actions (rename, delete, merge a group or the selected parts, isolate,
// simplify, select tiny parts). The status line shows the triangles and the
// page size to expect.

import { expandIds, membersOf } from "./project-model.js";
import { selectTiny } from "./import/model.js";
import { simplifyModel } from "./import/simplify.js";
import { confirmDialog, formatBytes, formatCount, openMergeParts, openSelectTiny, openSimplify } from "./dialogs.js";

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const EYE = `<svg ${SVG}><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>`;
const EYE_OFF = `<svg ${SVG}><path d="M3 3l18 18"/><path d="M10.6 5.6A10 10 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.9M6.4 6.5C3.6 8.3 2 12 2 12s3.5 6.5 10 6.5a9.6 9.6 0 0 0 4.4-1"/></svg>`;
const STAR = `<svg ${SVG}><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>`;
const STAR_ON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>`;
const GHOST = `<svg ${SVG} stroke-dasharray="3 2.4"><circle cx="12" cy="12" r="7.5"/></svg>`;
const GHOST_ON = `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity=".35" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/></svg>`;

// Pages above this size are slow on a phone (SPEC 7, "Size budget").
const PAGE_BUDGET = 3 * 1024 * 1024;

export class PartsPanel {
  constructor(container, state) {
    this.container = container;
    this.state = state;
    this.expanded = new Set();
    this.collapsed = new Set();
    this.filter = "";
    this.anchor = null;
    this.focusId = null;
    this.renaming = null;
    this.tinyMm = 2;
    this._buildDOM();
    this._bind();
    this.render();
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="parts-panel">
        <div class="parts-top">
          <input type="search" class="field-input" id="parts-search" placeholder="Search parts by name or id…" aria-label="Search parts" autocomplete="off" spellcheck="false">
          <div class="parts-actions">
            <button class="small-btn" data-act="isolate" title="Show only the selection in this step">Isolate</button>
            <button class="small-btn" data-act="rename" title="Rename the part's display name (F2); its id does not change">Rename</button>
            <button class="small-btn" data-act="merge" title="Turn the selected group into one part with the group's id, or merge the selected parts into one of them">Merge group</button>
            <button class="small-btn danger" data-act="delete" title="Delete the selection from its model (undo brings it back)">Delete</button>
            <button class="small-btn" data-act="simplify" title="Reduce the triangles of the selection, or of every part">Simplify…</button>
            <button class="small-btn" data-act="tiny" title="Select the parts smaller than a size, to delete them together">Select tiny…</button>
          </div>
          <div class="parts-step-note" id="parts-step-note"></div>
        </div>
        <ul class="tree" id="parts-tree" role="tree" aria-label="Parts" aria-multiselectable="true" tabindex="0"></ul>
        <div class="parts-empty" id="parts-empty">No model yet. Import a STEP or GLB file with <strong>Import model</strong>, or open a saved project.</div>
        <div class="parts-status" id="parts-status" role="status"></div>
      </div>`;
    this.search = this.container.querySelector("#parts-search");
    this.tree = this.container.querySelector("#parts-tree");
    this.empty = this.container.querySelector("#parts-empty");
    this.status = this.container.querySelector("#parts-status");
    this.stepNote = this.container.querySelector("#parts-step-note");
    this.notice = "";
  }

  _bind() {
    const st = this.state;
    // A notice reports what the last action did; history moves, an opened
    // project and an edit in the TOML tab make it stale.
    const stale = new Set(["undo", "open", "init", "editor"]);
    for (const ev of ["project-changed", "models-changed", "step-changed", "models-measured", "dirty-changed"]) {
      st.on(ev, (data) => {
        if ((ev === "project-changed" || ev === "models-changed") && stale.has(data?.origin)) this.notice = "";
        this.render();
      });
    }
    st.on("selection-changed", () => this._paintSelection());
    this.search.addEventListener("input", () => {
      this.filter = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.container.querySelector(".parts-actions").addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act) this._action(act);
    });
    this.tree.addEventListener("click", (e) => this._onClick(e));
    this.tree.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".tree-row");
      if (row && !e.target.closest(".tree-toggle, .tree-twisty")) this._startRename(row.dataset.id);
    });
    this.tree.addEventListener("keydown", (e) => this._onKeyDown(e));
  }

  // ── Rendering ──────────────────────────────────────────────────────

  _rows() {
    const st = this.state;
    const reg = st.registry;
    const out = [];
    const match = (id) => {
      if (!this.filter) return true;
      return id.toLowerCase().includes(this.filter) || st.displayName(id).toLowerCase().includes(this.filter)
        || (reg.label.get(id) || "").toLowerCase().includes(this.filter);
    };
    const visibleUnder = new Map();
    const anyMatch = (id) => {
      if (visibleUnder.has(id)) return visibleUnder.get(id);
      const yes = match(id) || (reg.children.get(id) || []).some(anyMatch);
      visibleUnder.set(id, yes);
      return yes;
    };
    for (const model of st.loadedModels()) {
      out.push({ model });
      const walk = (id, depth) => {
        if (!anyMatch(id)) return;
        const kids = reg.children.get(id) || [];
        const open = this.filter ? true : this.collapsed.has(id) ? false : this.expanded.has(id) || depth === 0;
        out.push({ id, depth, kids: kids.length, open });
        if (open) kids.forEach((c) => walk(c, depth + 1));
      };
      model.nodes.forEach((n, i) => { if (n.parent === -1 && reg.model.get(n.id) === model.name) walk(n.id, 0); });
    }
    return out;
  }

  render() {
    if (this.renaming) return;
    const st = this.state;
    const step = st.step();
    const folds = step ? st.folds() : [];
    const visible = step ? folds[st.currentStep] : new Set();
    const highlight = new Set(step ? expandIds(st.registry, step.highlight) : []);
    const ghost = new Set(step ? expandIds(st.registry, step.ghost) : []);
    const rows = this._rows();
    this.rowIds = rows.filter((r) => r.id).map((r) => r.id);
    const state3 = (set, id) => {
      const m = membersOf(st.registry, id);
      const n = m.filter((p) => set.has(p)).length;
      return n === 0 ? "off" : n === m.length ? "on" : "mixed";
    };
    const html = [];
    for (const r of rows) {
      if (r.model) {
        const dirty = st.dirtyModels.has(r.model.name);
        html.push(`<li class="tree-model" role="none"><span class="tree-model-name" title="${esc(r.model.name)}">${esc(r.model.name)}</span>` +
          (dirty ? `<span class="tree-model-state" title="Not saved yet: Save project writes it">unsaved</span>` : "") + `</li>`);
        continue;
      }
      const id = r.id;
      const name = st.displayName(id);
      const vis = step ? state3(visible, id) : "off";
      const hi = step ? state3(highlight, id) : "off";
      const gh = step ? state3(ghost, id) : "off";
      const dis = step ? "" : " disabled";
      html.push(
        `<li class="tree-row${vis === "off" && step ? " hidden-in-step" : ""}" role="treeitem" data-id="${esc(id)}" aria-level="${r.depth + 1}"` +
        (r.kids ? ` aria-expanded="${r.open}"` : "") + ` style="padding-left:${4 + r.depth * 14}px">` +
        `<button class="tree-twisty${r.kids ? "" : " leaf"}" tabindex="-1" aria-label="${r.open ? "Collapse" : "Expand"}">${r.open ? "▾" : "▸"}</button>` +
        `<span class="tree-label" title="${esc(name)} (${esc(id)})">${esc(name)}${name !== id ? `<span class="tree-id">${esc(id)}</span>` : ""}</span>` +
        `<button class="tree-toggle${vis === "on" ? " on" : vis === "mixed" ? " mixed" : ""}" data-toggle="visible" tabindex="-1"${dis} ` +
        `aria-pressed="${vis === "mixed" ? "mixed" : vis === "on"}" title="Visible in this step (Shift+click: from this step on)">${vis === "off" ? EYE_OFF : EYE}</button>` +
        `<button class="tree-toggle${hi === "on" ? " on" : hi === "mixed" ? " mixed" : ""}" data-toggle="highlight" tabindex="-1"${dis} ` +
        `aria-pressed="${hi === "mixed" ? "mixed" : hi === "on"}" title="Highlighted in this step">${hi === "off" ? STAR : STAR_ON}</button>` +
        `<button class="tree-toggle${gh === "on" ? " on" : gh === "mixed" ? " mixed" : ""}" data-toggle="ghost" tabindex="-1"${dis} ` +
        `aria-pressed="${gh === "mixed" ? "mixed" : gh === "on"}" title="Ghosted (translucent) in this step">${gh === "off" ? GHOST : GHOST_ON}</button>` +
        `</li>`);
    }
    const scroll = this.tree.scrollTop;
    this.tree.innerHTML = html.join("");
    this.tree.scrollTop = scroll;
    const hasModels = st.loadedModels().length > 0;
    this.empty.hidden = hasModels;
    this.tree.hidden = !hasModels;
    this.stepNote.textContent = !hasModels ? "" : step
      ? `Toggles act on step ${st.currentStep + 1}: ${st.project.stepTitle(st.currentStep)}`
      : "Add a step (Steps tab) to set what it shows.";
    this._paintSelection();
    this._renderStatus();
  }

  _renderStatus() {
    const st = this.state;
    if (!st.loadedModels().length) {
      this.status.textContent = "";
      return;
    }
    const size = st.pageSize();
    const over = size > PAGE_BUDGET;
    this.status.innerHTML = `<span>${formatCount(st.triangles())} triangles</span>` +
      `<span class="${over ? "over-budget" : ""}" title="${over ? "Over the ~3 MB a page should stay under: delete small parts, merge groups or simplify" : "The generated page with every model inlined"}">≈ ${formatBytes(size)} page</span>` +
      (this.notice ? `<span>${esc(this.notice)}</span>` : "");
  }

  _paintSelection() {
    const sel = new Set(this.state.selection.parts);
    for (const row of this.tree.querySelectorAll(".tree-row")) {
      const on = sel.has(row.dataset.id);
      row.classList.toggle("selected", on);
      row.setAttribute("aria-selected", String(on));
      row.classList.toggle("focused", row.dataset.id === this.focusId && document.activeElement === this.tree);
    }
    const parts = this.state.selection.parts;
    const btn = (act) => this.container.querySelector(`[data-act="${act}"]`);
    const has = parts.length > 0;
    btn("isolate").disabled = !has || !this.state.step();
    btn("rename").disabled = parts.length !== 1;
    btn("delete").disabled = !has;
    const kind = this._mergeKind(parts);
    btn("merge").disabled = !kind;
    btn("merge").textContent = kind === "parts" ? "Merge parts" : "Merge group";
    btn("simplify").disabled = !this.state.loadedModels().length;
    btn("tiny").disabled = !this.state.loadedModels().length;
  }

  // What the merge button does with the selection: turn one group into a
  // part ("group"), merge two or more parts of one model ("parts"), or nothing.
  _mergeKind(parts) {
    const reg = this.state.registry;
    if (parts.length === 1 && reg.groups.has(parts[0])) return "group";
    const all = expandIds(reg, parts);
    return all.length >= 2 && new Set(all.map((p) => reg.model.get(p))).size === 1 ? "parts" : null;
  }

  // ── Interaction ────────────────────────────────────────────────────

  _targets(id) {
    const sel = this.state.selection.parts;
    return sel.includes(id) && sel.length > 1 ? sel.slice() : [id];
  }

  _onClick(e) {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest(".tree-twisty")) {
      this._toggleOpen(id);
      return;
    }
    const toggle = e.target.closest(".tree-toggle");
    if (toggle) {
      if (toggle.disabled) return;
      const ids = this._targets(id);
      const on = toggle.classList.contains("on");
      const st = this.state;
      if (toggle.dataset.toggle === "visible") st.setVisibility(ids, !on, { onward: e.shiftKey });
      else if (toggle.dataset.toggle === "highlight") st.setHighlight(ids, !on);
      else st.setGhost(ids, !on);
      return;
    }
    this.focusId = id;
    if (e.shiftKey && this.anchor && this.rowIds.includes(this.anchor)) {
      const a = this.rowIds.indexOf(this.anchor), b = this.rowIds.indexOf(id);
      const range = this.rowIds.slice(Math.min(a, b), Math.max(a, b) + 1);
      this.state.selectParts(range, e.ctrlKey || e.metaKey ? "add" : "replace");
    } else if (e.ctrlKey || e.metaKey) {
      this.state.selectParts([id], "toggle");
      this.anchor = id;
    } else {
      this.state.selectParts([id], "replace");
      this.anchor = id;
    }
    this.tree.focus({ preventScroll: true });
    this._paintSelection();
  }

  _toggleOpen(id, open) {
    const isOpen = this.tree.querySelector(`.tree-row[data-id="${CSS.escape(id)}"]`)?.getAttribute("aria-expanded") === "true";
    const want = open === undefined ? !isOpen : open;
    if (want) {
      this.expanded.add(id);
      this.collapsed.delete(id);
    } else {
      this.collapsed.add(id);
      this.expanded.delete(id);
    }
    this.render();
  }

  _onKeyDown(e) {
    if (e.target !== this.tree || document.querySelector(".modal-backdrop")) return;
    const ids = this.rowIds || [];
    if (!ids.length) return;
    const cur = ids.indexOf(this.focusId);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(ids.length - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur < 0 ? 0 : cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ids.length - 1;
    else if (e.key === "ArrowRight" && cur >= 0) { this._toggleOpen(ids[cur], true); e.preventDefault(); return; }
    else if (e.key === "ArrowLeft" && cur >= 0) {
      const parent = this.state.registry.parent.get(ids[cur]);
      const row = this.tree.querySelector(`.tree-row[data-id="${CSS.escape(ids[cur])}"]`);
      if (row && row.getAttribute("aria-expanded") === "true") this._toggleOpen(ids[cur], false);
      else if (parent) { this.focusId = parent; this.state.selectParts([parent], "replace"); }
      e.preventDefault();
      return;
    } else if (e.key === "F2" && cur >= 0) { this._startRename(ids[cur]); e.preventDefault(); return; }
    else if (e.key === " " && cur >= 0) {
      const st = this.state;
      const vis = st.step() ? st.folds()[st.currentStep] : null;
      if (vis) st.setVisibility(this._targets(ids[cur]), !membersOf(st.registry, ids[cur]).every((p) => vis.has(p)));
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    this.focusId = ids[next];
    if (e.shiftKey && this.anchor) {
      const a = ids.indexOf(this.anchor);
      this.state.selectParts(ids.slice(Math.min(a, next), Math.max(a, next) + 1), "replace");
    } else {
      this.anchor = ids[next];
      this.state.selectParts([ids[next]], "replace");
    }
    this.tree.querySelector(`.tree-row[data-id="${CSS.escape(ids[next])}"]`)?.scrollIntoView({ block: "nearest" });
    this._paintSelection();
  }

  // Inline rename of the display name ([[part]] name).
  _startRename(id) {
    const row = this.tree.querySelector(`.tree-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const label = row.querySelector(".tree-label");
    const input = document.createElement("input");
    input.className = "field-input tree-rename";
    input.value = this.state.displayName(id);
    input.setAttribute("aria-label", `Display name of ${id}`);
    label.replaceWith(input);
    this.renaming = id;
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      this.renaming = null;
      if (commit) this.state.renamePart(id, input.value);
      this.render();
      this.tree.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => {
      // Ctrl+S goes on to the designer's save, which commits the name first
      // (the field loses focus) and keeps the browser's Save Page away.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") return;
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  async _action(act) {
    const st = this.state;
    const parts = st.selection.parts.slice();
    if (act === "isolate") st.isolate(parts);
    else if (act === "rename" && parts.length === 1) this._startRename(parts[0]);
    else if (act === "merge") {
      const kind = this._mergeKind(parts);
      if (kind === "group") {
        const n = membersOf(st.registry, parts[0]).length;
        if (await confirmDialog("Merge group", `Merge <strong>${esc(parts[0])}</strong> and the ${formatCount(n)} part${n === 1 ? "" : "s"} under it into one part? Steps that name parts inside it will name the group.`, { ok: "Merge" })) {
          st.mergeGroup(parts[0]);
        }
      } else if (kind === "parts") {
        const keep = await openMergeParts(expandIds(st.registry, parts).map((id) => ({ id, name: st.displayName(id) })));
        if (keep) st.mergeParts(parts, keep);
      }
    } else if (act === "delete" && parts.length) {
      const n = expandIds(st.registry, parts).length;
      const what = parts.length === 1 ? `<strong>${esc(st.displayName(parts[0]))}</strong>${n > 1 ? ` (${formatCount(n)} parts)` : ""}` : `${formatCount(n)} part${n === 1 ? "" : "s"}`;
      if (await confirmDialog("Delete from the model", `Delete ${what} from the model? The steps stop naming ${n === 1 ? "it" : "them"}. Undo brings ${n === 1 ? "it" : "them"} back.`, { ok: "Delete", danger: true })) {
        st.deleteParts(parts);
      }
    } else if (act === "simplify") {
      const opts = await openSimplify({ selected: expandIds(st.registry, parts).length, triangles: st.triangles() });
      if (!opts) return;
      const changes = {};
      let before = 0, after = 0;
      this.notice = "Simplifying…";
      this._renderStatus();
      try {
        for (const model of st.loadedModels()) {
          const ids = opts.scope === "selection" ? parts.filter((id) => st.registry.model.get(id) === model.name) : [];
          if (opts.scope === "selection" && !ids.length) continue;
          const out = await simplifyModel(model, ids, { ratio: opts.ratio, error: opts.error, permissive: opts.permissive });
          before += out.before;
          after += out.after;
          if (out.after < out.before) changes[model.name] = out.model;
        }
        // Set the notice after the commit: committing first applies any
        // pending typing in the TOML tab, which clears the notice.
        const changed = Object.keys(changes).length > 0;
        const ok = !changed || st.replaceModels(changes);
        this.notice = !ok ? "" : changed ? `Simplified ${formatCount(before)} → ${formatCount(after)} triangles` : "Nothing to simplify within that error bound";
      } catch (e) {
        this.notice = `Could not simplify: ${e.message || e}`;
      }
      this._renderStatus();
    } else if (act === "tiny") {
      const mm = await openSelectTiny({ last: this.tinyMm });
      if (!mm) return;
      this.tinyMm = mm;
      const ids = st.loadedModels().flatMap((m) => selectTiny(m, mm));
      st.selectParts(ids, "replace");
      this.notice = `Selected ${formatCount(ids.length)} part${ids.length === 1 ? "" : "s"} under ${mm} mm`;
      this._renderStatus();
    }
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
