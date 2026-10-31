// The project TOML: parsing with source positions, the SPEC 6 layout, and
// patchers that rewrite only what changed, so hand-written comments and
// formatting survive every edit made in the panels.
//
// PinConnect's toml-io.js generalized. Its line-based parser became a full
// TOML parser (multi-line strings, arrays over several lines, inline tables,
// dotted keys, nested arrays of tables such as [[step.move]]) that also
// records where every table and key sits. The panels change the Project; the
// TOML tab then calls reconcileSource(text, project), which edits values in
// place, adds and removes keys and blocks, and checks its own result by
// parsing it again (falling back to a fresh serialization when the text was
// written in a form it cannot patch). Structural edits (a step added, removed
// or moved, a move removed) are applied first, so blocks keep their comments.

import { projectFromToml } from "./project-model.js";

export class TomlParseError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "TomlParseError";
    this.line = line;
  }
}

// A TOML date or time, kept as written. The project format has none, so the
// loader reports it as a value of the wrong type.
export class TomlDateTime {
  constructor(text) {
    this.text = text;
  }

  toString() {
    return this.text;
  }
}

const BARE = /[A-Za-z0-9_-]/;
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
const isPlainTable = v => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

function parseNumber(tok) {
  let m;
  if ((m = /^([+-])?(inf|nan)$/.exec(tok))) return m[2] === "nan" ? NaN : (m[1] === "-" ? -Infinity : Infinity);
  if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ""), 16);
  if (/^0o[0-7](_?[0-7])*$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ""), 8);
  if (/^0b[01](_?[01])*$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ""), 2);
  if (/^[+-]?(0|[1-9](_?\d)*)$/.test(tok)) return parseInt(tok.replace(/_/g, ""), 10);
  if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(tok) && /[.eE]/.test(tok)) {
    return parseFloat(tok.replace(/_/g, ""));
  }
  return undefined;
}

const DATETIME = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

class Parser {
  constructor(text) {
    this.t = text;
    this.pos = 0;
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    this.root = {};
    this.kind = new WeakMap();   // table -> "root" | "header" | "implicit" | "dotted" | "inline" | "element"
    this.aot = new WeakSet();    // arrays made by [[headers]], the only ones a header may append to
    this.records = [];
  }

