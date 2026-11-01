// The TOML tab: the project's source, editable, in step with the panels both
// ways (PinConnect's editor pattern). Typing is parsed 300 ms after the last
// keystroke; a change made in the panels patches the text in place, so
// hand-written comments and formatting survive (toml-io.js).

import {
  duplicateStepBlock, insertStepBlock, moveStepBlock, parseProject, reconcileSource, removeStepBlock, removeSubBlock,
  serializeProject, stripComment,
} from "./toml-io.js";

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function span(cls, text) {
  return `<span class="${cls}">${text}</span>`;
}

// Every character of a value is returned, whitespace included: the highlight
// sits under a transparent textarea, so a dropped space would shift the rest
// of the line away from the caret.
function highlightValues(text) {
  return text.replace(/("(?:[^"\\]|\\.)*"?|'[^']*'?)|\b(true|false)\b|([+-]?\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b|[+-]?\b(?:inf|nan)\b)|([^"'tf\d+-]+|.)/g,
    (m, str, bool, num, other) => {
      if (str) return span("hl-string", esc(str));
      if (bool) return span("hl-bool", esc(bool));
      if (num) return span("hl-number", esc(num));
      return esc(m);
    });
}

// Highlight the whole text, following multi-line strings across lines.
export function highlightToml(text) {
  let open = null;   // the delimiter of a multi-line string still open
  return text.split("\n").map((line) => {
    if (open) {
      const end = line.indexOf(open);
      if (end < 0) return span("hl-string", esc(line));
      let close = end + 3;
      while (line[close] === open[0] && close - end < 5) close++;
      open = null;
      const rest = line.slice(close);
      const code = stripComment(rest);
      return span("hl-string", esc(line.slice(0, close))) + esc(code) + (rest.length > code.length ? span("hl-comment", esc(rest.slice(code.length))) : "");
    }
    const code = stripComment(line);
    const comment = line.slice(code.length);
    const trimmed = code.trim();
    let out;
    if (/^\[\[.+\]\]$/.test(trimmed)) out = span("hl-table-array", esc(code));
    else if (/^\[[^\]]+\]$/.test(trimmed)) out = span("hl-table", esc(code));
    else if (/^\s*[A-Za-z0-9_."'-][^=]*=/.test(code) && !/^\s*["']{3}/.test(code)) {
      const eq = code.indexOf("=");
      const value = code.slice(eq + 1);
      const m = /^(\s*)("""|''')/.exec(value);
      if (m && value.indexOf(m[2], m[1].length + 3) < 0) {
        open = m[2];
        return span("hl-key", esc(code.slice(0, eq))) + "=" + esc(m[1]) + span("hl-string", esc(value.slice(m[1].length) + comment));
      }
      out = span("hl-key", esc(code.slice(0, eq))) + "=" + highlightValues(value);
    } else {
      out = highlightValues(code);
    }
    return comment ? out + span("hl-comment", esc(comment)) : out;
  }).join("\n");
}

export class EditorPanel {
  constructor(container, state) {
    this.state = state;
    this.container = container;
    this._debounceTimer = null;
    this._errorLine = 0;
    this.warnings = [];
    this._buildDOM();
    this._bindEvents();
    this._bindState();
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="code-editor">
        <div class="code-gutter" id="code-gutter"></div>
        <div class="code-body">
          <pre class="code-highlight" id="code-highlight" aria-hidden="true"></pre>
          <textarea class="code-input" id="code-input" spellcheck="false" aria-label="Project TOML"
            autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
        </div>
      </div>
      <div class="code-error" id="code-error" role="alert"></div>
    `;
    this.textarea = this.container.querySelector("#code-input");
    this.highlight = this.container.querySelector("#code-highlight");
    this.gutter = this.container.querySelector("#code-gutter");
    this.errorEl = this.container.querySelector("#code-error");
  }

  _bindEvents() {
    this.textarea.addEventListener("input", () => this._onInput());
    this.textarea.addEventListener("scroll", () => this._syncScroll());
    this.textarea.addEventListener("keydown", (e) => this._onKeyDown(e));
  }

  _bindState() {
    this.state.on("before-mutation", (request) => {
      if (this.flushChanges()) return;
      request.cancel = true;
      this.state.emit("source-error", {});
    });
    this.state.on("project-changed", ({ origin, change }) => {
      if (origin === "editor") return;
      if (origin === "undo" && this.state.sourceText !== null) {
        this._setSourceText(this.state.sourceText);
        return;
      }
      this._applyChange(change || { kind: "full" });
    });
  }

  // Bring the text in step with the project after a change made elsewhere:
  // the structural edit first (blocks keep their comments), then the values.
  _applyChange(change) {
    let text = this.textarea.value;
    if (change.text !== undefined && change.text !== null) {
      this._setSourceText(change.text);
      return;
    }
    if (!text.trim() || this._hasError()) {
      this._setSourceText(serializeProject(this.state.project));
      return;
    }
    if (change.kind === "step-added") {
      text = change.duplicateOf !== undefined ? duplicateStepBlock(text, change.duplicateOf) : insertStepBlock(text, change.index);
    } else if (change.kind === "step-removed") {
      text = removeStepBlock(text, change.index);
    } else if (change.kind === "step-moved") {
      text = moveStepBlock(text, change.from, change.to);
    }
    for (const r of change.removed || []) text = removeSubBlock(text, r.step, r.list, r.index);
    this._setSourceText(reconcileSource(text, this.state.project));
  }

  _hasError() {
    return this.errorEl.style.display === "block";
  }

  _onInput() {
    this._updateHighlight();
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._parseAndSync(), 300);
  }

  _onKeyDown(e) {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      // execCommand keeps the browser's own undo stack for the textarea.
      if (!document.execCommand || !document.execCommand("insertText", false, "  ")) {
        const val = this.textarea.value;
        this.textarea.value = val.substring(0, start) + "  " + val.substring(end);
        this.textarea.selectionStart = this.textarea.selectionEnd = start + 2;
        this._onInput();
      }
    }
  }

  _updateHighlight() {
    const text = this.textarea.value;
    this.highlight.innerHTML = highlightToml(text) + "\n";
    this._updateGutter(text);
    this._syncScroll();
  }

  _updateGutter(text) {
    const count = text.split("\n").length;
    const nums = [];
    for (let i = 1; i <= count; i++) nums.push(i === this._errorLine ? `<div class="err">${i}</div>` : `<div>${i}</div>`);
    this.gutter.innerHTML = nums.join("");
  }

  _syncScroll() {
    this.highlight.scrollTop = this.textarea.scrollTop;
    this.highlight.scrollLeft = this.textarea.scrollLeft;
    this.gutter.scrollTop = this.textarea.scrollTop;
  }

  _showError(message, line) {
    this._errorLine = line || 0;
    this.errorEl.textContent = line ? `Line ${line}: ${message}` : message;
    this.errorEl.style.display = "block";
    this._updateGutter(this.textarea.value);
  }

  _clearError() {
    const had = this._errorLine;
    this._errorLine = 0;
    this.errorEl.textContent = "";
    this.errorEl.style.display = "none";
    if (had) this._updateGutter(this.textarea.value);
  }

  _parseAndSync() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    const text = this.textarea.value;
    try {
      const { project, warnings } = parseProject(text);
      this._clearError();
      this.warnings = warnings;
      this.state.setProjectFromEditor(project, text);
      this.state.emit("source-synced", { text });
      return true;
    } catch (e) {
      this._showError(e.message || String(e), e.line);
      this.state.emit("source-invalid", { message: e.message, line: e.line });
      return false;
    }
  }

  // Tabs and mutations call this first, so a keystroke followed at once by a
  // click cannot act on a stale project. False when the text does not parse.
  flushChanges() {
    if (this._debounceTimer !== null || this.textarea.value !== this.state.sourceText) return this._parseAndSync();
    return !this._hasError();
  }

  _setSourceText(text) {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    const scroll = this.textarea.scrollTop;
    this.textarea.value = text;
    this.textarea.scrollTop = scroll;
    this.state.sourceText = text;
    this._clearError();
    this._updateHighlight();
    this.state.emit("source-synced", { text });
  }

  // Replace the text (a project opened, the start) and parse it.
  setValue(text) {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    this.textarea.value = text;
    this._updateHighlight();
    return this._parseAndSync();
  }

  // Show text that already matches the project (no parse, no undo step).
  setSourceText(text) {
    this._setSourceText(text);
  }

  getValue() {
    return this.textarea.value;
  }

  // Put the caret on a line (an error, a step's block) and show it.
  revealLine(line) {
    const lines = this.textarea.value.split("\n");
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
    this.textarea.focus();
    this.textarea.setSelectionRange(pos, pos);
    const lh = parseFloat(getComputedStyle(this.textarea).lineHeight) || 19;
    this.textarea.scrollTop = Math.max(0, (line - 4) * lh);
    this._syncScroll();
  }
}