  lineOf(pos) {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  fail(message, pos = this.pos) {
    throw new TomlParseError(message, this.lineOf(Math.min(pos, this.t.length)) + 1);
  }

  skipWs() {
    while (this.t[this.pos] === " " || this.t[this.pos] === "\t") this.pos++;
  }

  atNewline() {
    return this.t[this.pos] === "\n" || (this.t[this.pos] === "\r" && this.t[this.pos + 1] === "\n");
  }

  skipComment() {
    if (this.t[this.pos] !== "#") return;
    while (this.pos < this.t.length && !this.atNewline()) {
      const c = this.t.charCodeAt(this.pos);
      if ((c < 32 && c !== 9) || c === 127) this.fail("Control characters are not allowed in comments");
      this.pos++;
    }
  }

  skipWsNlComments() {
    for (;;) {
      this.skipWs();
      if (this.t[this.pos] === "#") this.skipComment();
      if (this.t[this.pos] === "\n") this.pos++;
      else if (this.t[this.pos] === "\r" && this.t[this.pos + 1] === "\n") this.pos += 2;
      else return;
    }
  }

  // After a key/value pair or a header: optional comment, then the end of the
  // line. Returns where the line's content ends.
  endOfLine(what) {
    this.skipWs();
    this.skipComment();
    const end = this.pos;
    if (this.pos >= this.t.length) return end;
    if (this.t[this.pos] === "\n") this.pos++;
    else if (this.t[this.pos] === "\r" && this.t[this.pos + 1] === "\n") this.pos += 2;
    else this.fail(`Unexpected '${this.t[this.pos]}' after ${what}; write one key = value per line`);
    return end;
  }

  parse() {
    this.kind.set(this.root, "root");
    let rec = { kind: "root", path: [], header: -1, obj: this.root, keys: [] };
    this.records.push(rec);
    while (this.pos < this.t.length) {
      this.skipWs();
      if (this.pos >= this.t.length) break;
      const c = this.t[this.pos];
      if (c === "\n") { this.pos++; continue; }
      if (c === "\r" && this.t[this.pos + 1] === "\n") { this.pos += 2; continue; }
      if (c === "#") { this.skipComment(); continue; }
      if (c === "[") {
        rec = this.parseHeader();
        this.records.push(rec);
        continue;
      }
      this.parseKeyValue(rec);
    }
  }

  parseKeyPart() {
    const c = this.t[this.pos];
    if (c === '"') {
      if (this.t.startsWith('"""', this.pos)) this.fail("A key cannot be a multi-line string");
      return this.parseBasic();
    }
    if (c === "'") {
      if (this.t.startsWith("'''", this.pos)) this.fail("A key cannot be a multi-line string");
      return this.parseLiteral();
    }
    const start = this.pos;
    while (this.pos < this.t.length && BARE.test(this.t[this.pos])) this.pos++;
    if (this.pos === start) {
      this.fail(c === undefined || c === "\n" || c === "\r" ? "Expected a key" : `Unexpected '${c}' where a key should be`);
    }
    return this.t.slice(start, this.pos);
  }

  parseKeyPath() {
    const parts = [];
    for (;;) {
      this.skipWs();
      parts.push(this.parseKeyPart());
      this.skipWs();
      if (this.t[this.pos] !== ".") return parts;
      this.pos++;
    }
  }

  parseHeader() {
    const start = this.pos;
    const line = this.lineOf(start);
    const aot = this.t.startsWith("[[", this.pos);
    this.pos += aot ? 2 : 1;
    const path = this.parseKeyPath();
    this.skipWs();
    if (aot) {
      if (!this.t.startsWith("]]", this.pos)) this.fail("Expected ']]' at the end of the table header");
      this.pos += 2;
    } else {
      if (this.t[this.pos] !== "]") this.fail("Expected ']' at the end of the table header");
      this.pos += 1;
    }
    this.endOfLine("the table header");
    const obj = aot ? this.appendTable(path, start) : this.openTable(path, start);
    return { kind: aot ? "aot" : "table", path, header: line, obj, keys: [] };
  }

  // The table a header's prefix names, creating implicit tables on the way.
  walk(path, upto, at) {
    let cur = this.root;
    for (let i = 0; i < upto; i++) {
      const k = path[i];
      let next = own(cur, k);
      if (next === undefined) {
        next = {};
        this.kind.set(next, "implicit");
        put(cur, k, next);
      } else if (Array.isArray(next)) {
        if (!this.aot.has(next)) this.fail(`'${path.slice(0, i + 1).join(".")}' is an array value, not a table`, at);
        next = next[next.length - 1];
      } else if (!isPlainTable(next) || this.kind.get(next) === "inline") {
        this.fail(`'${path.slice(0, i + 1).join(".")}' is already defined as a value`, at);
      }
      cur = next;
    }
    return cur;
  }

  openTable(path, at) {
    const parent = this.walk(path, path.length - 1, at);
    const k = path[path.length - 1];
    const existing = own(parent, k);
    if (existing === undefined) {
      const t = {};
      this.kind.set(t, "header");
      put(parent, k, t);
      return t;
    }
    if (isPlainTable(existing) && this.kind.get(existing) === "implicit") {
      this.kind.set(existing, "header");
      return existing;
    }
    if (Array.isArray(existing) && this.aot.has(existing)) this.fail(`[${path.join(".")}] is an array of tables: write [[${path.join(".")}]]`, at);
    return this.fail(`[${path.join(".")}] is defined more than once`, at);
  }

  appendTable(path, at) {
    const parent = this.walk(path, path.length - 1, at);
    const k = path[path.length - 1];
    let arr = own(parent, k);
    if (arr === undefined) {
      arr = [];
      this.aot.add(arr);
      put(parent, k, arr);
    } else if (!Array.isArray(arr) || !this.aot.has(arr)) {
      this.fail(`'${path.join(".")}' is not an array of tables, so [[${path.join(".")}]] cannot add to it`, at);
    }
    const t = {};
    this.kind.set(t, "element");
    arr.push(t);
    return t;
  }

  assign(table, path, value, at) {
    let cur = table;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      const next = own(cur, k);
      if (next === undefined) {
        const t = {};
        this.kind.set(t, "dotted");
        put(cur, k, t);
        cur = t;
      } else if (isPlainTable(next) && this.kind.get(next) === "dotted") {
        cur = next;
      } else {
        this.fail(`Cannot set '${path.join(".")}': '${path.slice(0, i + 1).join(".")}' is already defined`, at);
      }
    }
    const last = path[path.length - 1];
    if (own(cur, last) !== undefined) this.fail(`Duplicate key '${path.join(".")}'`, at);
    put(cur, last, value);
  }

  parseKeyValue(rec) {
    const keyStart = this.pos;
    const line = this.lineOf(keyStart);
    const path = this.parseKeyPath();
    this.skipWs();
    if (this.t[this.pos] !== "=") this.fail(`Expected '=' after the key '${path.join(".")}'`);
    this.pos++;
    this.skipWs();
    if (this.pos >= this.t.length || this.atNewline() || this.t[this.pos] === "#") this.fail(`The key '${path.join(".")}' has no value`);
    const valueStart = this.pos;
    const value = this.parseValue();
    const valueEnd = this.pos;
    const end = this.endOfLine("the value");
    this.assign(rec.obj, path, value, keyStart);
    rec.keys.push({ path, key: path[0], line, endLine: this.lineOf(valueEnd), keyStart, valueStart, valueEnd, end });
  }

  parseValue() {
    const t = this.t, c = t[this.pos];
    if (c === '"') return t.startsWith('"""', this.pos) ? this.parseMultilineBasic() : this.parseBasic();
    if (c === "'") return t.startsWith("'''", this.pos) ? this.parseMultilineLiteral() : this.parseLiteral();
    if (c === "[") return this.parseArray();
    if (c === "{") return this.parseInlineTable();
    if (t.startsWith("true", this.pos) && !BARE.test(t[this.pos + 4] || "")) { this.pos += 4; return true; }
    if (t.startsWith("false", this.pos) && !BARE.test(t[this.pos + 5] || "")) { this.pos += 5; return false; }
    const start = this.pos;
    while (this.pos < t.length && /[0-9A-Za-z_+\-.:]/.test(t[this.pos])) this.pos++;
    // A date and a time may be separated by one space.
    if (/^\d{4}-\d{2}-\d{2}$/.test(t.slice(start, this.pos)) && t[this.pos] === " " && /^\d{2}:/.test(t.slice(this.pos + 1, this.pos + 4))) {
      this.pos++;
      while (this.pos < t.length && /[0-9A-Za-z_+\-.:]/.test(t[this.pos])) this.pos++;
    }
    const tok = t.slice(start, this.pos);
    if (!tok) this.fail(`Unexpected '${c}' where a value should be`);
    const num = parseNumber(tok);
    if (num !== undefined) return num;
    if (DATETIME.test(tok)) return new TomlDateTime(tok);
    return this.fail(/^[A-Za-z]/.test(tok) ? `Cannot parse the value '${tok}' (text needs quotes: "${tok}")` : `Cannot parse the value '${tok}'`, start);
  }

  parseEscape() {
    const t = this.t, at = this.pos, e = t[this.pos + 1];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (e !== undefined && Object.prototype.hasOwnProperty.call(simple, e)) {
      this.pos += 2;
      return simple[e];
    }
    if (e === "u" || e === "U") {
      const n = e === "u" ? 4 : 8;
      const hex = t.slice(this.pos + 2, this.pos + 2 + n);
      if (hex.length !== n || !/^[0-9A-Fa-f]+$/.test(hex)) this.fail("Invalid Unicode escape", at);
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail("Invalid Unicode escape", at);
      this.pos += 2 + n;
      return String.fromCodePoint(cp);
    }
    return this.fail(`Invalid escape '\\${e === undefined ? "" : e}' in a string`, at);
  }

  checkChar(c) {
    const code = c.charCodeAt(0);
    if ((code < 32 && c !== "\t") || code === 127) this.fail("Control characters must be escaped in strings");
  }

  parseBasic() {
    const t = this.t, start = this.pos;
    this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= t.length || t[this.pos] === "\n" || t[this.pos] === "\r") this.fail("Unterminated string", start);
      const c = t[this.pos];
      if (c === '"') { this.pos++; return out; }
      if (c === "\\") { out += this.parseEscape(); continue; }
      this.checkChar(c);
      out += c;
      this.pos++;
    }
  }

  parseLiteral() {
    const t = this.t, start = this.pos;
    this.pos++;
    const open = this.pos;
    for (;;) {
      if (this.pos >= t.length || t[this.pos] === "\n" || t[this.pos] === "\r") this.fail("Unterminated string", start);
      const c = t[this.pos];
      if (c === "'") {
        const out = t.slice(open, this.pos);
        this.pos++;
        return out;
      }
      this.checkChar(c);
      this.pos++;
    }
  }

  // The newline right after the opening delimiter is not part of the string;
  // up to two quotes just before the closing delimiter are.
  closeMultiline(quote) {
    let run = 3;
    while (this.t[this.pos + run] === quote) run++;
    if (run > 5) this.fail("Too many quotes at the end of a multi-line string");
    this.pos += run;
    return quote.repeat(run - 3);
  }

  parseMultilineBasic() {
    const t = this.t, start = this.pos;
    this.pos += 3;
    if (t.startsWith("\r\n", this.pos)) this.pos += 2;
    else if (t[this.pos] === "\n") this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= t.length) this.fail("Unterminated multi-line string (it needs a closing \"\"\")", start);
      if (t.startsWith('"""', this.pos)) return out + this.closeMultiline('"');
      const c = t[this.pos];
      if (c === "\\") {
        // A backslash ending a line trims the newline and the whitespace after it.
        let j = this.pos + 1;
        while (t[j] === " " || t[j] === "\t") j++;
        if (t[j] === "\n" || (t[j] === "\r" && t[j + 1] === "\n")) {
          this.pos = j;
          while (this.pos < t.length && /[ \t\r\n]/.test(t[this.pos])) this.pos++;
          continue;
        }
        out += this.parseEscape();
        continue;
      }
      if (c === "\r" && t[this.pos + 1] === "\n") { out += "\n"; this.pos += 2; continue; }
      if (c !== "\n") this.checkChar(c);
      out += c;
      this.pos++;
    }
  }

  parseMultilineLiteral() {
    const t = this.t, start = this.pos;
    this.pos += 3;
    if (t.startsWith("\r\n", this.pos)) this.pos += 2;
    else if (t[this.pos] === "\n") this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= t.length) this.fail("Unterminated multi-line string (it needs a closing ''')", start);
      if (t.startsWith("'''", this.pos)) return out + this.closeMultiline("'");
      const c = t[this.pos];
      if (c === "\r" && t[this.pos + 1] === "\n") { out += "\n"; this.pos += 2; continue; }
      if (c !== "\n") this.checkChar(c);
      out += c;
      this.pos++;
    }
  }

  parseArray() {
    const start = this.pos;
    this.pos++;
    const out = [];
    for (;;) {
      this.skipWsNlComments();
      if (this.pos >= this.t.length) this.fail("Unterminated array (it needs a closing ])", start);
      if (this.t[this.pos] === "]") { this.pos++; return out; }
      out.push(this.parseValue());
      this.skipWsNlComments();
      const c = this.t[this.pos];
      if (c === ",") { this.pos++; continue; }
      if (c === "]") { this.pos++; return out; }
      this.fail(c === undefined ? "Unterminated array (it needs a closing ])" : `Expected ',' or ']' in the array, found '${c}'`, c === undefined ? start : this.pos);
    }
  }

  parseInlineTable() {
    const start = this.pos;
    this.pos++;
    const obj = {};
    this.kind.set(obj, "inline");
    this.skipWs();
    if (this.t[this.pos] === "}") { this.pos++; return obj; }
    for (;;) {
      if (this.atNewline() || this.t[this.pos] === "#") this.fail("An inline table { … } must stay on one line", start);
      const at = this.pos;
      const path = this.parseKeyPath();
      this.skipWs();
      if (this.t[this.pos] !== "=") this.fail(`Expected '=' after the key '${path.join(".")}'`);
      this.pos++;
      this.skipWs();
      this.assign(obj, path, this.parseValue(), at);
      this.skipWs();
      const c = this.t[this.pos];
      if (c === ",") { this.pos++; this.skipWs(); continue; }
      if (c === "}") { this.pos++; return obj; }
      if (c === "\n" || c === "\r") this.fail("An inline table { … } must stay on one line", start);
      this.fail(c === undefined ? "Unterminated inline table (it needs a closing })" : `Expected ',' or '}' in the inline table, found '${c}'`);
    }
  }
}

// Parse a TOML document. Returns { value, records, lineStarts, text }: the
// value as plain objects and arrays, and one record per table in document
// order ({ kind: "root" | "table" | "aot", path, header (0-based line, -1 for
// the root), obj, keys }) whose keys record where each key sits ({ path, key,
// line, endLine, keyStart, valueStart, valueEnd, end }).
export function parseDocument(text) {
  const p = new Parser(text);
  p.parse();
  return { value: p.root, records: p.records, lineStarts: p.lineStarts, text };
}

export function parseToml(text) {
  return parseDocument(text).value;
}

// Everything before a line's comment, for highlighting one line on its own.
export function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "#") return line.slice(0, i);
    if (c === '"' || c === "'") {
      const triple = line.startsWith(c.repeat(3), i);
      let j = i + (triple ? 3 : 1);
      for (; j < line.length; j++) {
        if (line[j] === "\\" && c === '"') { j++; continue; }
        if (triple ? line.startsWith(c.repeat(3), j) : line[j] === c) break;
      }
      if (j >= line.length) return line;
      i = j + (triple ? 2 : 0);
    }
  }
  return line;
}

// ── Writing values ───────────────────────────────────────────────────

export function quote(s) {
  return '"' + String(s).replace(/[\\"\u0000-\u001f\u007f]/g, ch => {
    if (ch === "\\") return "\\\\";
    if (ch === '"') return '\\"';
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    if (ch === "\r") return "\\r";
    return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase();
  }) + '"';
}

// A multi-line basic string: the opening delimiter, a newline TOML drops, the
// text as typed (backslashes, control characters and every third quote of a
// run escaped), the closing delimiter.
export function multiline(s) {
  const body = String(s).replace(/\r\n?/g, "\n")
    .replace(/[\\\u0000-\u0008\u000b-\u001f\u007f]/g, ch => (ch === "\\" ? "\\\\" : "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()))
    .replace(/"""/g, '""\\"');
  return '"""\n' + body + '"""';
}

// Floats as TOML writes them: always with a fraction or an exponent.
export function formatFloat(n) {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "nan" : (n > 0 ? "inf" : "-inf");
  if (Object.is(n, -0)) return "0.0";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toFixed(1);
  const s = String(n);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

function valueText(kind, v, previous = "") {
  switch (kind) {
    case "text":
      return v.includes("\n") ? multiline(v) : quote(v);
    case "strings":
      return `[${v.map(quote).join(", ")}]`;
    case "vector":
      return `[${v.map(formatFloat).join(", ")}]`;
    case "number":
      return formatFloat(v);
    case "bool":
      return String(v);
    default:
      // Keep a literal string literal when the new text allows it.
      if (previous.startsWith("'") && !previous.startsWith("'''") && !/['\u0000-\u001f\u007f]/.test(v)) return `'${v}'`;
      return quote(v);
  }
}

const normText = v => (typeof v === "string" ? v.replace(/\r\n?/g, "\n") : v);

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a === undefined || a === null) return b === undefined || b === null;
  return normText(a) === normText(b);
}

// ── The project layout (SPEC 6) ──────────────────────────────────────
//
// One entry per key, in the order the serializer writes them. required keys
// are always written; the others only when they differ from def. drop: a key
// whose new value is its default is removed from the text, not rewritten.

const ASSEMBLY = [
  { key: "title", kind: "string", required: true },
  { key: "description", kind: "text", def: "" },
  { key: "models", kind: "strings", required: true },
  { key: "theme", kind: "string", def: "default" },
  { key: "theme_dir", kind: "string", def: "./themes" },
  { key: "style", kind: "string", def: "lineart" },
  { key: "up", kind: "string", def: "z" },
  { key: "start", kind: "string", def: "visible" },
];
const CAMERA = [
  { key: "position", kind: "vector", required: true },
  { key: "target", kind: "vector", required: true },
  { key: "fov", kind: "number", def: 35 },
  { key: "projection", kind: "string", def: "orthographic" },
];
const PART = [
  { key: "id", kind: "string", required: true },
  { key: "name", kind: "string", def: "" },
  { key: "color", kind: "string", def: "" },
];
const STEP = [
  { key: "id", kind: "string", def: "", drop: true },
  { key: "title", kind: "string", def: "", drop: true },
  { key: "text", kind: "text", def: "", drop: true },
  { key: "note", kind: "text", def: "", drop: true },
  { key: "show", kind: "strings", def: [], drop: true },
  { key: "hide", kind: "strings", def: [], drop: true },
  { key: "highlight", kind: "strings", def: [], drop: true },
  { key: "ghost", kind: "strings", def: [], drop: true },
];
const STEP_CAMERA = [
  { key: "position", kind: "vector", def: null, drop: true },
  { key: "target", kind: "vector", def: null, drop: true },
  { key: "fov", kind: "number", def: null, drop: true },
  { key: "projection", kind: "string", def: null, drop: true },
  { key: "fit", kind: "strings", def: null, drop: true },
];
const MOVE = [
  { key: "parts", kind: "strings", required: true },
  { key: "offset", kind: "vector", def: [0, 0, 0] },
  { key: "rotate", kind: "vector", def: [0, 0, 0] },
  { key: "arrow", kind: "bool", def: true },
];
const ARROW = [
  { key: "from", kind: "vector", required: true },
  { key: "to", kind: "vector", required: true },
  { key: "kind", kind: "string", def: "straight" },
  { key: "turns", kind: "number", def: 0.75 },
  { key: "radius", kind: "number", def: 4 },
  { key: "color", kind: "string", def: "", drop: true },
  { key: "label", kind: "string", def: "", drop: true },
  { key: "attach", kind: "string", def: "", drop: true },
];
const LABEL = [
  { key: "text", kind: "string", required: true },
  { key: "at", kind: "vector", required: true },
  { key: "side", kind: "string", def: "auto" },
  { key: "attach", kind: "string", def: "", drop: true },
];
const SUBS = [
  { list: "moves", key: "move", spec: MOVE },
  { list: "arrows", key: "arrow", spec: ARROW },
  { list: "labels", key: "label", spec: LABEL },
];

const isDefault = (f, v) => !f.required && sameValue(v, f.def);
const written = (spec, data) => spec.filter(f => f.required || !isDefault(f, data[f.key]));
const fieldLines = (spec, data, indent) => written(spec, data).map(f => `${indent}${f.key} = ${valueText(f.kind, data[f.key])}`);
const hasCamera = cam => !!cam && STEP_CAMERA.some(f => !sameValue(cam[f.key], null));

function stepLines(s) {
  const lines = ["[[step]]", ...fieldLines(STEP, s, "")];
  if (hasCamera(s.camera)) lines.push("", "  [step.camera]", ...fieldLines(STEP_CAMERA, s.camera, "  "));
  for (const { list, key, spec } of SUBS) {
    for (const item of s[list]) lines.push("", `  [[step.${key}]]`, ...fieldLines(spec, item, "  "));
  }
  return lines;
}

// The project as a fresh TOML file in the SPEC 6 layout, sub-tables of a step
// indented by two spaces.
export function serializeProject(project) {
  const d = project.toData();
  const out = ["[assembly]", ...fieldLines(ASSEMBLY, d.assembly, "")];
  if (d.camera) out.push("", "[camera]", ...fieldLines(CAMERA, d.camera, ""));
  for (const p of d.parts) out.push("", "[[part]]", ...fieldLines(PART, p, ""));
  for (const s of d.steps) out.push("", ...stepLines(s));
  return out.join("\n") + "\n";
}

// ── The source map ───────────────────────────────────────────────────

// Where each part of a project sits in its text. A block is one table:
// header and fieldsEnd are 0-based lines (the header and its last key line),
// introStart the first line of the blank and comment lines just above the
// header, which move and go with it. A step's endLine also covers its
// sub-tables; a sub-table that follows an unrelated table (TOML still gives
// it to the last step) is listed as detached and stays out of that range.
export function projectMap(doc) {
  const recs = doc.records;
  const ends = recs.map(r => (r.keys.length ? r.keys[r.keys.length - 1].endLine : r.header));
  const blocks = recs.map((r, i) => ({
    kind: r.kind, path: r.path, obj: r.obj, keys: r.keys, header: r.header,
    fieldsEnd: ends[i], introStart: i > 0 ? Math.max(ends[i - 1] + 1, 0) : 0, endLine: ends[i],
  }));
  const map = { root: blocks[0], assembly: null, camera: null, parts: [], steps: [], others: [], lastLine: Math.max(-1, ...ends) };
  let lastWasStep = false;
  for (const b of blocks.slice(1)) {
    const p = b.path;
    const top = p.length === 1;
    if (top && p[0] === "step" && b.kind === "aot") {
      map.steps.push(Object.assign(b, { camera: null, moves: [], arrows: [], labels: [], subs: [], detached: [] }));
      lastWasStep = true;
      continue;
    }
    if (p.length === 2 && p[0] === "step" && map.steps.length) {
      const step = map.steps[map.steps.length - 1];
      if (lastWasStep) step.endLine = Math.max(step.endLine, b.endLine);
      else step.detached.push(b);
      step.subs.push(b);
      if (p[1] === "camera" && b.kind === "table") step.camera = b;
      else if (p[1] === "move" && b.kind === "aot") step.moves.push(b);
      else if (p[1] === "arrow" && b.kind === "aot") step.arrows.push(b);
      else if (p[1] === "label" && b.kind === "aot") step.labels.push(b);
      continue;
    }
    lastWasStep = false;
    if (top && p[0] === "assembly" && b.kind === "table") map.assembly = b;
    else if (top && p[0] === "camera" && b.kind === "table") map.camera = b;
    else if (top && p[0] === "part" && b.kind === "aot") map.parts.push(Object.assign(b, { id: typeof b.obj.id === "string" ? b.obj.id : null }));
    else map.others.push(b);
  }
  return map;
}

// The 1-based line a loader path (["step", 2, "move", 0, "parts"]) points at.
function locator(map) {
  const keyLine = (block, key) => {
    if (!block) return 0;
    const k = key !== undefined && block.keys.find(x => x.key === key);
    return (k ? k.line : Math.max(block.header, 0)) + 1;
  };
  return path => {
    const [top, a, b, c, d] = path;
    if (top === "assembly" && map.assembly) return keyLine(map.assembly, a);
    if (top === "camera" && map.camera) return keyLine(map.camera, a);
    if (top === "part" && map.parts.length) return keyLine(map.parts[typeof a === "number" ? a : 0], b);
    if (top === "step" && map.steps.length) {
      if (typeof a !== "number") return keyLine(map.steps[0]);
      const step = map.steps[a];
      if (!step) return 0;
      if (b === "camera" && step.camera) return keyLine(step.camera, c);
      const sub = { move: "moves", arrow: "arrows", label: "labels" }[b];
      if (sub && typeof c === "number" && step[sub][c]) return keyLine(step[sub][c], d);
      return keyLine(step, b);
    }
    const block = [map.root, ...map.others].find(x => x.path[0] === top || x.keys.some(k => k.key === top));
    return block ? keyLine(block, top) : 0;
  };
}

// Text -> {project, warnings, doc, map}. Throws TomlParseError for bad TOML
// and ProjectError (from project-model.js) for TOML the loader rejects; both
// carry the 1-based line.
export function parseProject(text) {
  const doc = parseDocument(text);
  const map = projectMap(doc);
  const { project, warnings } = projectFromToml(doc.value, { locate: locator(map) });
  return { project, warnings, doc, map };
}

// ── Edits by offset ──────────────────────────────────────────────────

// Splices on the original text, applied together from the end so their
// offsets stay valid: at one offset, removals and replacements first, then
// insertions in the order they were made.
class Edits {
  constructor(doc) {
    this.doc = doc;
    this.text = doc.text;
    this.list = [];
  }

  splice(start, end, text) {
    this.list.push({ start, end, text, seq: this.list.length });
  }

  lineStart(line) {
    return line < this.doc.lineStarts.length ? this.doc.lineStarts[line] : this.text.length;
  }

  lineEnd(line) {
    return line + 1 < this.doc.lineStarts.length ? this.doc.lineStarts[line + 1] : this.text.length;
  }

  // Lines inserted after `line` (-1: at the start), each ending in a newline.
  insertAfter(line, lines) {
    if (!lines.length) return;
    if (line < 0) {
      this.splice(0, 0, lines.join("\n") + "\n");
      return;
    }
    const at = this.lineEnd(line);
    if (at === this.text.length && !this.text.endsWith("\n")) this.splice(at, at, "\n" + lines.join("\n"));
    else this.splice(at, at, lines.join("\n") + "\n");
  }

  insertBefore(line, lines) {
    if (!lines.length) return;
    const at = this.lineStart(line);
    this.splice(at, at, lines.join("\n") + "\n");
  }

  // Whole lines first..last, with their newlines.
  removeLines(first, last) {
    if (first > last) return;
    this.splice(this.lineStart(first), this.lineEnd(last), "");
  }

  apply() {
    const sorted = this.list.slice().sort((x, y) => y.start - x.start
      || (y.end > y.start) - (x.end > x.start)
      || y.seq - x.seq);
    let out = this.text;
    for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
  }
}

function indentOf(doc, line) {
  if (line < 0) return "";
  const start = doc.lineStarts[line];
  const m = /^[ \t]*/.exec(doc.text.slice(start, start + 64));
  return m ? m[0] : "";
}

// Bring one table's own key lines in step with data: rewrite a value only when
// the loader would read it differently (notation, spacing and comments
// survive), remove keys that return to a default the layout leaves out, and
// add missing keys after the last one. Keys the spec does not know stay.
function patchTable(ed, block, spec, data) {
  const simple = block.keys.filter(k => k.path.length === 1);
  const seen = new Set();
  for (const k of simple) {
    const f = spec.find(x => x.key === k.key);
    if (!f) continue;
    seen.add(k.key);
    const want = data[f.key];
    if (sameValue(block.obj[k.key], want)) continue;
    if (f.drop && isDefault(f, want)) ed.removeLines(k.line, k.endLine);
    else ed.splice(k.valueStart, k.valueEnd, valueText(f.kind, want, ed.text.slice(k.valueStart, k.valueStart + 3)));
  }
  const dotted = new Set(block.keys.filter(k => k.path.length > 1).map(k => k.key));
  const missing = spec.filter(f => !seen.has(f.key) && !dotted.has(f.key) && (f.required || !isDefault(f, data[f.key])));
  if (missing.length) {
    const ref = simple.length ? simple[simple.length - 1].line : block.header;
    const indent = simple.length ? indentOf(ed.doc, ref) : (block.header >= 0 ? indentOf(ed.doc, block.header) : "");
    ed.insertAfter(block.fieldsEnd, missing.map(f => `${indent}${f.key} = ${valueText(f.kind, data[f.key])}`));
  }
}

const normCamera = c => (c && typeof c === "object" ? {
  position: c.position ?? null, target: c.target ?? null, fov: c.fov ?? null, projection: c.projection ?? null, fit: c.fit ?? null,
} : null);
const normSub = {
  moves: m => ({ parts: m.parts, offset: m.offset ?? [0, 0, 0], rotate: m.rotate ?? [0, 0, 0], arrow: m.arrow ?? true }),
  arrows: a => ({
    from: a.from, to: a.to, kind: a.kind ?? "straight", turns: a.turns ?? 0.75, radius: a.radius ?? 4,
    color: a.color ?? "", label: a.label ?? "", attach: a.attach ?? "",
  }),
  labels: l => ({ text: l.text, at: l.at, side: l.side ?? "auto", attach: l.attach ?? "" }),
};
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function patchStep(ed, block, s) {
  patchTable(ed, block, STEP, s);
  // Sub-structures written inline in the step's own lines (camera = {…},
  // move = [{…}], camera.fov = …) are left alone while they still say the
  // same thing; otherwise their lines go and standard sub-tables replace them.
  const inline = key => block.keys.filter(k => k.key === key);
  let after = block.fieldsEnd;
  const camWant = hasCamera(s.camera) ? normCamera(s.camera) : null;
  const camKeys = inline("camera");
  if (camKeys.length) {
    const have = normCamera(block.obj.camera);
    const haveSome = have && STEP_CAMERA.some(f => have[f.key] !== null);
    if (!sameJson(haveSome ? have : null, camWant)) {
      for (const k of camKeys) ed.removeLines(k.line, k.endLine);
      if (camWant) ed.insertAfter(block.fieldsEnd, ["", "  [step.camera]", ...fieldLines(STEP_CAMERA, s.camera, "  ")]);
    }
  } else if (block.camera) {
    if (!camWant) ed.removeLines(block.camera.introStart, block.camera.fieldsEnd);
    else patchTable(ed, block.camera, STEP_CAMERA, s.camera);
    after = Math.max(after, block.camera.fieldsEnd);
  } else if (camWant) {
    ed.insertAfter(block.fieldsEnd, ["", "  [step.camera]", ...fieldLines(STEP_CAMERA, s.camera, "  ")]);
  }
  for (const { list, key, spec } of SUBS) {
    const want = s[list];
    const keys = inline(key);
    if (keys.length) {
      const have = Array.isArray(block.obj[key]) ? block.obj[key].map(normSub[list]) : null;
      if (!sameJson(have, want.map(normSub[list]))) {
        for (const k of keys) ed.removeLines(k.line, k.endLine);
        ed.insertAfter(block.endLine, want.flatMap(item => ["", `  [[step.${key}]]`, ...fieldLines(spec, item, "  ")]));
      }
      continue;
    }
    const have = block[list];
    for (let j = 0; j < Math.min(have.length, want.length); j++) patchTable(ed, have[j], spec, want[j]);
    for (let j = have.length - 1; j >= want.length; j--) ed.removeLines(have[j].introStart, have[j].fieldsEnd);
    if (want.length > have.length) {
      const at = have.length ? have[have.length - 1].fieldsEnd : after;
      ed.insertAfter(at, want.slice(have.length).flatMap(item => ["", `  [[step.${key}]]`, ...fieldLines(spec, item, "  ")]));
    }
    if (have.length) after = Math.max(after, have[have.length - 1].fieldsEnd);
  }
}

// Comparable project data: [[part]] order is not significant.
function canonical(project) {
  const d = project.toData();
  d.parts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const s of d.steps) if (s.camera && !hasCamera(s.camera)) s.camera = null;
  return JSON.stringify(d);
}

// Edit `text` so that it says what `project` says, keeping everything else
// (comments, blank lines, notation, unknown tables). Steps, moves, arrows and
// labels are matched by position, [[part]] tables by id; apply structural
// edits first (insertStepBlock and the rest) so positions line up. The result
// is parsed again and compared with the project; when it does not match
// (text in a form the patchers do not handle), a fresh serialization is
// returned instead, so the text is always right even if a comment is lost.
export function reconcileSource(text, project) {
  const fresh = () => serializeProject(project);
  let doc;
  try {
    doc = parseDocument(text);
  } catch (e) {
    return fresh();
  }
  const map = projectMap(doc);
  const d = project.toData();
  const ed = new Edits(doc);

  if (map.assembly) patchTable(ed, map.assembly, ASSEMBLY, d.assembly);
  else ed.insertBefore(0, ["[assembly]", ...fieldLines(ASSEMBLY, d.assembly, ""), ""]);
  const afterAssembly = map.assembly ? map.assembly.fieldsEnd : -1;

  if (map.camera) {
    if (!d.camera) ed.removeLines(map.camera.introStart, map.camera.fieldsEnd);
    else patchTable(ed, map.camera, CAMERA, d.camera);
  } else if (d.camera) {
    ed.insertAfter(afterAssembly, ["", "[camera]", ...fieldLines(CAMERA, d.camera, "")]);
  }

  const wanted = new Map(d.parts.map(p => [p.id, p]));
  const placed = new Set();
  for (const b of map.parts) {
    if (b.id !== null && wanted.has(b.id) && !placed.has(b.id)) {
      patchTable(ed, b, PART, wanted.get(b.id));
      placed.add(b.id);
    } else {
      ed.removeLines(b.introStart, b.fieldsEnd);
    }
  }
  const newParts = d.parts.filter(p => !placed.has(p.id));
  if (newParts.length) {
    const kept = map.parts.filter(b => placed.has(b.id));
    const at = kept.length ? kept[kept.length - 1].fieldsEnd : map.camera && d.camera ? map.camera.fieldsEnd : afterAssembly;
    ed.insertAfter(at, newParts.flatMap(p => ["", "[[part]]", ...fieldLines(PART, p, "")]));
  }

  const steps = map.steps;
  for (let i = 0; i < Math.min(steps.length, d.steps.length); i++) patchStep(ed, steps[i], d.steps[i]);
  for (let i = steps.length - 1; i >= d.steps.length; i--) {
    for (const b of steps[i].detached) ed.removeLines(b.introStart, b.fieldsEnd);
    ed.removeLines(steps[i].introStart, steps[i].endLine);
  }
  if (d.steps.length > steps.length) {
    const at = steps.length ? steps[steps.length - 1].endLine : map.lastLine;
    const lines = d.steps.slice(steps.length).flatMap(s => ["", ...stepLines(s)]);
    if (at < 0 && !text.trim()) lines.shift();
    ed.insertAfter(at, lines);
  }

  const out = ed.apply();
  try {
    if (canonical(parseProject(out).project) === canonical(project)) return out;
  } catch (e) {
    // fall through to a fresh file
  }
  if (typeof console !== "undefined" && console.warn) console.warn("3DStep designer: the TOML could not be patched in place, so it was rewritten");
  return fresh();
}

// ── Structural edits (the step blocks and their sub-tables) ──────────

function withMap(text, fn) {
  let doc;
  try {
    doc = parseDocument(text);
  } catch (e) {
    return text;
  }
  return fn(doc, projectMap(doc), new Edits(doc));
}

// An empty [[step]] at `index` (0 to the number of steps), placed above the
// comments that introduce the step now there. reconcileSource fills it in.
export function insertStepBlock(text, index) {
  return withMap(text, (doc, map, ed) => {
    const steps = map.steps;
    if (index < steps.length) ed.insertBefore(steps[index].introStart, ["", "[[step]]"]);
    else if (!text.trim()) return "[[step]]\n";
    else ed.insertAfter(steps.length ? steps[steps.length - 1].endLine : map.lastLine, ["", "[[step]]"]);
    return ed.apply();
  });
}

// A copy of step `index`'s lines (comments and notation included) right after
// it; reconcileSource then patches what differs in the copy.
export function duplicateStepBlock(text, index) {
  return withMap(text, (doc, map, ed) => {
    const step = map.steps[index];
    if (!step) return text;
    const body = text.slice(ed.lineStart(step.header), ed.lineEnd(step.endLine)).replace(/\r?\n$/, "");
    ed.insertAfter(step.endLine, ["", ...body.split(/\r?\n/)]);
    return ed.apply();
  });
}

export function removeStepBlock(text, index) {
  return withMap(text, (doc, map, ed) => {
    const step = map.steps[index];
    if (!step) return text;
    for (const b of step.detached) ed.removeLines(b.introStart, b.fieldsEnd);
    ed.removeLines(step.introStart, step.endLine);
    return ed.apply();
  });
}

// Move a step block with the comments above it; `to` is its final index.
export function moveStepBlock(text, from, to) {
  return withMap(text, (doc, map, ed) => {
    const count = map.steps.length;
    if (!(from >= 0 && from < count && to >= 0 && to < count) || from === to) return text;
    const step = map.steps[from];
    if (step.detached.length) return text;
    const start = ed.lineStart(step.introStart), end = ed.lineEnd(step.endLine);
    let block = text.slice(start, end);
    if (!block.endsWith("\n")) block += "\n";
    if (!/^[ \t]*\r?\n/.test(block)) block = "\n" + block;
    const rest = text.slice(0, start) + text.slice(end);
    let doc2;
    try {
      doc2 = parseDocument(rest);
    } catch (e) {
      return text;
    }
    const map2 = projectMap(doc2);
    const ed2 = new Edits(doc2);
    if (to < map2.steps.length) {
      const at = ed2.lineStart(map2.steps[to].introStart);
      return rest.slice(0, at) + block + rest.slice(at);
    }
    const last = map2.steps[map2.steps.length - 1];
    const at = ed2.lineEnd(last.endLine);
    const glue = at === rest.length && !rest.endsWith("\n") ? "\n" : "";
    return rest.slice(0, at) + glue + block + rest.slice(at);
  });
}

// Remove one [[step.move]] / [[step.arrow]] / [[step.label]] of a step, with
// the comments above it. list: "moves" | "arrows" | "labels".
export function removeSubBlock(text, stepIndex, list, index) {
  return withMap(text, (doc, map, ed) => {
    const step = map.steps[stepIndex];
    const block = step && step[list] && step[list][index];
    if (!block) return text;
    ed.removeLines(block.introStart, block.fieldsEnd);
    return ed.apply();
  });
}
