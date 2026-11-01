/* 3DStep viewer runtime.
 *
 * One classic script, inlined into every generated page and loaded by its own
 * script element in the designer. It defines window.ThreeDStep (SPEC 9.11):
 *
 *   ThreeDStep.boot(options)         what a generated page calls: finds #tds,
 *                                    #tds-scene and the #tds-model-* elements,
 *                                    decodes the models, applies the URL
 *                                    parameters, creates the viewer, reports the
 *                                    page height to an embedding page
 *   ThreeDStep.createViewer(el, o)   the viewer: returns a handle (goToStep,
 *                                    play, reset, setScene, setModels, getCamera,
 *                                    setCamera, fit, setStyle, setProjection,
 *                                    pick, setSelection, previewPlacement,
 *                                    screenshot, resize, dispose, ...; in editor
 *                                    mode also `editor`, the hooks the designer's
 *                                    viewport tools use)
 *   ThreeDStep.foldSteps(scene, tree) the pure state folding of SPEC 8
 *   ThreeDStep.renderText(text)       the step-text markup of SPEC 9.6
 *   ThreeDStep.defaults               behavior defaults and the default palettes
 *
 * Needs window.THREE (the vendored Three.js bundle) for the 3D view; the pure
 * functions and the panel work without it. Everything is wrapped in one IIFE;
 * there is no module syntax and no build step.
 *
 * Rendering (SPEC 9.5): the "lineart" style draws the parts into a G-buffer
 * (fill color, view-space normal, edge class, depth) and runs two full-screen
 * passes: one detects edges one pixel wide where the depth or the normal
 * changes, the other widens them to the theme's edge width and composites the
 * fills, the edges and the depth onto the transparent canvas. Ghost and fading
 * parts are drawn afterwards, translucent, without edges. The "shaded" style
 * is a plain lit forward render. Frames are drawn on demand only.
 *
 * Copyright (C) 2026 Isik's Tech. GPL-3.0, like the rest of 3DStep.
 */
(function () {
  "use strict";

  var VERSION = "0.1.0";

  // ── Strings (one table, for a later i18n pass) ─────────────────────
  var STR = {
    prev: "Previous",
    next: "Next",
    play: "Play",
    reset: "Reset",
    resetView: "Reset view",
    fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    styleToggle: "Switch between line art and shaded",
    projectionToggle: "Switch between orthographic and perspective",
    stepsLabel: "Steps",
    stepOf: "Step {n} of {total}",
    counter: "{n} / {total}",
    installed: "In this step: ",
    hintMouse: "Drag to rotate · Scroll to zoom",
    hintMouseInactive: "Click to interact",
    hintMouseActive: "Drag to rotate · Scroll to zoom · Esc to release",
    hintTouch: "Tap to interact",
    hintTouchActive: "Drag to rotate · Pinch to zoom",
    credit: "3DStep",
    noWebgl: "This 3D view needs WebGL",
    openTab: "Open in a new tab",
    loading: "Loading the 3D view…",
    stillLoading: "Still loading…",
    loadError: "The 3D view could not be loaded",
    noSteps: "This project has no steps.",
    viewerLabel: "3D assembly instructions: {title}",
    viewLabel: "3D view"
  };

  // ── Defaults (SPEC 10.1, 10.2; keep in step with config.py) ────────
  var BEHAVIOR_DEFAULTS = {
    panelPlacement: "right",
    panelStackBreakpoint: 760,
    panelMaxWidth: 360,
    stepList: true,
    showTitle: true,
    showParts: true,
    viewportAspect: 1.6,
    viewportMinHeight: 320,
    viewportMaxHeight: 720,
    fontScale: 1.0,
    controls: "full",
    edgeWidth: 1.0,
    edgeAngle: 35,
    arrowScale: 1.0,
    transitionMs: 600,
    playMs: 900,
    autoplay: false,
    hintAutohide: 4,
    fullscreenButton: true,
    styleToggle: false,
    projectionToggle: false
  };
  var LIGHT = {
    "bg": "#ffffff", "text": "#1a1a1a",
    "tip-bg": "#ffffff", "tip-border": "#d0d0d0", "tip-shadow": "rgba(0,0,0,.12)",
    "hint-bg": "rgba(30,30,30,.75)", "hint-text": "#fff",
    "divider": "#e5e5e5", "desc-color": "#555",
    "scroll-thumb": "rgba(0,0,0,.22)", "scroll-track": "transparent",
    "accent": "#2563eb", "view-bg": "#ffffff",
    "part-fill": "#ffffff", "part-edge": "#3a3a3a",
    "highlight-fill": "#b8cff5", "highlight-edge": "#2f5fb3",
    "arrow": "#2563eb", "arrow-edge": "#1e3a8a",
    "label-bg": "rgba(255,255,255,.92)", "label-text": "#1a1a1a", "label-line": "#3a3a3a",
    "ghost-opacity": "0.25"
  };
  var DARK = {
    "bg": "#131313", "text": "#e0e0e0",
    "tip-bg": "#1e1e1e", "tip-border": "#3a3a3a", "tip-shadow": "rgba(0,0,0,.4)",
    "hint-bg": "rgba(240,240,240,.85)", "hint-text": "#131313",
    "divider": "#333", "desc-color": "#aaa",
    "scroll-thumb": "rgba(255,255,255,.20)", "scroll-track": "transparent",
    "accent": "#60a5fa", "view-bg": "#1a1a1a",
    "part-fill": "#2a2a2a", "part-edge": "#d0d0d0",
    "highlight-fill": "#2f4f8f", "highlight-edge": "#9cc0ff",
    "arrow": "#60a5fa", "arrow-edge": "#cfe2ff",
    "label-bg": "rgba(30,30,30,.92)", "label-text": "#e0e0e0", "label-line": "#bbbbbb",
    "ghost-opacity": "0.3"
  };
  var TOKEN_NAMES = Object.keys(LIGHT);
  var DEFAULT_DIR_Z = [0.62, -0.72, 0.52];   // front-right-above, Z-up (SPEC 9.4)
  var DEFAULT_DIR_Y = [0.62, 0.52, -0.72];   // the Y-up equivalent
  var EDGE_CLASS = { none: 0, part: 1, highlight: 2, arrow: 3, selected: 4 };
  var MAX_KERNEL = 36;

  // ── Small helpers ──────────────────────────────────────────────────
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function fmt(s, vars) { return s.replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? vars[k] : m; }); }
  function isVec3(v) { return Array.isArray(v) && v.length === 3 && v.every(function (x) { return typeof x === "number" && isFinite(x); }); }
  function vec3(v, fallback) { return isVec3(v) ? v.slice() : (fallback || [0, 0, 0]).slice(); }
  function num(v, fallback) { var n = typeof v === "string" ? parseFloat(v) : v; return typeof n === "number" && isFinite(n) ? n : fallback; }
  function bool(v, fallback) {
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return fallback;
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function base64ToArrayBuffer(b64) {
    var bin = atob(b64.replace(/\s+/g, ""));
    var n = bin.length, bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (typeof data === "string") return base64ToArrayBuffer(data);
    throw new Error("model data must be an ArrayBuffer, a typed array or a base64 string");
  }
  function vlen(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vnorm(a) { var l = vlen(a); return l > 0 ? vscale(a, 1 / l) : [0, 0, 1]; }

  // ── URL parameters (SPEC 9.10) ─────────────────────────────────────
  var CONTROLS = ["full", "minimal", "none"];
  var STYLES = ["lineart", "shaded"];
  function parseParams(search) {
    var out = { theme: null, step: null, controls: null, style: null, autoplay: false };
    var q;
    try { q = new URLSearchParams(search || ""); } catch (e) { return out; }
    var theme = q.get("theme");
    if (theme === "dark" || theme === "light") out.theme = theme;
    var step = q.get("step");
    // Kept as a string: stepIndex reads a numeric string as a 1-based step
    // number (?step=1 is the first step), a number as a 0-based index.
    if (step !== null && step.trim() !== "") out.step = step.trim();
    var controls = q.get("controls");
    if (controls && CONTROLS.indexOf(controls) >= 0) out.controls = controls;
    var style = q.get("style");
    if (style && STYLES.indexOf(style) >= 0) out.style = style;
    var autoplay = q.get("autoplay");
    out.autoplay = autoplay === "1" || autoplay === "true";
    return out;
  }

  // ── Step text markup (SPEC 9.6) ────────────────────────────────────
  function safeUrl(u) {
    if (/^https?:\/\//i.test(u)) return true;
    return !/^[a-z][a-z0-9+.\-]*:/i.test(u);   // relative: no scheme at all
  }
  function renderInline(text) {
    var codes = [];
    var s = text.replace(/`([^`\n]+)`/g, function (m, c) {
      codes.push("<code>" + c + "</code>");
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, function (m, label, url) {
      if (!safeUrl(url)) return label;
      return '<a href="' + url + '" target="_blank" rel="noopener">' + label + "</a>";
    });
    s = s.replace(/\n/g, "<br>");
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return codes[+i]; });
  }
  function renderText(text) {
    if (text == null) return "";
    var clean = String(text).replace(/\r\n?/g, "\n").trim();
    if (!clean) return "";
    var paras = clean.split(/\n[ \t]*\n+/);
    var out = [];
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i].trim();
      if (!p) continue;
      out.push("<p>" + renderInline(escapeHtml(p)) + "</p>");
    }
    return out.join("");
  }

  // ── Model trees and state folding (SPEC 8) ─────────────────────────
  // normalizeTree accepts the shapes a tree arrives in: nested nodes
  // ({id, label, children, has_mesh}, as glb.py's tree() and the viewer's own
  // registry give them), a designer Model ({nodes: [{id, label, parent,
  // children: [indices], mesh}]}), or an array of either.
  function normalizeTree(tree) {
    var reg = { order: [], members: {}, parts: {}, labels: {}, groups: {}, parentOf: {} };
    function addNested(node, parentId) {
      if (!node || typeof node.id !== "string") return [];
      var id = node.id;
      reg.order.push(id);
      reg.labels[id] = node.label || node.name || id;
      if (parentId) reg.parentOf[id] = parentId;
      var kids = Array.isArray(node.children) ? node.children : [];
      var isPart = kids.length === 0 || node.has_mesh === true || node.hasMesh === true || (node.mesh != null && node.mesh >= 0);
      var mine = [];
      for (var i = 0; i < kids.length; i++) mine = mine.concat(addNested(kids[i], id));
      if (isPart && (node.has_mesh === true || node.hasMesh === true || kids.length === 0 || (node.mesh != null && node.mesh >= 0))) {
        reg.parts[id] = true;
        mine.unshift(id);
      } else {
        reg.groups[id] = true;
      }
      reg.members[id] = mine;
      return mine;
    }
    function addModel(model) {
      var nodes = model.nodes;
      var byIndex = nodes.map(function (n) {
        return { id: n.id, label: n.label, children: [], has_mesh: n.mesh != null && n.mesh >= 0 };
      });
      var roots = [];
      for (var i = 0; i < nodes.length; i++) {
        var kids = Array.isArray(nodes[i].children) ? nodes[i].children : [];
        for (var k = 0; k < kids.length; k++) if (byIndex[kids[k]]) byIndex[i].children.push(byIndex[kids[k]]);
        if (nodes[i].parent == null || nodes[i].parent < 0) roots.push(byIndex[i]);
      }
      roots.forEach(function (r) { addNested(r, null); });
    }
    function add(t) {
      if (!t) return;
      if (Array.isArray(t)) { t.forEach(add); return; }
      if (Array.isArray(t.nodes)) { addModel(t); return; }
      if (Array.isArray(t.trees)) { t.trees.forEach(add); return; }
      if (Array.isArray(t.roots)) { t.roots.forEach(add); return; }
      addNested(t, null);
    }
    add(tree);
    return reg;
  }

  // Play moves only the parts a step shows (playMoves), so a step whose moved
  // parts are all hidden has nothing to play.
  function hasVisibleMoves(st) {
    return !!st && Object.keys(st.placed).some(function (id) { return st.visible[id]; });
  }

  function foldSteps(scene, tree) {
    var reg = tree && tree.members ? tree : normalizeTree(tree);
    var warnings = [];
    var steps = Array.isArray(scene && scene.steps) ? scene.steps : [];
    var partIds = reg.order.filter(function (id) { return reg.parts[id]; });

    function expand(list, where) {
      var out = [];
      if (!Array.isArray(list)) return out;
      list.forEach(function (id) {
        var m = reg.members[id];
        if (!m) { warnings.push(where + ": unknown id '" + id + "'"); return; }
        m.forEach(function (p) { if (out.indexOf(p) < 0) out.push(p); });
      });
      return out;
    }

    var visible = {};
    var startVisible = scene.start !== "hidden";
    partIds.forEach(function (id) { visible[id] = startVisible; });

    var home = scene.camera;
    var prevCam;
    if (home && isVec3(home.position) && isVec3(home.target)) {
      prevCam = { kind: "explicit", position: vec3(home.position), target: vec3(home.target),
        fov: num(home.fov, 35), projection: home.projection === "perspective" ? "perspective" : "orthographic" };
    } else {
      prevCam = { kind: "auto", fov: num(home && home.fov, 35),
        projection: home && home.projection === "perspective" ? "perspective" : "orthographic" };
    }

    var states = [];
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i] || {};
      var where = "step " + (i + 1) + (step.id ? " (" + step.id + ")" : "");
      // One id written in both lists is an error, as config.py has it; a part
      // reached through a group in one list and named in the other is hidden,
      // then shown (SPEC 6: hide, then show).
      var rawShow = Array.isArray(step.show) ? step.show : [];
      var rawHide = Array.isArray(step.hide) ? step.hide : [];
      var both = rawShow.filter(function (id) { return rawHide.indexOf(id) >= 0; });
      if (both.length) throw new Error(where + ": '" + both[0] + "' is in both show and hide");
      var hide = expand(step.hide, where + " hide");
      var show = expand(step.show, where + " show");
      hide.forEach(function (id) { visible[id] = false; });
      show.forEach(function (id) { visible[id] = true; });

      var placed = {};
      var moves = Array.isArray(step.moves) ? step.moves : [];
      moves.forEach(function (mv, mi) {
        if (!mv || !Array.isArray(mv.parts)) return;
        var offset = vec3(mv.offset), rotate = vec3(mv.rotate);
        var arrow = mv.arrow !== false;
        mv.parts.forEach(function (id) {
          var m = reg.members[id];
          if (!m) { warnings.push(where + " move: unknown id '" + id + "'"); return; }
          m.forEach(function (p) {
            placed[p] = { offset: offset, rotate: rotate, arrow: arrow, pivot: id, move: mi };
          });
        });
      });

      var highlight = expand(step.highlight, where + " highlight");
      var ghost = expand(step.ghost, where + " ghost");
      var highlightSet = {}, ghostSet = {};
      highlight.forEach(function (id) { highlightSet[id] = true; });
      ghost.forEach(function (id) { ghostSet[id] = true; });

      var sc = step.camera;
      var cam;
      if (sc && isVec3(sc.position) && isVec3(sc.target)) {
        cam = { kind: "explicit", position: vec3(sc.position), target: vec3(sc.target),
          fov: num(sc.fov, prevCam.fov), projection: sc.projection || prevCam.projection };
      } else if (sc && Array.isArray(sc.fit)) {
        cam = { kind: "fit", fit: expand(sc.fit, where + " camera fit"),
          fov: num(sc.fov, prevCam.fov), projection: sc.projection || prevCam.projection };
      } else if (sc && (sc.fov != null || sc.projection)) {
        cam = Object.assign({}, prevCam, { fov: num(sc.fov, prevCam.fov), projection: sc.projection || prevCam.projection });
      } else {
        cam = prevCam;
      }
      prevCam = cam;

      var vis = {};
      partIds.forEach(function (id) { if (visible[id]) vis[id] = true; });
      [highlight, ghost].forEach(function (list, li) {
        list.forEach(function (id) {
          if (!visible[id]) warnings.push(where + ": '" + id + "' is " + (li ? "ghosted" : "highlighted") + " but hidden");
        });
      });
      Object.keys(placed).forEach(function (id) {
        if (!visible[id]) warnings.push(where + ": '" + id + "' is moved but hidden");
      });
      // An arrow or label attached to a part (or a group with no member) hidden
      // in this step is hidden with it, as config.check_ids warns.
      [["arrow", step.arrows], ["label", step.labels]].forEach(function (pair) {
        if (!Array.isArray(pair[1])) return;
        pair[1].forEach(function (a, ai) {
          var m = a && typeof a.attach === "string" && a.attach ? reg.members[a.attach] : null;
          if (m && m.length && !m.some(function (p) { return visible[p]; })) {
            warnings.push(where + ": " + pair[0] + " " + (ai + 1) + " is attached to '" + a.attach + "', which is hidden");
          }
        });
      });

      states.push({
        index: i,
        id: typeof step.id === "string" && step.id ? step.id : "step-" + (i + 1),
        title: typeof step.title === "string" && step.title ? step.title : "Step " + (i + 1),
        text: typeof step.text === "string" ? step.text : "",
        note: typeof step.note === "string" ? step.note : "",
        visible: vis,
        placed: placed,
        highlight: highlightSet,
        ghost: ghostSet,
        highlightIds: Array.isArray(step.highlight) ? step.highlight.slice() : [],
        camera: cam,
        arrows: Array.isArray(step.arrows) ? step.arrows.map(normalizeArrow) : [],
        labels: Array.isArray(step.labels) ? step.labels.map(normalizeLabel) : []
      });
    }
    states.warnings = warnings;
    states.registry = reg;
    return states;
  }
  function normalizeArrow(a) {
    a = a || {};
    return {
      from: vec3(a.from), to: vec3(a.to, [0, 0, 1]),
      kind: a.kind === "rotate" ? "rotate" : "straight",
      turns: num(a.turns, 0.75), radius: num(a.radius, 4),
      color: typeof a.color === "string" ? a.color : "",
      label: typeof a.label === "string" ? a.label : "",
      attach: typeof a.attach === "string" ? a.attach : ""
    };
  }
  function normalizeLabel(l) {
    l = l || {};
    return {
      text: typeof l.text === "string" ? l.text : "",
      at: vec3(l.at),
      side: ["left", "right", "top", "bottom"].indexOf(l.side) >= 0 ? l.side : "auto",
      attach: typeof l.attach === "string" ? l.attach : ""
    };
  }

  // ── Camera math (SPEC 9.4) ─────────────────────────────────────────
  // Half-height of the orthographic frustum that frames the same view as a
  // perspective camera with `fov` at `distance` from its target.
  function orthoHalfHeight(distance, fovDeg) { return distance * Math.tan(fovDeg * Math.PI / 360); }
  // The camera that frames a box (bounding sphere + 10% margin) from `dir` (a
  // unit vector from the target toward the camera).
  function fitCamera(box, dir, fovDeg, projection, aspect) {
    var center = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    var radius = vlen(vsub(box.max, box.min)) / 2;
    if (!(radius > 0)) radius = 1;
    var fov = clamp(num(fovDeg, 35), 1, 179);
    var a = num(aspect, 1.6) || 1.6;
    var half = radius * 1.1 / Math.min(1, a);
    var distance = projection === "perspective"
      ? half / Math.sin(fov * Math.PI / 360)
      : half / Math.tan(fov * Math.PI / 360);
    return { position: vadd(center, vscale(vnorm(dir), distance)), target: center, fov: fov, projection: projection, radius: radius };
  }

  // ── Arrow math (SPEC 9.7) ──────────────────────────────────────────
  function arrowSizes(sceneDiameter, arrowScale) {
    var s = num(arrowScale, 1);
    return {
      shaftRadius: clamp(sceneDiameter * 0.006, 0.5, 6) * s,
      headLength: clamp(sceneDiameter * 0.03, 2, 20) * s,
      headRadius: clamp(sceneDiameter * 0.006, 0.5, 6) * s * 2
    };
  }
  // An auto arrow runs from the displayed center to the assembled center,
  // shortened at both ends by 0.6 × the part's bounding-sphere radius; it is
  // omitted (null) when shorter than the head.
  function autoArrowSpan(displayed, assembled, partRadius, headLength) {
    var d = vsub(assembled, displayed), len = vlen(d);
    var cut = partRadius * 0.6;
    if (len - 2 * cut < headLength) return null;
    var dir = vscale(d, 1 / len);
    return { from: vadd(displayed, vscale(dir, cut)), to: vsub(assembled, vscale(dir, cut)) };
  }

  // ── Activation (SPEC 9.9), a state machine without DOM ─────────────
  function createActivation(opts) {
    opts = opts || {};
    var setT = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    var clearT = opts.clearTimeout || function (id) { clearTimeout(id); };
    var leaveMs = num(opts.leaveMs, 2000);
    var machine = { active: !opts.embedded, standalone: !opts.embedded, fullscreen: false, _timer: null };
    function set(v) {
      if (machine.active === v) return;
      machine.active = v;
      if (opts.onChange) opts.onChange(v);
    }
    function cancel() { if (machine._timer != null) { clearT(machine._timer); machine._timer = null; } }
    machine.activate = function () { cancel(); set(true); };
    machine.deactivate = function () { cancel(); set(false); };
    machine.pointerDown = function (inside, pointerType) {
      if (!inside) { machine.deactivate(); return; }
      cancel();
      if (pointerType !== "touch") set(true);
    };
    machine.pointerUp = function (moved, pointerType) {
      if (pointerType === "touch" && !moved) set(true);
    };
    machine.escape = function () { machine.deactivate(); };
    machine.pointerLeave = function (pointerType) {
      if (pointerType === "touch" || !machine.active) return;
      cancel();
      machine._timer = setT(function () { machine._timer = null; set(false); }, leaveMs);
    };
    machine.pointerEnter = function () { cancel(); };
    machine.interaction = function () { cancel(); };
    machine.visibility = function (visible) { if (!visible) machine.deactivate(); };
    machine.setFullscreen = function (fs) { machine.fullscreen = fs; if (fs) machine.activate(); };
    machine.dispose = cancel;
    return machine;
  }

  // ── Height reporting (SPEC 9.8), the dedupe without DOM ────────────
  function createHeightReporter(opts) {
    var last = -1, settling = false;
    var threshold = num(opts.threshold, 2);
    var setTimer = opts.setTimeout || (typeof setTimeout === "function" ? setTimeout : null);
    function measure() { return Math.ceil(num(opts.measure(), -1)); }
    var api = {
      report: function () {
        if (opts.isFullscreen && opts.isFullscreen()) return false;
        var h = measure();
        if (!(h >= 0)) return false;
        if (last >= 0 && Math.abs(h - last) <= threshold) {
          // A small change is not posted at once (no chatter while things
          // move), but once they settle, so the frame ends where the page does.
          if (h !== last && setTimer && !settling) {
            settling = true;
            setTimer(function () { settling = false; api.settle(); }, num(opts.settleMs, 250));
          }
          return false;
        }
        last = h;
        opts.post(h);
        return true;
      },
      settle: function () {
        if (opts.isFullscreen && opts.isFullscreen()) return false;
        var h = measure();
        if (!(h >= 0) || h === last) return false;
        last = h;
        opts.post(h);
        return true;
      },
      reset: function () { last = -1; },
      last: function () { return last; }
    };
    return api;
  }

  // ── Theme tokens ───────────────────────────────────────────────────
  function camel(name) { return name.replace(/-([a-z0-9])/g, function (m, c) { return c.toUpperCase(); }); }
  function isDarkScheme(doc) {
    var forced = doc.documentElement.getAttribute("data-theme");
    if (forced === "dark") return true;
    if (forced === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function readTokens(el) {
    var dark = isDarkScheme(el.ownerDocument);
    var defaults = dark ? DARK : LIGHT;
    var cs = window.getComputedStyle(el);
    var t = { dark: dark };
    TOKEN_NAMES.forEach(function (name) {
      var v = cs.getPropertyValue("--tds-" + name).trim();
      if (!v) v = cs.getPropertyValue("--" + name).trim();
      if (!v) v = defaults[name];
      // a value the browser cannot read as a color takes the scheme's default
      if (name !== "ghost-opacity" && resolveColor(v) === null) v = defaults[name];
      t[camel(name)] = v;
    });
    t.ghostOpacity = clamp(num(t.ghostOpacity, 0.25), 0, 1);
    return t;
  }

  // ── CSS colors → sRGB bytes ────────────────────────────────────────
  // THREE.Color reads only hex, rgb(), hsl() and named colors, and warns
  // about anything else (transparent, color-mix(), oklch(), an alpha). The
  // browser resolves any CSS color: a 2D canvas serializes it as #rrggbb or
  // rgba(), and a form it serializes otherwise (color(), oklch()) is painted
  // into its one pixel and read back.
  var colorCtx;
  var colorCache = {};
  function colorContext() {
    if (colorCtx === undefined) {
      colorCtx = null;
      try {
        var c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        colorCtx = (c.getContext && c.getContext("2d", { willReadFrequently: true })) || null;
      } catch (e) { colorCtx = null; }
    }
    return colorCtx;
  }
  // {r, g, b (0 to 255), a (0 to 1)} for a CSS color, null when the value is
  // not a color, undefined when there is no canvas to ask (Node).
  function resolveColor(str) {
    var ctx = colorContext();
    if (!ctx) return undefined;
    var s = String(str == null ? "" : str).trim();
    if (Object.prototype.hasOwnProperty.call(colorCache, s)) return colorCache[s];
    var out = null;
    if (s) {
      // an assignment the canvas cannot parse is ignored: two sentinels tell
      ctx.fillStyle = "#010203";
      ctx.fillStyle = s;
      var v = String(ctx.fillStyle);
      ctx.fillStyle = "#030201";
      ctx.fillStyle = s;
      if (String(ctx.fillStyle) === v) {
        var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
        var f = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
        if (m) out = { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
        else if (f) out = { r: +f[1], g: +f[2], b: +f[3], a: f[4] === undefined ? 1 : +f[4] };
        else {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillRect(0, 0, 1, 1);
          var d = ctx.getImageData(0, 0, 1, 1).data;
          out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        }
      }
    }
    colorCache[s] = out;
    return out;
  }

  // ── Behaviors from the root's data-* attributes ────────────────────
  function readBehavior(el, overrides) {
    var ds = (el && el.dataset) || {};
    var b = {};
    Object.keys(BEHAVIOR_DEFAULTS).forEach(function (k) {
      var def = BEHAVIOR_DEFAULTS[k];
      var raw = ds[k];
      if (typeof def === "boolean") b[k] = bool(raw, def);
      else if (typeof def === "number") b[k] = num(raw, def);
      else b[k] = typeof raw === "string" && raw ? raw : def;
    });
    if (overrides) Object.keys(overrides).forEach(function (k) { if (overrides[k] != null) b[k] = overrides[k]; });
    if (CONTROLS.indexOf(b.controls) < 0) b.controls = "full";
    if (["right", "below", "overlay"].indexOf(b.panelPlacement) < 0) b.panelPlacement = "right";
    return b;
  }

  // ── Shaders ────────────────────────────────────────────────────────
  var GBUF_VERT = [
    "out vec3 vN;",
    "void main() {",
    "  vN = normalMatrix * normal;",
    "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
    "}"
  ].join("\n");
  var GBUF_FRAG = [
    "in vec3 vN;",
    "uniform vec3 uFill;",
    "uniform float uCls;",
    "layout(location = 0) out vec4 oColor;",
    "layout(location = 1) out vec4 oNormal;",
    "void main() {",
    "  vec3 n = normalize(vN);",
    "  if (!gl_FrontFacing) n = -n;",
    "  oColor = vec4(uFill, 1.0);",
    "  oNormal = vec4(n * 0.5 + 0.5, uCls);",
    "}"
  ].join("\n");
  var QUAD_VERT = [
    "out vec2 vUv;",
    "void main() {",
    "  vUv = uv;",
    "  gl_Position = vec4(position.xy, 0.0, 1.0);",
    "}"
  ].join("\n");
  // Edge detection, one pixel wide. A pixel is a seed where the depth or the
  // normal changes between it and its right or upper neighbor. The depth test
  // compares the jump to the slope on the other side (a plane seen at a
  // grazing angle has a large slope but no jump), the normal test compares the
  // angle to the next pair's angle (a smooth cylinder turns steadily, a crease
  // does not). The seed records the class of the nearer pixel for its color.
  var EDGE_FRAG = [
    "in vec2 vUv;",
    "uniform sampler2D tNormal;",
    "uniform sampler2D tDepth;",
    "uniform vec2 uTexel;",
    "uniform float uNear;",
    "uniform float uFar;",
    "uniform float uOrtho;",
    "uniform float uDepthT;",
    "uniform float uAngleT;",
    "layout(location = 0) out vec4 oEdge;",
    "float lin(float d) {",
    "  if (uOrtho > 0.5) return uNear + d * (uFar - uNear);",
    "  return (uNear * uFar) / (uFar - d * (uFar - uNear));",
    "}",
    "float ang(vec3 a, vec3 b) { return acos(clamp(dot(a, b), -1.0, 1.0)); }",
    "vec3 dec(vec4 g) { return normalize(g.rgb * 2.0 - 1.0); }",
    "void main() {",
    "  vec2 dx = vec2(uTexel.x, 0.0), dy = vec2(0.0, uTexel.y);",
    "  vec4 gc = texture(tNormal, vUv);",
    "  vec4 gr = texture(tNormal, vUv + dx);",
    "  vec4 gl = texture(tNormal, vUv - dx);",
    "  vec4 gu = texture(tNormal, vUv + dy);",
    "  vec4 gd = texture(tNormal, vUv - dy);",
    "  float zc = lin(texture(tDepth, vUv).r);",
    "  float zr = lin(texture(tDepth, vUv + dx).r);",
    "  float zl = lin(texture(tDepth, vUv - dx).r);",
    "  float zu = lin(texture(tDepth, vUv + dy).r);",
    "  float zd = lin(texture(tDepth, vUv - dy).r);",
    "  float cc = gc.a, cr = gr.a, cu = gu.a;",
    "  float best = 0.0; float cls = cc;",
    // depth jumps between c and r, c and u
    "  float jx = zr - zc, sx = zc - zl;",
    "  float ex = (abs(jx) > abs(sx)) ? abs(jx - sx) : 0.0;",
    "  float jy = zu - zc, sy = zc - zd;",
    "  float ey = (abs(jy) > abs(sy)) ? abs(jy - sy) : 0.0;",
    "  float sdx = smoothstep(0.5, 1.0, ex / uDepthT);",
    "  float sdy = smoothstep(0.5, 1.0, ey / uDepthT);",
    "  if (cc == 0.0 && cr == 0.0) sdx = 0.0;",
    "  if (cc == 0.0 && cu == 0.0) sdy = 0.0;",
    "  if (sdx > best) { best = sdx; cls = (zc <= zr) ? cc : cr; }",
    "  if (sdy > best) { best = sdy; cls = (zc <= zu) ? cc : cu; }",
    // creases: the angle to the neighbor, less the angle of the pair behind
    "  if (cc > 0.0) {",
    "    vec3 nc = dec(gc);",
    "    if (cr > 0.0) {",
    "      float a1 = ang(nc, dec(gr)), a0 = (gl.a > 0.0) ? ang(dec(gl), nc) : 0.0;",
    "      float sn = smoothstep(0.75, 1.0, max(a1 - a0, 0.0) / uAngleT);",
    "      if (sn > best) { best = sn; cls = cc; }",
    "    }",
    "    if (cu > 0.0) {",
    "      float a1 = ang(nc, dec(gu)), a0 = (gd.a > 0.0) ? ang(dec(gd), nc) : 0.0;",
    "      float sn = smoothstep(0.75, 1.0, max(a1 - a0, 0.0) / uAngleT);",
    "      if (sn > best) { best = sn; cls = cc; }",
    "    }",
    "  }",
    "  oEdge = vec4(best, cls, 0.0, 1.0);",
    "}"
  ].join("\n");
  // Composite: widen the seeds to the edge width (square kernel), paint the
  // fills under the edges, output premultiplied alpha (the canvas is
  // transparent over the CSS view background) and carry the depth over so the
  // translucent passes that follow are occluded correctly.
  var COMP_FRAG = [
    "in vec2 vUv;",
    "uniform sampler2D tColor;",
    "uniform sampler2D tDepth;",
    "uniform sampler2D tEdge;",
    "uniform vec2 uTexel;",
    "uniform vec2 uKernel[" + MAX_KERNEL + "];",
    "uniform int uKernelN;",
    "uniform vec3 uEdgeColor[6];",
    "layout(location = 0) out vec4 oC;",
    "void main() {",
    "  vec4 col = texture(tColor, vUv);",
    "  float d = texture(tDepth, vUv).r;",
    "  float fillA = col.a;",
    "  float es = 0.0; int ec = 0;",
    "  for (int i = 0; i < " + MAX_KERNEL + "; i++) {",
    "    if (i >= uKernelN) break;",
    "    vec4 e = texture(tEdge, vUv - uKernel[i] * uTexel);",
    "    if (e.r > es) { es = e.r; ec = int(e.g * 255.0 + 0.5); }",
    "  }",
    "  vec3 ecol = uEdgeColor[clamp(ec, 0, 5)];",
    "  vec3 rgb = col.rgb * fillA * (1.0 - es) + ecol * es;",
    "  float a = fillA * (1.0 - es) + es;",
    "  oC = vec4(rgb, a);",
    "  gl_FragDepth = d;",
    "}"
  ].join("\n");

  function edgeKernel(width) {
    var w = clamp(Math.round(width), 1, 6);
    var lo = 0 - Math.floor((w - 1) / 2), hi = Math.ceil((w - 1) / 2);
    var out = [];
    for (var y = lo; y <= hi; y++) for (var x = lo; x <= hi; x++) out.push([x + 0, y + 0]);
    return out;
  }

  // ── Icons ──────────────────────────────────────────────────────────
  var SVG_ATTR = ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  var ICONS = {
    max: '<svg class="i-max"' + SVG_ATTR + '><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    min: '<svg class="i-min"' + SVG_ATTR + '><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    play: '<svg class="i-play"' + SVG_ATTR + '><path d="M7 4l12 8-12 8z"/></svg>',
    reset: '<svg class="i-reset"' + SVG_ATTR + '><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    home: '<svg' + SVG_ATTR + '><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    prev: '<svg' + SVG_ATTR + '><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg' + SVG_ATTR + '><path d="M9 5l7 7-7 7"/></svg>',
    note: '<svg' + SVG_ATTR + '><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>'
  };

  // ── The viewer ─────────────────────────────────────────────────────
  function createViewer(container, options) {
    options = options || {};
    var doc = container.ownerDocument || document;
    var win = doc.defaultView || window;
    var THREE = win.THREE || window.THREE;
    var scene = options.scene || { steps: [] };
    var editor = !!options.editor;
    var embedded = typeof options.embedded === "boolean" ? options.embedded : (win.parent !== win);
    var behavior = readBehavior(container, options.behavior);
    if (options.controls && CONTROLS.indexOf(options.controls) >= 0) behavior.controls = options.controls;
    var style = STYLES.indexOf(options.style) >= 0 ? options.style : (STYLES.indexOf(scene.style) >= 0 ? scene.style : (container.dataset.style || "lineart"));
    if (STYLES.indexOf(style) < 0) style = "lineart";
    var reducedQuery = win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
    function reducedMotion() {
      if (typeof options.reducedMotion === "boolean") return options.reducedMotion;
      return !!(reducedQuery && reducedQuery.matches);
    }
    var standaloneUrl = options.standaloneUrl || (win.location ? win.location.href : "");

    // Public handle, filled in below.
    var handle = {
      VERSION: VERSION,
      root: container,
      stats: { frames: 0 },
      onStep: options.onStep || null,
      onReady: options.onReady || null,
      onError: options.onError || null,
      onPick: options.onPick || null,
      onCamera: options.onCamera || null,
      onActivate: options.onActivate || null,
      ready: false,
      disposed: false
    };

    // ── DOM ──────────────────────────────────────────────────────────
    container.classList.add("tds");
    container.setAttribute("data-style", style);
    container.setAttribute("data-controls", behavior.controls);
    container.setAttribute("data-placement", behavior.panelPlacement);
    if (editor) container.classList.add("is-editor");
    if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "0");
    container.setAttribute("role", "region");
    container.setAttribute("aria-label", fmt(STR.viewerLabel, { title: scene.title || "" }));
    while (container.firstChild) container.removeChild(container.firstChild);

    function el(tag, cls, html) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (html != null) e.innerHTML = html;
      return e;
    }
    function button(cls, label, html) {
      var b = el("button", cls, html);
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.title = label;
      return b;
    }

    var main = el("div", "tds-main");
    var view = el("div", "tds-view");
    view.setAttribute("aria-label", STR.viewLabel);
    var canvas = el("canvas", "tds-canvas");
    var overlay = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.setAttribute("class", "tds-overlay");
    overlay.setAttribute("aria-hidden", "true");
    var labelsBox = el("div", "tds-labels");
    labelsBox.setAttribute("aria-hidden", "true");
    var hud = el("div", "tds-hud");
    var hudLeft = el("div", "tds-hud-left");
    var hudRight = el("div", "tds-hud-right");
    var counter = el("span", "tds-counter");
    counter.setAttribute("aria-live", "off");
    var hudNav = el("span", "tds-hud-nav");
    var btnHudPrev = button("tds-btn-prev", STR.prev, ICONS.prev);
    var btnHudNext = button("tds-btn-next", STR.next, ICONS.next);
    hudNav.appendChild(btnHudPrev);
    hudNav.appendChild(btnHudNext);
    hudLeft.appendChild(counter);
    hudLeft.appendChild(hudNav);
    var btnStyle = button("tds-btn-style", STR.styleToggle, '<span class="tds-glyph" aria-hidden="true">◑</span>');
    var btnProj = button("tds-btn-proj", STR.projectionToggle, '<span class="tds-glyph" aria-hidden="true">▧</span>');
    var btnZoomIn = button("tds-btn-zoom-in", STR.zoomIn, '<span class="tds-glyph" aria-hidden="true">+</span>');
    var btnZoomOut = button("tds-btn-zoom-out", STR.zoomOut, '<span class="tds-glyph" aria-hidden="true">−</span>');
    var btnPlay = button("tds-btn-play", STR.play, ICONS.play + ICONS.reset);
    var btnHome = button("tds-btn-home", STR.resetView, ICONS.home);
    var btnFs = button("tds-btn-fs", STR.fullscreen, ICONS.max + ICONS.min);
    [btnStyle, btnProj, btnZoomIn, btnZoomOut, btnPlay, btnHome, btnFs].forEach(function (b) { hudRight.appendChild(b); });
    btnStyle.hidden = !behavior.styleToggle && !editor;
    btnProj.hidden = !behavior.projectionToggle && !editor;
    btnFs.hidden = !behavior.fullscreenButton || editor;
    hud.appendChild(hudLeft);
    hud.appendChild(hudRight);
    var caption = el("div", "tds-caption");
    var hint = el("div", "tds-hint");
    var hintText = el("span", "tds-hint-text");
    var credit = el("span", "tds-credit", STR.credit);
    hint.appendChild(hintText);
    hint.appendChild(credit);
    var fallback = el("div", "tds-fallback");
    fallback.hidden = true;
    view.appendChild(canvas);
    view.appendChild(overlay);
    view.appendChild(labelsBox);
    view.appendChild(hud);
    view.appendChild(hint);
    view.appendChild(fallback);

    var panel = el("aside", "tds-panel");
    panel.setAttribute("aria-label", STR.stepsLabel);
    var panelIn = el("div", "tds-panel-in");
    var head = el("div", "tds-panel-head");
    var titleEl = el("div", "tds-title");
    var descEl = el("div", "tds-desc");
    head.appendChild(titleEl);
    head.appendChild(descEl);
    head.hidden = !behavior.showTitle;
    var stepList = el("ol", "tds-steps");
    stepList.hidden = !behavior.stepList;
    var text = el("div", "tds-text");
    text.setAttribute("aria-live", "polite");
    var kicker = el("div", "tds-step-kicker");
    var stepTitle = el("h2", "tds-step-title");
    var partsEl = el("p", "tds-parts");
    var body = el("div", "tds-body");
    var noteEl = el("div", "tds-note");
    text.appendChild(kicker);
    text.appendChild(stepTitle);
    text.appendChild(partsEl);
    text.appendChild(body);
    text.appendChild(noteEl);
    var nav = el("div", "tds-nav");
    var btnPrev = button("tds-btn-prev", STR.prev, ICONS.prev + "<span>" + STR.prev + "</span>");
    var progress = el("div", "tds-progress");
    progress.setAttribute("role", "progressbar");
    var progressBar = el("div", "tds-progress-bar");
    progress.appendChild(progressBar);
    var btnNext = button("tds-btn-next", STR.next, "<span>" + STR.next + "</span>" + ICONS.next);
    nav.appendChild(btnPrev);
    nav.appendChild(progress);
    nav.appendChild(btnNext);
    panelIn.appendChild(head);
    panelIn.appendChild(stepList);
    panelIn.appendChild(text);
    panelIn.appendChild(nav);
    panel.appendChild(panelIn);

    main.appendChild(view);
    main.appendChild(caption);
    main.appendChild(panel);
    container.appendChild(main);

    // ── State ────────────────────────────────────────────────────────
    var states = [];           // folded steps
    var registry = null;       // normalized tree of the loaded models
    var parts = {};            // id -> part record
    var partList = [];
    var groupBox = {};         // group id -> Box3 (assembled)
    var modelBox = null;       // Box3 of everything
    var modelRadius = 1, modelCenter = [0, 0, 0];
    var current = -1;          // step index
    var played = false;
    var selection = [];
    var tokens = readTokens(container);
    var camCache = [];
    var disposed = false;
    var webgl = false;
    var renderer = null, controls = null, scene3 = null, root3 = null;
    var cameraP = null, cameraO = null, camera = null;
    var gbuf = null, edgeTarget = null, edgeQuad = null, compQuad = null;
    var edgeMat = null, compMat = null;
    var lights = null;
    var needsRender = false, rafId = 0, visible = true, flying = false, lastFrame = 0;
    var tweens = [];
    var arrows = [];           // active arrow records
    var labels = [];           // active label records
    var selArrow = -1, selLabel = -1;   // editor: the selected explicit arrow / label of the step
    var overlay3 = null;       // editor: gizmos and previews, drawn over the finished frame
    var matCache = {};
    var unloads = [];          // cleanup callbacks
    var raycaster = null;
    var dpr = 1;
    var modelsLoaded = false;
    var pendingStep = null;

    function fail(err, detail) {
      var msg = err && err.message ? err.message : String(err);
      if (win.console && win.console.error) win.console.error("ThreeDStep:", err);
      showFallback(STR.loadError, detail || msg, true);
      if (handle.onError) { try { handle.onError(err); } catch (e) { /* ignore */ } }
    }
    function showFallback(title, detail, withLink, spinner) {
      fallback.innerHTML = "";
      if (spinner) fallback.appendChild(el("div", "tds-spinner"));
      fallback.appendChild(el("p", "", escapeHtml(title)));
      if (detail) fallback.appendChild(el("p", "tds-fallback-detail", escapeHtml(detail)));
      if (withLink && standaloneUrl) {
        var a = el("a", "", escapeHtml(STR.openTab));
        a.href = standaloneUrl;
        a.target = "_blank";
        a.rel = "noopener";
        fallback.appendChild(a);
      }
      fallback.hidden = false;
      relayout();
    }
    function hideFallback() { fallback.hidden = true; fallback.innerHTML = ""; }
    function relayout() {
      try { win.dispatchEvent(new win.Event("tds-relayout")); } catch (e) { /* old browsers */ }
    }

    // ── Panel ────────────────────────────────────────────────────────
    function partName(id) {
      var meta = scene.parts && scene.parts[id];
      if (meta && meta.name) return meta.name;
      if (registry && registry.labels[id]) return registry.labels[id];
      return id;
    }
    function renderPanelStatic() {
      titleEl.textContent = scene.title || "";
      descEl.textContent = scene.description || "";
      stepList.innerHTML = "";
      states.forEach(function (st, i) {
        var li = el("li");
        var b = button("", fmt(STR.stepOf, { n: i + 1, total: states.length }) + ": " + st.title,
          '<span class="tds-step-n">' + (i + 1) + '</span><span class="tds-step-t">' + escapeHtml(st.title) + "</span>");
        b.addEventListener("click", function () { goToStep(i, {}); });
        li.appendChild(b);
        stepList.appendChild(li);
      });
      progress.setAttribute("aria-valuemin", "1");
      progress.setAttribute("aria-valuemax", String(Math.max(1, states.length)));
    }
    function renderPanelStep(i) {
      var st = states[i];
      var total = states.length;
      Array.prototype.forEach.call(stepList.children, function (li, k) {
        li.classList.toggle("is-current", k === i);
        li.classList.toggle("is-done", k < i);
        var b = li.firstChild;
        if (b) { if (k === i) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current"); }
      });
      if (!st) {
        kicker.textContent = "";
        stepTitle.textContent = "";
        partsEl.textContent = "";
        body.innerHTML = "<p>" + escapeHtml(STR.noSteps) + "</p>";
        noteEl.innerHTML = "";
        counter.textContent = "";
        caption.textContent = "";
        btnPrev.disabled = btnNext.disabled = btnHudPrev.disabled = btnHudNext.disabled = true;
        progressBar.style.width = "0";
        return;
      }
      kicker.textContent = fmt(STR.stepOf, { n: i + 1, total: total });
      stepTitle.textContent = st.title;
      if (behavior.showParts && st.highlightIds.length) {
        // Equal names once, counted: four screws read "4× M3 screw".
        var named = [], at = Object.create(null);
        st.highlightIds.forEach(function (id) {
          var name = partName(id);
          if (at[name] != null) named[at[name]].count++;
          else { at[name] = named.length; named.push({ name: name, count: 1 }); }
        });
        partsEl.innerHTML = escapeHtml(STR.installed) + named.map(function (p) {
          return "<span>" + (p.count > 1 ? p.count + "× " : "") + escapeHtml(p.name) + "</span>";
        }).join(", ");
      } else {
        partsEl.textContent = "";
      }
      body.innerHTML = renderText(st.text);
      noteEl.innerHTML = st.note.trim() ? ICONS.note + "<span>" + renderInline(escapeHtml(st.note.trim())) + "</span>" : "";
      counter.textContent = fmt(STR.counter, { n: i + 1, total: total });
      caption.textContent = st.title;
      btnPrev.disabled = btnHudPrev.disabled = i <= 0;
      btnNext.disabled = btnHudNext.disabled = i >= total - 1;
      progressBar.style.width = ((i + 1) / total * 100) + "%";
      progress.setAttribute("aria-valuenow", String(i + 1));
      btnPlay.disabled = !hasVisibleMoves(st);
      btnPlay.setAttribute("aria-label", played ? STR.reset : STR.play);
      btnPlay.title = played ? STR.reset : STR.play;
    }

    // Stacked layout: animate the panel's height on a step change so an
    // embedding page can follow it frame by frame (SPEC 9.2).
    var panelAnim = null;
    function stacked() { return container.classList.contains("is-stacked") || behavior.panelPlacement === "below"; }
    function animatePanel(apply) {
      var canAnimate = stacked() && behavior.controls === "full" && !container.classList.contains("is-fs") && !reducedMotion() && behavior.panelPlacement !== "overlay";
      if (!canAnimate) { apply(); relayout(); return; }
      var h0 = panel.offsetHeight;
      if (panelAnim) { panelAnim(); panelAnim = null; }
      panel.style.height = "";
      panel.style.transition = "";
      apply();
      var h1 = panel.scrollHeight;
      if (Math.abs(h1 - h0) < 2) { relayout(); return; }
      panel.style.overflow = "hidden";
      panel.style.height = h0 + "px";
      void panel.offsetHeight;
      var done = false, frame = 0;
      function finish() {
        if (done) return;
        done = true;
        panel.removeEventListener("transitionend", onEnd);
        panel.style.height = "";
        panel.style.transition = "";
        panel.style.overflow = "";
        if (frame) win.cancelAnimationFrame(frame);
        panelAnim = null;
        relayout();
      }
      function onEnd(e) { if (!e || !e.propertyName || e.propertyName === "height") finish(); }
      function pump() { relayout(); if (!done) frame = win.requestAnimationFrame(pump); }
      panel.addEventListener("transitionend", onEnd);
      panelAnim = finish;
      win.requestAnimationFrame(function () {
        panel.style.transition = "height .28s ease";
        panel.style.height = h1 + "px";
        frame = win.requestAnimationFrame(pump);
      });
      win.setTimeout(finish, 420);
    }

    // ── Hint pill ────────────────────────────────────────────────────
    var touchUI = !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches);
    if (touchUI) container.classList.add("is-touch");
    var hintDone = false, hintTimer = null;
    function updateHint() {
      if (touchUI) hintText.textContent = activation.active ? STR.hintTouchActive : STR.hintTouch;
      else if (activation.standalone && !embedded) hintText.textContent = activation.active ? STR.hintMouse : STR.hintMouseInactive;
      else hintText.textContent = activation.active ? STR.hintMouseActive : STR.hintMouseInactive;
    }
    function hideHint() {
      if (hintDone || !(behavior.hintAutohide > 0)) return;
      hintDone = true;
      hint.classList.add("hf");
      win.setTimeout(function () { hint.classList.add("hh"); hint.classList.remove("hf"); requestRender(); }, 380);
    }
    function hintCountdown() {
      if (hintTimer === null && behavior.hintAutohide > 0) hintTimer = win.setTimeout(hideHint, behavior.hintAutohide * 1000);
    }

    // ── Activation (SPEC 9.9) ────────────────────────────────────────
    var activation = createActivation({
      embedded: embedded && !editor,
      onChange: function (active) {
        container.classList.toggle("is-active", active);
        if (controls) controls.enableRotate = active || !touchUI || editor;
        updateHint();
        if (handle.onActivate) { try { handle.onActivate(active); } catch (e) { /* ignore */ } }
      }
    });
    container.classList.toggle("is-active", activation.active);
    updateHint();

    // ── Three.js setup ───────────────────────────────────────────────
    function supportsWebGL2() {
      try {
        var c = doc.createElement("canvas");
        var gl = c.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
        if (!gl) return false;
        var ext = gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
        return true;
      } catch (e) { return false; }
    }
    function cssColor(str, raw) {
      var c = new THREE.Color();
      var space = raw ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      var rgb = resolveColor(str);
      if (rgb) c.setRGB(rgb.r / 255, rgb.g / 255, rgb.b / 255, space);   // the alpha is not used
      else if (rgb === null) c.set(0x808080);
      else { try { c.setStyle(String(str).trim(), space); } catch (e) { c.set(0x808080); } }
      return c;
    }

    function initThree() {
      if (!THREE || !THREE.WebGLRenderer) throw new Error("the Three.js bundle (window.THREE) is missing");
      if (!supportsWebGL2()) throw new Error("WebGL 2 is not available");
      renderer = new THREE.WebGLRenderer({
        canvas: canvas, alpha: true, antialias: true, premultipliedAlpha: true,
        preserveDrawingBuffer: false, powerPreference: "high-performance"
      });
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      scene3 = new THREE.Scene();
      root3 = new THREE.Group();
      scene3.add(root3);
      if (editor) overlay3 = new THREE.Scene();

      cameraP = new THREE.PerspectiveCamera(35, 1.6, 0.1, 1000);
      cameraO = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
      var up = scene.up === "y" ? [0, 1, 0] : [0, 0, 1];
      cameraP.up.set(up[0], up[1], up[2]);
      cameraO.up.set(up[0], up[1], up[2]);
      camera = cameraO;
      scene3.add(cameraP);
      scene3.add(cameraO);

      controls = new THREE.OrbitControls(camera, canvas);
      canvas.style.touchAction = "";   // the stylesheet gates it (SPEC 9.9)
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.rotateSpeed = 0.9;
      controls.zoomToCursor = true;
      controls.screenSpacePanning = true;
      controls.enableRotate = activation.active || !touchUI || editor;
      controls.addEventListener("change", function () {
        clampPan();
        updateNearFar();
        requestRender();
        if (handle.onCamera) { try { handle.onCamera(getCamera()); } catch (e) { /* ignore */ } }
      });
      controls.addEventListener("start", function () { activation.interaction(); hideHint(); });

      raycaster = new THREE.Raycaster();
      raycaster.layers.enableAll();

      // line-art targets
      var depthTex = new THREE.DepthTexture(2, 2, THREE.FloatType);
      gbuf = new THREE.WebGLRenderTarget(2, 2, {
        count: 2, type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        depthBuffer: true, stencilBuffer: false, depthTexture: depthTex
      });
      edgeTarget = new THREE.WebGLRenderTarget(2, 2, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        depthBuffer: false, stencilBuffer: false
      });
      edgeMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: EDGE_FRAG,
        uniforms: {
          tNormal: { value: gbuf.textures[1] }, tDepth: { value: depthTex },
          uTexel: { value: new THREE.Vector2(1 / 2, 1 / 2) },
          uNear: { value: 0.1 }, uFar: { value: 1000 }, uOrtho: { value: 1 },
          uDepthT: { value: 0.1 }, uAngleT: { value: 35 * Math.PI / 180 }
        },
        depthTest: false, depthWrite: false, blending: THREE.NoBlending
      });
      var kernelInit = [];
      for (var k = 0; k < MAX_KERNEL; k++) kernelInit.push(new THREE.Vector2(0, 0));
      var edgeColorsInit = [];
      for (var c = 0; c < 6; c++) edgeColorsInit.push(new THREE.Color(0, 0, 0));
      compMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: COMP_FRAG,
        uniforms: {
          tColor: { value: gbuf.textures[0] }, tDepth: { value: depthTex }, tEdge: { value: edgeTarget.texture },
          uTexel: { value: new THREE.Vector2(1 / 2, 1 / 2) },
          uKernel: { value: kernelInit }, uKernelN: { value: 1 },
          uEdgeColor: { value: edgeColorsInit }
        },
        depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth, blending: THREE.NoBlending, transparent: false
      });
      edgeQuad = new THREE.FullScreenQuad(edgeMat);
      compQuad = new THREE.FullScreenQuad(compMat);

      // shaded lights, parented to the camera so the key light follows it
      lights = { hemi: new THREE.HemisphereLight(0xffffff, 0x444444, 1.6), key: new THREE.DirectionalLight(0xffffff, 1.6), target: new THREE.Object3D() };
      lights.hemi.layers.enableAll();
      lights.key.layers.enableAll();
      lights.key.position.set(-0.6, 0.8, 1.0);
      lights.target.position.set(0, 0, -1);
      lights.key.target = lights.target;
      scene3.add(lights.hemi);
      webgl = true;
      applyTokens();
      onResize();
    }

    // ── Tokens → GPU ─────────────────────────────────────────────────
    function applyTokens() {
      tokens = readTokens(container);
      if (!webgl) return;
      var ec = compMat.uniforms.uEdgeColor.value;
      ec[EDGE_CLASS.none].copy(cssColor(tokens.partEdge, true));
      ec[EDGE_CLASS.part].copy(cssColor(tokens.partEdge, true));
      ec[EDGE_CLASS.highlight].copy(cssColor(tokens.highlightEdge, true));
      ec[EDGE_CLASS.arrow].copy(cssColor(tokens.arrowEdge, true));
      ec[EDGE_CLASS.selected].copy(cssColor(tokens.accent, true));
      ec[5].copy(cssColor(tokens.accent, true));
      compMat.uniformsNeedUpdate = true;
      Object.keys(matCache).forEach(function (key) {
        var m = matCache[key];
        if (m.isShaderMaterial) m.uniforms.uFill.value.copy(cssColor(m.userData.fill === "literal" ? m.userData.literal : tokens[m.userData.fill], true));
      });
      // A transparent view shows the page behind it: light the parts from an
      // opaque bg, else from the scheme's default view background.
      var skyBase = tokens.viewBg;
      var vb = resolveColor(skyBase);
      if (vb && vb.a === 0) {
        var pb = resolveColor(tokens.bg);
        skyBase = pb && pb.a === 1 ? tokens.bg : (tokens.dark ? DARK : LIGHT)["view-bg"];
      }
      var viewBg = cssColor(skyBase);
      if (lights) {
        lights.hemi.color.copy(viewBg).lerp(new THREE.Color(1, 1, 1), 0.6);
        lights.hemi.groundColor.copy(viewBg).multiplyScalar(0.35);
      }
      partList.forEach(refreshPartMaterials);
      arrows.forEach(function (a) { if (a.refresh) a.refresh(); });
      requestRender();
    }

    // Line-art material for a fill token (or a literal color) and an edge class.
    function lineartMaterial(fillToken, cls, side, literal) {
      var key = fillToken + "|" + cls + "|" + side + "|" + (literal || "");
      var m = matCache[key];
      if (m) return m;
      var fill = fillToken === "literal" ? cssColor(literal, true) : cssColor(tokens[fillToken], true);
      m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: GBUF_VERT, fragmentShader: GBUF_FRAG,
        uniforms: { uFill: { value: fill }, uCls: { value: cls / 255 } },
        side: side === "double" ? THREE.DoubleSide : THREE.FrontSide
      });
      m.userData = { fill: fillToken, literal: literal, cls: cls };
      matCache[key] = m;
      return m;
    }

    // ── Models → parts ───────────────────────────────────────────────
    function loadModels(models) {
      var names = Object.keys(models || {});
      var loader = new THREE.GLTFLoader();
      return Promise.all(names.map(function (name) {
        return new Promise(function (resolve, reject) {
          var buffer;
          try { buffer = toArrayBuffer(models[name]); } catch (e) { reject(e); return; }
          loader.parse(buffer, "", function (gltf) { resolve({ name: name, gltf: gltf }); }, function (err) {
            reject(new Error("could not load the model '" + name + "': " + (err && err.message ? err.message : err)));
          });
        });
      }));
    }

    function clearParts() {
      partList.forEach(function (p) {
        if (p.pivot.parent) p.pivot.parent.remove(p.pivot);
        p.meshes.forEach(function (m) { if (m.geometry) m.geometry.dispose(); });
        Object.keys(p.mats).forEach(function (k) { p.mats[k].forEach(function (m) { m.dispose(); }); });
        if (p.fadeMat) p.fadeMat.dispose();
      });
      parts = {};
      partList = [];
      groupBox = {};
      camCache = [];
      modelsLoaded = false;
    }

    function buildParts(loaded) {
      clearParts();
      var trees = [];
      var box = new THREE.Box3();
      loaded.forEach(function (item) {
        var gltf = item.gltf;
        var json = gltf.parser.json;
        var nodesDef = json.nodes || [];
        gltf.scene.updateMatrixWorld(true);
        var byIndex = {};
        gltf.scene.traverse(function (obj) {
          var a = gltf.parser.associations.get(obj);
          if (!a || a.nodes === undefined) return;
          byIndex[a.nodes] = obj;
        });
        var nodeInfo = {};
        Object.keys(byIndex).forEach(function (idx) {
          var def = nodesDef[idx] || {};
          var obj = byIndex[idx];
          var id = typeof def.name === "string" && def.name ? def.name : (obj.name || "node_" + idx);
          nodeInfo[idx] = { id: id, label: (def.extras && def.extras.label) || id, children: (def.children || []).slice(), mesh: def.mesh != null ? def.mesh : -1, obj: obj };
        });
        function toTree(idx) {
          var info = nodeInfo[idx];
          if (!info) return null;
          var node = { id: info.id, label: info.label, has_mesh: info.mesh >= 0, children: [] };
          info.children.forEach(function (ci) { var c = toTree(ci); if (c) node.children.push(c); });
          return node;
        }
        var sceneDef = (json.scenes && json.scenes[json.scene || 0]) || { nodes: Object.keys(nodeInfo) };
        var rootNodes = (sceneDef.nodes || []).map(toTree).filter(Boolean);
        trees.push(rootNodes);
        Object.keys(nodeInfo).forEach(function (idx) {
          var info = nodeInfo[idx];
          if (info.mesh < 0) return;
          var obj = info.obj;
          var meshes = [];
          if (obj.isMesh) meshes.push(obj);
          else obj.traverse(function (o) { if (o.isMesh) meshes.push(o); });
          if (!meshes.length) return;
          var matrix = obj.matrixWorld.clone();
          var pbox = new THREE.Box3();
          meshes.forEach(function (m) {
            if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
            m.geometry.computeBoundingBox();
            var b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
            pbox.union(b);
          });
          if (obj.parent) obj.parent.remove(obj);
          obj.matrixAutoUpdate = false;
          obj.matrix.copy(matrix);
          obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
          obj.updateMatrix();
          obj.updateMatrixWorld(true);
          var pivot = new THREE.Group();
          pivot.name = "pivot:" + info.id;
          pivot.add(obj);
          root3.add(pivot);
          var center = pbox.getCenter(new THREE.Vector3());
          var meta = scene.parts && scene.parts[info.id];
          var colors = meshes.map(function (m) {
            var c = new THREE.Color(0.8, 0.8, 0.8);
            if (meta && meta.color) c = cssColor(meta.color);
            else if (m.material && m.material.color) c.copy(m.material.color);
            return c;
          });
          var doubleSided = meshes.some(function (m) { return m.material && m.material.side === THREE.DoubleSide; });
          var part = {
            id: info.id, label: info.label, obj: obj, pivot: pivot, meshes: meshes, colors: colors,
            box: pbox, center: center, radius: pbox.getSize(new THREE.Vector3()).length() / 2,
            doubleSided: doubleSided, mats: {},
            cls: "normal", alpha: 1, visible: true, selected: false,
            offset: new THREE.Vector3(), quat: new THREE.Quaternion(), pivotCenter: center.clone(),
            fadeMat: null
          };
          meshes.forEach(function (m) { m.userData.tdsPart = part; m.frustumCulled = true; });
          parts[info.id] = part;
          partList.push(part);
          box.union(pbox);
        });
      });
      registry = normalizeTree(trees);
      registry.order.forEach(function (id) {
        if (registry.groups[id]) {
          var gb = new THREE.Box3();
          registry.members[id].forEach(function (pid) { if (parts[pid]) gb.union(parts[pid].box); });
          groupBox[id] = gb;
        }
      });
      modelBox = box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)) : box;
      var size = modelBox.getSize(new THREE.Vector3());
      modelRadius = Math.max(size.length() / 2, 1e-3);
      var c = modelBox.getCenter(new THREE.Vector3());
      modelCenter = [c.x, c.y, c.z];
      partList.forEach(function (p) { p.pivot.layers.set(0); });
      modelsLoaded = true;
      camCache = [];
    }

    function partSides(part) { return part.doubleSided ? "double" : "front"; }

    // Materials for the part's current class and alpha, in the current style.
    function refreshPartMaterials(part) {
      if (!webgl) return;
      var translucent = part.alpha < 1 || part.cls === "ghost";
      var layer = translucent ? 1 : 0;
      part.meshes.forEach(function (m) { m.layers.set(layer); });
      part.pivot.visible = part.alpha > 0 && part.visible;
      if (style === "lineart") {
        if (!translucent) {
          var cls = part.selected ? EDGE_CLASS.selected : (part.cls === "highlight" ? EDGE_CLASS.highlight : EDGE_CLASS.part);
          var fillToken = part.cls === "highlight" ? "highlightFill" : "partFill";
          var mat = lineartMaterial(fillToken, cls, partSides(part));
          part.meshes.forEach(function (m) { m.material = mat; });
        } else {
          var fill = cssColor(part.cls === "highlight" ? tokens.highlightFill : tokens.partFill);
          // A ghost has no edges, and the part fill is the view's own color
          // in most themes (white on white): halfway to the edge color, it
          // shows as a translucent silhouette.
          if (part.cls === "ghost") fill.lerp(cssColor(tokens.partEdge), 0.5);
          if (!part.fadeMat) part.fadeMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
          part.fadeMat.color.copy(fill);
          part.fadeMat.opacity = part.alpha * (part.cls === "ghost" ? tokens.ghostOpacity : 1);
          part.fadeMat.side = part.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
          part.fadeMat.needsUpdate = true;
          part.meshes.forEach(function (m) { m.material = part.fadeMat; });
        }
      } else {
        if (!part.mats.shaded) {
          part.mats.shaded = part.meshes.map(function (m, i) {
            return new THREE.MeshStandardMaterial({ color: part.colors[i].clone(), metalness: 0, roughness: 0.8, side: part.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
          });
        }
        var hi = cssColor(tokens.highlightFill);
        var accent = cssColor(tokens.accent);
        part.mats.shaded.forEach(function (m, i) {
          m.color.copy(part.colors[i]);
          if (part.cls === "highlight") m.color.lerp(hi, 0.6);
          if (part.selected) m.emissive.copy(accent).multiplyScalar(0.35); else m.emissive.set(0, 0, 0);
          m.transparent = translucent;
          m.opacity = translucent ? part.alpha * (part.cls === "ghost" ? tokens.ghostOpacity : 1) : 1;
          m.depthWrite = !translucent;
          m.needsUpdate = true;
        });
        part.meshes.forEach(function (m, i) { m.material = part.mats.shaded[i]; });
      }
    }

    function applyPlacement(part) {
      var c = part.pivotCenter;
      var rc = c.clone().applyQuaternion(part.quat);
      part.pivot.quaternion.copy(part.quat);
      part.pivot.position.set(part.offset.x + c.x - rc.x, part.offset.y + c.y - rc.y, part.offset.z + c.z - rc.z);
      part.pivot.updateMatrixWorld(true);
    }
    function displayedCenter(part) {
      return part.center.clone().applyMatrix4(part.pivot.matrixWorld);
    }
    function quatFromRotate(rot) {
      var e = new THREE.Euler(rot[0] * Math.PI / 180, rot[1] * Math.PI / 180, rot[2] * Math.PI / 180, "XYZ");
      return new THREE.Quaternion().setFromEuler(e);
    }
    function pivotCenterFor(part, placedEntry) {
      if (placedEntry && placedEntry.pivot && groupBox[placedEntry.pivot]) return groupBox[placedEntry.pivot].getCenter(new THREE.Vector3());
      return part.center.clone();
    }

    // ── Cameras ──────────────────────────────────────────────────────
    function aspect() {
      // Before the first layout (a hidden tab, a display:none ancestor) the view
      // has no size; the theme's aspect stands in so a fit camera is never
      // computed for a degenerate viewport.
      var w = view.clientWidth, h = view.clientHeight;
      if (!(w >= 2) || !(h >= 2)) return clamp(num(behavior.viewportAspect, 1.6), 0.2, 5) || 1.6;
      return w / h;
    }
    function defaultDir() { return scene.up === "y" ? DEFAULT_DIR_Y.slice() : DEFAULT_DIR_Z.slice(); }
    // The box of some ids (every part when `ids` is empty) in their displayed
    // poses for a step: a part the step moves counts where it is shown, so a
    // fit over an exploded step frames the explosion.
    function boxOf(ids, placed) {
      var b = new THREE.Box3();
      var list = ids && ids.length ? ids : partList.map(function (p) { return p.id; });
      list.forEach(function (id) {
        var members = registry && registry.members[id] ? registry.members[id] : [id];
        members.forEach(function (pid) {
          var part = parts[pid];
          if (!part) return;
          var p = placed && placed[pid];
          if (p && (p.offset[0] || p.offset[1] || p.offset[2] || p.rotate[0] || p.rotate[1] || p.rotate[2])) {
            var q = quatFromRotate(p.rotate), c = pivotCenterFor(part, p);
            var rc = c.clone().applyQuaternion(q);
            var m = new THREE.Matrix4().compose(new THREE.Vector3(p.offset[0] + c.x - rc.x, p.offset[1] + c.y - rc.y, p.offset[2] + c.z - rc.z), q, new THREE.Vector3(1, 1, 1));
            b.union(part.box.clone().applyMatrix4(m));
          } else {
            b.union(part.box);
          }
        });
      });
      if (b.isEmpty()) b.copy(modelBox);
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    }
    // The concrete camera of a step: explicit, or fit/auto resolved from the
    // previous step's direction (cached per step index). Step 1 inherits the
    // home view ([camera]), so a fit there looks from the home view's side.
    function resolveCamera(i) {
      if (camCache[i]) return camCache[i];
      var prevDir = defaultDir();
      var home = scene.camera;
      if (home && isVec3(home.position) && isVec3(home.target)) {
        var homeDir = vsub(vec3(home.position), vec3(home.target));
        if (vlen(homeDir) > 0) prevDir = vnorm(homeDir);
      }
      for (var k = 0; k <= i; k++) {
        var spec = states[k] ? states[k].camera : null;
        var cam;
        var placed = states[k] ? states[k].placed : null;
        if (camCache[k]) { cam = camCache[k]; }
        else if (!spec || spec.kind === "auto") {
          cam = fitCamera(boxOf(null, placed), prevDir, spec ? spec.fov : 35, spec ? spec.projection : "orthographic", aspect());
        } else if (spec.kind === "fit") {
          cam = fitCamera(boxOf(spec.fit, placed), prevDir, spec.fov, spec.projection, aspect());
        } else {
          cam = { position: spec.position.slice(), target: spec.target.slice(), fov: spec.fov, projection: spec.projection };
        }
        camCache[k] = cam;
        var d = vsub(cam.position, cam.target);
        if (vlen(d) > 0) prevDir = vnorm(d);
      }
      return camCache[i];
    }
    function homeCamera() {
      if (states.length && current >= 0) return resolveCamera(current);
      var home = scene.camera;
      if (home && isVec3(home.position) && isVec3(home.target)) {
        return { position: vec3(home.position), target: vec3(home.target), fov: num(home.fov, 35), projection: home.projection === "perspective" ? "perspective" : "orthographic" };
      }
      return fitCamera(boxOf(null, null), defaultDir(), 35, "orthographic", aspect());
    }

    // Apply a camera spec {position, target, fov, projection} instantly.
    function setCameraNow(cam) {
      var projection = cam.projection === "perspective" ? "perspective" : "orthographic";
      var fov = clamp(num(cam.fov, 35), 1, 179);
      var pos = new THREE.Vector3().fromArray(cam.position);
      var tgt = new THREE.Vector3().fromArray(cam.target);
      var dist = Math.max(pos.distanceTo(tgt), 1e-4);
      var cam3 = projection === "perspective" ? cameraP : cameraO;
      cam3.position.copy(pos);
      if (projection === "perspective") {
        cameraP.fov = fov;
        cameraP.aspect = aspect();
      } else {
        var h = orthoHalfHeight(dist, fov), a = aspect();
        cameraO.left = -h * a; cameraO.right = h * a; cameraO.top = h; cameraO.bottom = -h;
        cameraO.zoom = 1;
        cameraO.userData.fov = fov;
        cameraO.userData.half = h;
      }
      if (camera !== cam3) switchCamera(cam3);
      camera.lookAt(tgt);
      controls.target.copy(tgt);
      updateLimits();
      updateNearFar();
      camera.updateProjectionMatrix();
      controls.update();
      requestRender();
    }
    function switchCamera(cam3) {
      camera = cam3;
      controls.object = cam3;
      // The HUD button follows the live camera, whatever switched it (a step, Home, setProjection).
      if (btnProj) btnProj.classList.toggle("is-on", cam3 === cameraP);
      if (lights) {
        if (lights.key.parent) lights.key.parent.remove(lights.key);
        if (lights.target.parent) lights.target.parent.remove(lights.target);
        cam3.add(lights.key);
        cam3.add(lights.target);
      }
    }
    function updateLimits() {
      var R = modelRadius;
      var fov = camera === cameraP ? cameraP.fov : (cameraO.userData.fov || 35);
      var tanh = Math.tan(fov * Math.PI / 360);
      if (camera === cameraP) {
        controls.minDistance = 0.005 * R / tanh;
        controls.maxDistance = 10 * R / tanh;
        controls.minZoom = 0; controls.maxZoom = Infinity;
      } else {
        var h0 = cameraO.userData.half || 1;
        controls.minZoom = h0 / (10 * R);
        controls.maxZoom = h0 / (0.005 * R);
        controls.minDistance = 0; controls.maxDistance = Infinity;
      }
    }
    function updateNearFar() {
      var R = modelRadius;
      var d = camera.position.distanceTo(controls.target);
      if (camera === cameraP) {
        cameraP.near = Math.max(d / 500, R * 1e-4);
        cameraP.far = d + 6 * R;
      } else {
        cameraO.near = -(d + 4 * R);
        cameraO.far = d + 4 * R;
      }
      camera.updateProjectionMatrix();
    }
    function clampPan() {
      var c = new THREE.Vector3().fromArray(modelCenter);
      var t = controls.target;
      var d = t.clone().sub(c);
      var max = modelRadius * 2;
      if (d.length() > max) {
        d.setLength(max);
        var nt = c.clone().add(d);
        camera.position.add(nt.clone().sub(t));
        t.copy(nt);
      }
    }
    function getCamera() {
      var tgt = controls.target.clone();
      var dir = camera.position.clone().sub(tgt);
      var dist = dir.length();
      if (!(dist > 0)) { dir.set(0, 0, 1); dist = 1; }
      dir.divideScalar(dist);
      var fov, projection;
      if (camera === cameraP) {
        fov = cameraP.fov; projection = "perspective";
      } else {
        fov = cameraO.userData.fov || 35; projection = "orthographic";
        var half = (cameraO.userData.half || orthoHalfHeight(dist, fov)) / (cameraO.zoom || 1);
        dist = half / Math.tan(fov * Math.PI / 360);
      }
      var pos = tgt.clone().add(dir.multiplyScalar(dist));
      return { position: [pos.x, pos.y, pos.z], target: [tgt.x, tgt.y, tgt.z], fov: fov, projection: projection };
    }

    // Fly from the current camera to `cam` over `ms` (0 snaps).
    // The flight's projection is `flightProjection`, so setProjection() can retarget a running flight.
    var camTween = null, flightProjection = "orthographic";
    function flyTo(cam, ms, done) {
      if (camTween) { removeTween(camTween); camTween = null; controls.enabled = true; }
      var projection = cam.projection === "perspective" ? "perspective" : "orthographic";
      var from = getCamera();
      var switching = (projection === "perspective") !== (camera === cameraP);
      if (!(ms > 0) || reducedMotion() || switching) {
        setCameraNow(cam);
        setFlying(false);
        if (done) done();
        return;
      }
      var fromFov = from.fov, toFov = clamp(num(cam.fov, fromFov), 1, 179);
      setFlying(true);
      controls.enabled = false;
      flightProjection = projection;
      camTween = addTween(ms, function (k) {
        var e = easeInOut(k);
        setCameraNow({
          position: [lerp(from.position[0], cam.position[0], e), lerp(from.position[1], cam.position[1], e), lerp(from.position[2], cam.position[2], e)],
          target: [lerp(from.target[0], cam.target[0], e), lerp(from.target[1], cam.target[1], e), lerp(from.target[2], cam.target[2], e)],
          fov: lerp(fromFov, toFov, e), projection: flightProjection
        });
      }, function () {
        camTween = null;
        controls.enabled = true;
        controls.update();
        setFlying(false);
        if (done) done();
      });
    }
    function setFlying(v) {
      if (flying === v) return;
      flying = v;
      container.classList.toggle("is-flying", v);
    }

    // ── Tweens ───────────────────────────────────────────────────────
    function addTween(ms, update, done) {
      var t = { start: 0, ms: ms, update: update, done: done, alive: true };
      tweens.push(t);
      requestRender();
      return t;
    }
    function removeTween(t) {
      t.alive = false;
      var i = tweens.indexOf(t);
      if (i >= 0) tweens.splice(i, 1);
    }
    function runTweens(now) {
      var any = false;
      var list = tweens.slice();
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t.alive) continue;
        if (!t.start) t.start = now;
        var k = t.ms > 0 ? clamp((now - t.start) / t.ms, 0, 1) : 1;
        try { t.update(k); } catch (e) { removeTween(t); fail(e); continue; }
        if (k >= 1) {
          removeTween(t);
          if (t.done) t.done();
        } else {
          any = true;
        }
      }
      return any;
    }

    // ── State application ────────────────────────────────────────────
    var stateTween = null;
    var playTween = null;
    function targetFor(part, st) {
      var p = st.placed[part.id];
      var visible = !!st.visible[part.id];
      var cls = st.ghost[part.id] ? "ghost" : (st.highlight[part.id] ? "highlight" : "normal");
      var pivotCenter = pivotCenterFor(part, p);
      return {
        offset: p ? new THREE.Vector3().fromArray(p.offset) : new THREE.Vector3(),
        quat: p ? quatFromRotate(p.rotate) : new THREE.Quaternion(),
        pivotCenter: pivotCenter,
        alpha: visible ? 1 : 0,
        visible: visible,
        cls: cls,
        arrow: !!(p && p.arrow)
      };
    }
    function snapPart(part, tgt) {
      part.offset.copy(tgt.offset);
      part.quat.copy(tgt.quat);
      part.pivotCenter.copy(tgt.pivotCenter);
      part.alpha = tgt.alpha;
      part.visible = tgt.visible;
      part.cls = tgt.cls;
      applyPlacement(part);
      refreshPartMaterials(part);
    }
    function applyState(i, animate, done) {
      var st = states[i];
      if (!st || !modelsLoaded) { if (done) done(); return; }
      if (stateTween) { removeTween(stateTween); stateTween = null; }
      // a Play / Reset still running would finish after this transition and
      // copy its own target over the new pose; the transition starts from
      // the pose it reached instead
      if (playTween) { removeTween(playTween); playTween = null; }
      var ms = animate && !reducedMotion() ? behavior.transitionMs : 0;
      var cam = resolveCamera(i);
      var moving = [];
      partList.forEach(function (part) {
        var tgt = targetFor(part, st);
        if (ms <= 0) { snapPart(part, tgt); return; }
        var from = { offset: part.offset.clone(), quat: part.quat.clone(), pivotCenter: part.pivotCenter.clone(), alpha: part.visible ? part.alpha : 0, cls: part.cls };
        // a part that becomes visible fades in from its target pose
        if (!part.visible || part.alpha <= 0) { from.offset.copy(tgt.offset); from.quat.copy(tgt.quat); from.pivotCenter.copy(tgt.pivotCenter); }
        var changed = from.alpha !== tgt.alpha || !from.offset.equals(tgt.offset) || !from.quat.equals(tgt.quat) || from.cls !== tgt.cls || !from.pivotCenter.equals(tgt.pivotCenter);
        if (!changed) { snapPart(part, tgt); return; }
        moving.push({ part: part, from: from, to: tgt });
        part.visible = part.visible || tgt.visible;
        part.cls = tgt.alpha > 0 ? tgt.cls : from.cls;
      });
      buildArrows(st);
      buildLabels(st);
      var finish = function () {
        moving.forEach(function (m) { snapPart(m.part, m.to); });
        updateAutoArrows();
        stateTween = null;
        if (done) done();
        requestRender();
      };
      if (ms <= 0 || !moving.length) {
        flyTo(cam, ms / (moving.length ? 1 : 1), null);
        finish();
        return;
      }
      flyTo(cam, ms, null);
      stateTween = addTween(ms, function (k) {
        var e = easeInOut(k);
        moving.forEach(function (m) {
          var part = m.part;
          part.offset.lerpVectors(m.from.offset, m.to.offset, e);
          part.quat.slerpQuaternions(m.from.quat, m.to.quat, e);
          part.pivotCenter.lerpVectors(m.from.pivotCenter, m.to.pivotCenter, e);
          part.alpha = lerp(m.from.alpha, m.to.alpha, e);
          part.visible = part.alpha > 0.001;
          applyPlacement(part);
          refreshPartMaterials(part);
        });
        updateAutoArrows();
      }, finish);
    }

    // Play / Reset (SPEC 6): the parts moved in this step tween between their
    // offsets and the assembled pose.
    function playMoves(toAssembled, animate) {
      var st = states[current];
      if (!st) return;
      if (playTween) { removeTween(playTween); playTween = null; }
      var ms = animate && !reducedMotion() ? behavior.playMs : 0;
      var moving = [];
      partList.forEach(function (part) {
        var p = st.placed[part.id];
        if (!p || !st.visible[part.id]) return;
        var tgt = toAssembled
          ? { offset: new THREE.Vector3(), quat: new THREE.Quaternion() }
          : { offset: new THREE.Vector3().fromArray(p.offset), quat: quatFromRotate(p.rotate) };
        moving.push({ part: part, from: { offset: part.offset.clone(), quat: part.quat.clone() }, to: tgt });
      });
      played = toAssembled;
      container.classList.toggle("is-played", played);
      btnPlay.setAttribute("aria-label", played ? STR.reset : STR.play);
      btnPlay.title = played ? STR.reset : STR.play;
      var finish = function () {
        moving.forEach(function (m) { m.part.offset.copy(m.to.offset); m.part.quat.copy(m.to.quat); applyPlacement(m.part); });
        updateAutoArrows();
        playTween = null;
        requestRender();
      };
      if (ms <= 0) { finish(); return; }
      playTween = addTween(ms, function (k) {
        var e = easeInOut(k);
        moving.forEach(function (m) {
          m.part.offset.lerpVectors(m.from.offset, m.to.offset, e);
          m.part.quat.slerpQuaternions(m.from.quat, m.to.quat, e);
          applyPlacement(m.part);
        });
        updateAutoArrows();
      }, finish);
    }

    // ── Arrows (SPEC 9.7) ────────────────────────────────────────────
    var unitShaft = null, unitCone = null;
    function arrowGeometries() {
      if (!unitShaft) {
        unitShaft = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false);
        unitCone = new THREE.ConeGeometry(1, 1, 18, 1, false);
      }
    }
    function sizes() { return arrowSizes(modelRadius * 2, behavior.arrowScale); }
    // `selected` (editor): the arrow is the designer's selection, drawn with
    // the accent edge class (line art) or in the accent color (shaded).
    function arrowMaterial(color, selected) {
      var cls = selected ? EDGE_CLASS.selected : EDGE_CLASS.arrow;
      if (style === "lineart") return color ? lineartMaterial("literal", cls, "front", color) : lineartMaterial("arrow", cls, "front");
      var key = "shaded-arrow|" + (color || "") + (selected ? "|sel" : "");
      var m = matCache[key];
      if (!m) {
        m = new THREE.MeshBasicMaterial({ color: cssColor(selected ? tokens.accent : (color || tokens.arrow)) });
        m.userData = { fill: selected ? "accent" : (color ? "literal" : "arrow"), literal: color, shaded: true };
        matCache[key] = m;
      } else if (!color || selected) {
        m.color.copy(cssColor(selected ? tokens.accent : tokens.arrow));
      }
      return m;
    }
    var YAXIS = null;
    function orientY(obj, dir) {
      if (!YAXIS) YAXIS = new THREE.Vector3(0, 1, 0);
      obj.quaternion.setFromUnitVectors(YAXIS, dir);
    }
    // A straight arrow: a shaft (unit cylinder scaled) and a cone head, laid
    // from `from` to `to` in the parent's frame.
    function makeStraightArrow(color, selected) {
      arrowGeometries();
      var s = sizes();
      var g = new THREE.Group();
      var shaft = new THREE.Mesh(unitShaft, arrowMaterial(color, selected));
      var head = new THREE.Mesh(unitCone, arrowMaterial(color, selected));
      g.add(shaft); g.add(head);
      var rec = { group: g, shaft: shaft, head: head, color: color, kind: "straight", selected: !!selected };
      rec.set = function (from, to) {
        var f = new THREE.Vector3().fromArray(from), t = new THREE.Vector3().fromArray(to);
        var d = t.clone().sub(f), len = d.length();
        if (len < s.headLength) { g.visible = false; return false; }
        g.visible = true;
        d.divideScalar(len);
        var shaftLen = len - s.headLength;
        shaft.scale.set(s.shaftRadius, shaftLen, s.shaftRadius);
        shaft.position.copy(f).addScaledVector(d, shaftLen / 2);
        orientY(shaft, d);
        head.scale.set(s.headRadius, s.headLength, s.headRadius);
        head.position.copy(f).addScaledVector(d, shaftLen + s.headLength / 2);
        orientY(head, d);
        return true;
      };
      rec.refresh = function () { var m = arrowMaterial(color, rec.selected); shaft.material = m; head.material = m; };
      rec.dispose = function () { if (g.parent) g.parent.remove(g); };
      return rec;
    }
    // A rotate arrow: an arc (tube) of `turns` around the axis from -> to,
    // centered at `from`, with a cone head at its end.
    function makeRotateArrow(a, selected) {
      arrowGeometries();
      var s = sizes();
      var axis = new THREE.Vector3().fromArray(vsub(a.to, a.from));
      if (axis.length() < 1e-6) axis.set(0, 0, 1);
      axis.normalize();
      var helper = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      var u = new THREE.Vector3().crossVectors(helper, axis).normalize();
      var v = new THREE.Vector3().crossVectors(axis, u).normalize();
      var center = new THREE.Vector3().fromArray(a.from);
      var turns = a.turns === 0 ? 0.75 : a.turns;
      var sweep = 2 * Math.PI * Math.abs(turns) * (turns < 0 ? -1 : 1);
      var radius = Math.max(a.radius, 1e-3);
      var g = new THREE.Group();
      class Arc extends THREE.Curve {
        getPoint(t, target) {
          var th = sweep * t;
          var p = target || new THREE.Vector3();
          return p.copy(center).addScaledVector(u, radius * Math.cos(th)).addScaledVector(v, radius * Math.sin(th));
        }
      }
      var curve = new Arc();
      var segs = Math.max(12, Math.round(48 * Math.abs(turns)));
      var tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, s.shaftRadius, 10, false), arrowMaterial(a.color, selected));
      var head = new THREE.Mesh(unitCone, arrowMaterial(a.color, selected));
      var end = curve.getPoint(1), tangent = curve.getPoint(1).sub(curve.getPoint(0.995)).normalize();
      if (turns < 0) tangent.negate().negate();
      head.scale.set(s.headRadius, s.headLength, s.headRadius);
      head.position.copy(end).addScaledVector(tangent, s.headLength / 2);
      orientY(head, tangent);
      g.add(tube); g.add(head);
      var rec = { group: g, kind: "rotate", color: a.color, selected: !!selected };
      rec.refresh = function () { var m = arrowMaterial(a.color, rec.selected); tube.material = m; head.material = m; };
      rec.dispose = function () { if (g.parent) g.parent.remove(g); tube.geometry.dispose(); };
      return rec;
    }
    // The pivot an annotation attached to `id` follows: the part's own, or for a
    // group the first member visible in the step (`vis`), else its first member.
    function attachParent(id, vis) {
      if (id && parts[id]) return parts[id].pivot;
      if (id && groupBox[id]) {
        var members = registry.members[id].filter(function (m) { return parts[m]; });
        for (var i = 0; i < members.length; i++) if (vis && vis[members[i]]) return parts[members[i]].pivot;
        if (members.length) return parts[members[0]].pivot;
      }
      return root3;
    }
    function clearArrows() {
      arrows.forEach(function (a) { a.dispose(); });
      arrows = [];
    }
    function buildArrows(st) {
      if (!webgl) return;
      clearArrows();
      st.arrows.forEach(function (a, i) {
        var selected = editor && i === selArrow;
        var rec = a.kind === "rotate" ? makeRotateArrow(a, selected) : makeStraightArrow(a.color, selected);
        if (rec.kind === "straight") rec.set(a.from, a.to);
        rec.group.traverse(function (o) { o.layers.set(0); });
        attachParent(a.attach, st.visible).add(rec.group);
        rec.spec = a;
        rec.index = i;   // its index in the step's explicit arrows (editor picking)
        arrows.push(rec);
      });
      // auto arrows: one per moved part, from the displayed to the assembled center
      partList.forEach(function (part) {
        var p = st.placed[part.id];
        if (!p || !p.arrow || !st.visible[part.id]) return;
        var rec = makeStraightArrow("");
        rec.group.traverse(function (o) { o.layers.set(0); });
        rec.auto = part;
        root3.add(rec.group);
        arrows.push(rec);
      });
      updateAutoArrows();
    }
    function updateAutoArrows() {
      var s = sizes();
      arrows.forEach(function (rec) {
        if (!rec.auto) return;
        var part = rec.auto;
        if (!part.visible || part.alpha <= 0) { rec.group.visible = false; return; }
        var disp = displayedCenter(part);
        var span = autoArrowSpan([disp.x, disp.y, disp.z], [part.center.x, part.center.y, part.center.z], part.radius, s.headLength);
        if (!span) { rec.group.visible = false; return; }
        rec.set(span.from, span.to);
      });
    }

    // ── Labels (SPEC 9.7) ────────────────────────────────────────────
    var svgNS = "http://www.w3.org/2000/svg";
    function clearLabels() {
      labels.forEach(function (l) {
        if (l.div.parentNode) l.div.parentNode.removeChild(l.div);
        if (l.line.parentNode) l.line.parentNode.removeChild(l.line);
        if (l.dot.parentNode) l.dot.parentNode.removeChild(l.dot);
      });
      labels = [];
    }
    function buildLabels(st) {
      clearLabels();
      var specs = st.labels.map(function (l, i) { return Object.assign({}, l, { index: i }); });
      st.arrows.forEach(function (a, i) {
        if (a.label) specs.push({ text: a.label, at: a.from.slice(), side: "auto", attach: a.attach, tail: true, index: i });
      });
      specs.forEach(function (spec) {
        if (!spec.text) return;
        var div = el("div", "tds-label");
        div.textContent = spec.text;
        if (editor) {
          // The designer selects labels (and arrows by their tail label) by clicking them.
          div.setAttribute(spec.tail ? "data-tds-arrow" : "data-tds-label", String(spec.index));
          div.classList.toggle("is-selected", spec.tail ? spec.index === selArrow : spec.index === selLabel);
        }
        var line = doc.createElementNS(svgNS, "line");
        var dot = doc.createElementNS(svgNS, "circle");
        dot.setAttribute("r", "3");
        if (spec.tail) { line.classList.add("is-off"); dot.classList.add("is-off"); }
        labelsBox.appendChild(div);
        overlay.appendChild(line);
        overlay.appendChild(dot);
        labels.push({ spec: spec, div: div, line: line, dot: dot, parent: webgl ? attachParent(spec.attach, st.visible) : null });
      });
      updateLabels();
    }
    function updateLabels() {
      if (!labels.length || !webgl) return;
      var w = view.clientWidth, h = view.clientHeight;
      var hudH = behavior.controls === "none" ? 0 : 48;
      // Keep the bottom strip of the hint pill (and the credit it shrinks to) clear,
      // as the HUD's strip is at the top; the pill is not displayed in the designer
      // or with controls = "none", and then only the 4 px margin is kept.
      var footH = hint.offsetHeight ? h - hint.offsetTop + 4 : 4;
      var cx = w / 2, cy = h / 2;
      labels.forEach(function (l) {
        // A label attached to a hidden part goes with it, as an arrow attached to it does.
        if (l.parent && l.parent !== root3 && !l.parent.visible) { l.div.classList.add("is-off"); l.line.classList.add("is-off"); l.dot.classList.add("is-off"); return; }
        var p = new THREE.Vector3().fromArray(l.spec.at);
        if (l.parent) p.applyMatrix4(l.parent.matrixWorld);
        var ndc = p.project(camera);
        if (ndc.z > 1 || ndc.z < -1 || isNaN(ndc.x)) { l.div.classList.add("is-off"); l.line.classList.add("is-off"); l.dot.classList.add("is-off"); return; }
        var ax = (ndc.x + 1) / 2 * w, ay = (1 - ndc.y) / 2 * h;
        var dx, dy;
        switch (l.spec.side) {
          case "left": dx = -1; dy = 0; break;
          case "right": dx = 1; dy = 0; break;
          case "top": dx = 0; dy = -1; break;
          case "bottom": dx = 0; dy = 1; break;
          default:
            dx = ax - cx; dy = ay - cy;
            var len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
        }
        var bw = l.div.offsetWidth || 80, bh = l.div.offsetHeight || 24;
        var ox = ax + dx * 48, oy = ay + dy * 48;
        var left, top;
        if (Math.abs(dx) >= Math.abs(dy)) { left = dx > 0 ? ox : ox - bw; top = oy - bh / 2; }
        else { top = dy > 0 ? oy : oy - bh; left = ox - bw / 2; }
        left = clamp(left, 4, Math.max(4, w - bw - 4));
        top = clamp(top, hudH, Math.max(hudH, h - bh - footH));
        l.div.classList.remove("is-off");
        l.div.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)";
        if (l.spec.tail) return;
        // leader from the nearest box edge midpoint to the anchor
        var ex, ey;
        var bcx = left + bw / 2, bcy = top + bh / 2;
        if (Math.abs(ax - bcx) > bw / 2 && Math.abs(ax - bcx) / bw > Math.abs(ay - bcy) / bh) { ex = ax < bcx ? left : left + bw; ey = bcy; }
        else { ex = bcx; ey = ay < bcy ? top : top + bh; }
        l.line.classList.remove("is-off");
        l.dot.classList.remove("is-off");
        l.line.setAttribute("x1", ex.toFixed(1)); l.line.setAttribute("y1", ey.toFixed(1));
        l.line.setAttribute("x2", ax.toFixed(1)); l.line.setAttribute("y2", ay.toFixed(1));
        l.dot.setAttribute("cx", ax.toFixed(1)); l.dot.setAttribute("cy", ay.toFixed(1));
      });
    }

    // ── Rendering ────────────────────────────────────────────────────
    function requestRender() {
      needsRender = true;
      schedule();
    }
    function schedule() {
      if (rafId || disposed || !visible || (doc.visibilityState && doc.visibilityState === "hidden")) return;
      rafId = win.requestAnimationFrame(frame);
    }
    function frame(now) {
      rafId = 0;
      if (disposed) return;
      var again = false;
      try {
        again = runTweens(now);
        var moved = controls && controls.enabled && !camTween ? controls.update((now - lastFrame) / 1000) : false;
        lastFrame = now;
        if (needsRender || again || moved) {
          needsRender = false;
          if (webgl) render();
          updateLabels();
        }
      } catch (e) {
        fail(e);
        return;
      }
      if (again || tweens.length) schedule();
    }
    function render() {
      if (!webgl || !renderer) return;
      var w = canvas.width, h = canvas.height;
      if (w < 2 || h < 2) return;
      renderer.setRenderTarget(null);
      renderer.clear(true, true, true);
      if (style === "lineart") {
        renderer.setRenderTarget(gbuf);
        renderer.clear(true, true, false);
        camera.layers.set(0);
        renderer.render(scene3, camera);
        var eu = edgeMat.uniforms;
        eu.uNear.value = camera.near; eu.uFar.value = camera.far;
        eu.uOrtho.value = camera === cameraO ? 1 : 0;
        eu.uDepthT.value = Math.max(modelRadius * 2 * 0.0015, 1e-4);
        eu.uAngleT.value = clamp(behavior.edgeAngle, 1, 179) * Math.PI / 180;
        renderer.setRenderTarget(edgeTarget);
        renderer.clear(true, false, false);
        edgeQuad.render(renderer);
        renderer.setRenderTarget(null);
        compQuad.render(renderer);
        camera.layers.set(1);
        renderer.render(scene3, camera);
        camera.layers.set(0);
      } else {
        camera.layers.enableAll();
        renderer.render(scene3, camera);
        camera.layers.set(0);
      }
      // Editor overlay (gizmos, tool previews): over everything, with the
      // frame's depth still in place for whatever tests against it.
      if (overlay3 && overlay3.children.length) {
        camera.layers.enableAll();
        renderer.render(overlay3, camera);
        camera.layers.set(0);
      }
      handle.stats.frames++;
    }
    function onResize() {
      if (!webgl) { updateLabels(); return; }
      var w = Math.max(1, view.clientWidth), h = Math.max(1, view.clientHeight);
      dpr = Math.min(win.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      var pw = Math.max(2, Math.round(w * dpr)), ph = Math.max(2, Math.round(h * dpr));
      gbuf.setSize(pw, ph);
      edgeTarget.setSize(pw, ph);
      edgeMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      compMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      var kernel = edgeKernel(behavior.edgeWidth * dpr);
      var ku = compMat.uniforms.uKernel.value;
      for (var i = 0; i < MAX_KERNEL; i++) { if (i < kernel.length) ku[i].set(kernel[i][0], kernel[i][1]); else ku[i].set(0, 0); }
      compMat.uniforms.uKernelN.value = kernel.length;
      var a = w / h;
      cameraP.aspect = a;
      cameraP.updateProjectionMatrix();
      var half = cameraO.userData.half || 1;
      cameraO.left = -half * a; cameraO.right = half * a; cameraO.top = half; cameraO.bottom = -half;
      cameraO.updateProjectionMatrix();
      camCache = [];
      requestRender();
    }

    // ── Step navigation ──────────────────────────────────────────────
    function stepIndex(ref) {
      if (typeof ref === "number") return clamp(Math.round(ref), 0, states.length - 1);
      if (typeof ref === "string") {
        if (/^\d+$/.test(ref)) return clamp(parseInt(ref, 10) - 1, 0, states.length - 1);
        for (var i = 0; i < states.length; i++) if (states[i].id === ref) return i;
      }
      return -1;
    }
    function goToStep(ref, opts) {
      opts = opts || {};
      var i = stepIndex(ref);
      if (i < 0 || !states.length) return;
      if (i === current) return;
      if (!modelsLoaded && webgl) { pendingStep = { ref: ref, opts: opts }; }
      var animate = opts.animate !== false && current >= 0 && !editor;
      var changed = i !== current;
      current = i;
      played = false;
      container.classList.remove("is-played");
      animatePanel(function () { renderPanelStep(i); });
      if (modelsLoaded || !webgl) {
        try {
          applyState(i, animate, function () {
            if (behavior.autoplay && !editor && changed && hasVisibleMoves(states[i])) playMoves(true, true);
          });
        } catch (e) {
          fail(e);
        }
      }
      if (handle.onStep) { try { handle.onStep(i, states[i]); } catch (e) { /* ignore */ } }
      requestRender();
    }
    // No steps: the panel says so, and every part shows assembled and
    // unhighlighted, without arrows or labels, as the boot leaves a project
    // without steps (goToStep has no step to apply).
    function showNoSteps() {
      current = -1;
      played = false;
      container.classList.remove("is-played");
      if (stateTween) { removeTween(stateTween); stateTween = null; }
      if (playTween) { removeTween(playTween); playTween = null; }
      renderPanelStep(-1);
      clearArrows();
      clearLabels();
      partList.forEach(function (part) {
        snapPart(part, { offset: new THREE.Vector3(), quat: new THREE.Quaternion(), pivotCenter: part.center.clone(), alpha: 1, visible: true, cls: "normal" });
      });
      requestRender();
    }

    // ── Input ────────────────────────────────────────────────────────
    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      unloads.push(function () { target.removeEventListener(type, fn, opts); });
    }
    var pointerStart = null, lastTap = 0;
    on(canvas, "wheel", function (e) {
      if (!activation.active && !(e.ctrlKey || e.metaKey)) e.stopImmediatePropagation();
      else activation.interaction();
    }, { capture: true, passive: true });
    on(canvas, "pointerdown", function (e) {
      pointerStart = { x: e.clientX, y: e.clientY, t: Date.now(), type: e.pointerType, moved: false };
      activation.pointerDown(true, e.pointerType);
      hideHint();
      try { container.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }, { capture: true });
    on(canvas, "pointermove", function (e) {
      if (pointerStart && (Math.abs(e.clientX - pointerStart.x) > 6 || Math.abs(e.clientY - pointerStart.y) > 6)) pointerStart.moved = true;
      activation.interaction();
    }, { capture: true, passive: true });
    on(canvas, "pointerup", function (e) {
      var ps = pointerStart;
      pointerStart = null;
      if (!ps) return;
      activation.pointerUp(ps.moved, e.pointerType);
      if (ps.moved) return;
      var now = Date.now();
      if (e.pointerType === "touch" && now - lastTap < 350) { focusAt(e); lastTap = 0; }
      else lastTap = now;
      if (editor && handle.onPick) {
        var hit = pickAt(e.clientX, e.clientY);
        try { handle.onPick(hit, e); } catch (err) { /* ignore */ }
      }
    }, { capture: true });
    on(canvas, "pointercancel", function () { pointerStart = null; }, { capture: true });
    on(canvas, "dblclick", function (e) { if (e.pointerType !== "touch") focusAt(e); });
    on(canvas, "pointerleave", function (e) { activation.pointerLeave(e.pointerType); });
    on(canvas, "pointerenter", function () { activation.pointerEnter(); });
    on(doc, "pointerdown", function (e) {
      // the designer keeps its viewport active whatever panel is clicked
      if (!editor && !container.contains(e.target)) activation.pointerDown(false, e.pointerType);
    }, { capture: true, passive: true });
    on(container, "keydown", function (e) {
      if (e.defaultPrevented) return;
      var tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
      switch (e.key) {
        case "ArrowRight": case "PageDown": goToStep(current + 1, {}); break;
        case "ArrowLeft": case "PageUp": goToStep(current - 1, {}); break;
        case "Home": goToStep(0, {}); break;
        case "End": goToStep(states.length - 1, {}); break;
        case "Escape": if (editor) return; activation.escape(); break;
        case "+": case "=": dolly(1 / 1.25); break;
        case "-": case "_": dolly(1.25); break;
        default: return;
      }
      e.preventDefault();
    });
    // swipe on the panel (touch only)
    var swipe = null;
    on(panel, "pointerdown", function (e) { if (e.pointerType === "touch") swipe = { x: e.clientX, y: e.clientY }; }, { passive: true });
    on(panel, "pointerup", function (e) {
      if (!swipe || e.pointerType !== "touch") { swipe = null; return; }
      var dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > 2 * Math.abs(dy)) goToStep(dx < 0 ? current + 1 : current - 1, {});
    }, { passive: true });
    [btnPrev, btnHudPrev].forEach(function (b) { on(b, "click", function () { goToStep(current - 1, {}); }); });
    [btnNext, btnHudNext].forEach(function (b) { on(b, "click", function () { goToStep(current + 1, {}); }); });
    on(btnPlay, "click", function () { if (played) resetMoves(); else play(); });
    on(btnHome, "click", function () { resetView(); });
    on(btnZoomIn, "click", function () { dolly(1 / 1.25); });
    on(btnZoomOut, "click", function () { dolly(1.25); });
    on(btnStyle, "click", function () { setStyle(style === "lineart" ? "shaded" : "lineart"); });
    on(btnProj, "click", function () { setProjection(camera === cameraP ? "orthographic" : "perspective"); });
    on(btnFs, "click", function (e) { e.stopPropagation(); toggleFullscreen(); });

    function setRay(clientX, clientY) {
      var r = canvas.getBoundingClientRect();
      var ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
    }
    // The part under a point: {id, point, normal, distance}. In editor mode
    // the step's explicit arrows are picked too: {arrow: index, point, normal,
    // distance} when one is nearer than any part.
    function pickAt(clientX, clientY) {
      if (!webgl || !modelsLoaded) return null;
      setRay(clientX, clientY);
      var objs = [];
      partList.forEach(function (p) { if (p.pivot.visible) objs.push.apply(objs, p.meshes); });
      var hits = raycaster.intersectObjects(objs, false);
      var best = null;
      for (var i = 0; i < hits.length; i++) {
        var part = hits[i].object.userData.tdsPart;
        if (!part || part.alpha <= 0) continue;
        var n = hits[i].face ? hits[i].face.normal.clone().transformDirection(hits[i].object.matrixWorld) : new THREE.Vector3(0, 0, 1);
        best = { id: part.id, point: [hits[i].point.x, hits[i].point.y, hits[i].point.z], normal: [n.x, n.y, n.z], distance: hits[i].distance };
        break;
      }
      if (editor) {
        var arrowObjs = [];
        arrows.forEach(function (rec) { if (rec.index != null && rec.group.visible) arrowObjs.push(rec.group); });
        if (arrowObjs.length) {
          var ah = raycaster.intersectObjects(arrowObjs, true);
          for (var k = 0; k < ah.length; k++) {
            if (best && ah[k].distance >= best.distance) break;
            // an arrow's meshes sit directly under its record's group
            var grp = ah[k].object.parent, rec = null;
            for (var j = 0; j < arrows.length; j++) if (arrows[j].group === grp) { rec = arrows[j]; break; }
            if (!rec || rec.index == null) continue;
            var an = ah[k].face ? ah[k].face.normal.clone().transformDirection(ah[k].object.matrixWorld) : new THREE.Vector3(0, 0, 1);
            best = { arrow: rec.index, point: [ah[k].point.x, ah[k].point.y, ah[k].point.z], normal: [an.x, an.y, an.z], distance: ah[k].distance };
            break;
          }
        }
      }
      return best;
    }
    function focusAt(e) {
      var hit = pickAt(e.clientX, e.clientY);
      if (!hit) return;
      var cam = getCamera();
      var delta = vsub(hit.point, cam.target);
      flyTo({ position: vadd(cam.position, delta), target: hit.point, fov: cam.fov, projection: cam.projection }, behavior.transitionMs / 2, null);
    }
    function dolly(factor) {
      if (!webgl) return;
      if (camera === cameraO) {
        cameraO.zoom = clamp(cameraO.zoom / factor, controls.minZoom, controls.maxZoom);
        cameraO.updateProjectionMatrix();
      } else {
        var t = controls.target, d = camera.position.clone().sub(t);
        var len = clamp(d.length() * factor, controls.minDistance, controls.maxDistance);
        camera.position.copy(t).addScaledVector(d.normalize(), len);
      }
      controls.update();
      updateNearFar();
      requestRender();
    }
    function resetView() {
      if (!webgl) return;
      flyTo(homeCamera(), behavior.transitionMs / 2, null);
    }
    function play() { playMoves(true, true); }
    function resetMoves() { playMoves(false, true); }

    // ── Fullscreen (PinConnect's new-tab fallback) ───────────────────
    function fsElement() { return doc.fullscreenElement || doc.webkitFullscreenElement || null; }
    function fsAvailable() {
      var enabled = "fullscreenEnabled" in doc ? !!doc.fullscreenEnabled : !!doc.webkitFullscreenEnabled;
      return enabled && !!(container.requestFullscreen || container.webkitRequestFullscreen);
    }
    function openFull() {
      try {
        var u = new URL(standaloneUrl, win.location.href);
        u.searchParams.set("theme", doc.documentElement.getAttribute("data-theme") || (isDarkScheme(doc) ? "dark" : "light"));
        if (states[current]) u.searchParams.set("step", String(current + 1));
        win.open(u.href, "_blank", "noopener");
      } catch (e) { /* ignore */ }
    }
    function toggleFullscreen() {
      if (fsElement()) { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); return; }
      if (!fsAvailable()) { openFull(); return; }
      try {
        var p = (container.requestFullscreen || container.webkitRequestFullscreen).call(container);
        if (p && p.catch) p.catch(function () { if (embedded) openFull(); });
      } catch (e) { if (embedded) openFull(); }
    }
    function onFsChange() {
      var fs = fsElement() === container;
      setFullscreenClass(fs);
    }
    function setFullscreenClass(fs) {
      container.classList.toggle("is-fs", fs);
      btnFs.setAttribute("aria-label", fs ? STR.exitFullscreen : STR.fullscreen);
      btnFs.title = fs ? STR.exitFullscreen : STR.fullscreen;
      activation.setFullscreen(fs);
      onResize();
      relayout();
    }
    on(doc, "fullscreenchange", onFsChange);
    on(doc, "webkitfullscreenchange", onFsChange);
    if (!behavior.fullscreenButton || editor || (!fsAvailable() && !embedded)) btnFs.hidden = true;

    // ── Observers ────────────────────────────────────────────────────
    if (win.ResizeObserver) {
      var ro = new win.ResizeObserver(function () {
        container.classList.toggle("is-stacked", behavior.panelPlacement === "right" && container.clientWidth <= behavior.panelStackBreakpoint);
        onResize();
      });
      ro.observe(view);
      ro.observe(container);
      unloads.push(function () { ro.disconnect(); });
    } else {
      on(win, "resize", onResize);
    }
    container.classList.toggle("is-stacked", behavior.panelPlacement === "right" && container.clientWidth <= behavior.panelStackBreakpoint);
    if (win.IntersectionObserver) {
      var io = new win.IntersectionObserver(function (entries) {
        var vis = entries.some(function (en) { return en.isIntersecting; });
        if (vis && !visible) { visible = true; requestRender(); }
        if (!vis && visible) { visible = false; activation.visibility(false); }
        if (vis) hintCountdown();
      });
      io.observe(container);
      unloads.push(function () { io.disconnect(); });
    } else {
      hintCountdown();
    }
    on(doc, "visibilitychange", function () { if (doc.visibilityState === "visible") requestRender(); });
    if (win.matchMedia) {
      var mqDark = win.matchMedia("(prefers-color-scheme: dark)");
      var onScheme = function () { applyTokens(); };
      if (mqDark.addEventListener) { mqDark.addEventListener("change", onScheme); unloads.push(function () { mqDark.removeEventListener("change", onScheme); }); }
      var armDpr = function () {
        var mq = win.matchMedia("(resolution: " + (win.devicePixelRatio || 1) + "dppx)");
        var h = function () { mq.removeEventListener("change", h); if (!disposed) { armDpr(); onResize(); } };
        mq.addEventListener("change", h);
      };
      armDpr();
    }
    if (win.MutationObserver) {
      var mo = new win.MutationObserver(function () { applyTokens(); });
      mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
      unloads.push(function () { mo.disconnect(); });
    }

    // ── Public API ───────────────────────────────────────────────────
    function setStyle(s) {
      if (STYLES.indexOf(s) < 0 || s === style) return;
      style = s;
      container.setAttribute("data-style", s);
      btnStyle.classList.toggle("is-on", s === "shaded");
      if (webgl) {
        if (s === "shaded") { if (lights && !lights.key.parent) camera.add(lights.key); }
        partList.forEach(refreshPartMaterials);
        arrows.forEach(function (a) { if (a.refresh) a.refresh(); });
      }
      requestRender();
    }
    function setProjection(p) {
      if (!webgl) return;
      var want = p === "perspective" ? "perspective" : "orthographic";
      if ((want === "perspective") === (camera === cameraP)) return;
      var cam = getCamera();
      cam.projection = want;
      // A running flight finishes in the new projection instead of switching back.
      if (camTween) flightProjection = want;
      setCameraNow(cam);
    }
    function setSelection(ids) {
      selection = Array.isArray(ids) ? ids.slice() : (ids ? [ids] : []);
      var set = {};
      selection.forEach(function (id) {
        var m = registry && registry.members[id];
        (m || [id]).forEach(function (pid) { set[pid] = true; });
      });
      partList.forEach(function (part) {
        var sel = !!set[part.id];
        if (sel !== part.selected) { part.selected = sel; refreshPartMaterials(part); }
      });
      requestRender();
    }
    // Editor: which explicit arrow and label of the step are selected
    // ({arrow, label}, indices or -1); they are drawn in the accent color.
    function setAnnotationSelection(sel) {
      sel = sel || {};
      var a = typeof sel.arrow === "number" ? sel.arrow : -1;
      var l = typeof sel.label === "number" ? sel.label : -1;
      if (a === selArrow && l === selLabel) return;
      selArrow = a; selLabel = l;
      arrows.forEach(function (rec) {
        if (rec.index == null) return;
        var want = rec.index === selArrow;
        if (want !== rec.selected) { rec.selected = want; rec.refresh(); }
      });
      labels.forEach(function (lb) {
        lb.div.classList.toggle("is-selected", lb.spec.tail ? lb.spec.index === selArrow : lb.spec.index === selLabel);
      });
      requestRender();
    }
    function previewPlacement(id, placement) {
      var ids = registry && registry.members[id] ? registry.members[id] : [id];
      var pivotCenter = groupBox[id] ? groupBox[id].getCenter(new THREE.Vector3()) : null;
      ids.forEach(function (pid) {
        var part = parts[pid];
        if (!part) return;
        var off = placement && placement.offset ? placement.offset : [0, 0, 0];
        var rot = placement && placement.rotate ? placement.rotate : [0, 0, 0];
        part.offset.fromArray(off);
        part.quat.copy(quatFromRotate(rot));
        part.pivotCenter.copy(pivotCenter || part.center);
        applyPlacement(part);
      });
      updateAutoArrows();
      requestRender();
    }
    function setScene(newScene, opts) {
      opts = opts || {};
      var keepCamera = opts.keepCamera !== false;
      var camBefore = webgl ? getCamera() : null;
      scene = newScene || { steps: [] };
      refold();
      renderPanelStatic();
      var i = clamp(current < 0 ? 0 : current, 0, Math.max(0, states.length - 1));
      current = -1;
      if (states.length) goToStep(i, { animate: false });
      else { showNoSteps(); if (!keepCamera && webgl) setCameraNow(homeCamera()); }
      if (keepCamera && camBefore && webgl) setCameraNow(camBefore);
    }
    function setModels(models) {
      if (!webgl) return Promise.resolve();
      var camBefore = getCamera();
      modelsLoaded = false;
      return loadModels(models).then(function (loaded) {
        if (disposed) return;
        clearArrows();
        buildParts(loaded);
        refold();
        renderPanelStatic();
        var i = clamp(current < 0 ? 0 : current, 0, Math.max(0, states.length - 1));
        current = -1;
        if (states.length) goToStep(i, { animate: false });
        else showNoSteps();
        setCameraNow(camBefore);
      }).catch(fail);
    }
    function refold() {
      try {
        states = foldSteps(scene, registry || []);
      } catch (e) {
        states = [];
        states.warnings = [e.message];
        fail(e);
      }
      camCache = [];
      handle.states = states;
      handle.warnings = states.warnings || [];
    }
    function fit(ids, opts) {
      if (!webgl) return;
      opts = opts || {};
      var cam = getCamera();
      var dir = vnorm(vsub(cam.position, cam.target));
      var next = fitCamera(boxOf(ids && ids.length ? ids : null, states[current] ? states[current].placed : null), dir, cam.fov, cam.projection, aspect());
      flyTo(next, opts.animate === false ? 0 : behavior.transitionMs / 2, null);
    }
    function screenshot(type) {
      if (!webgl) return null;
      render();
      return canvas.toDataURL(type || "image/png");
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      handle.disposed = true;
      if (rafId) win.cancelAnimationFrame(rafId);
      unloads.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
      activation.dispose();
      if (hintTimer) win.clearTimeout(hintTimer);
      if (watchdog) win.clearTimeout(watchdog);
      clearArrows();
      clearLabels();
      clearParts();
      if (controls) controls.dispose();
      if (webgl) {
        gbuf.dispose(); edgeTarget.dispose();
        edgeQuad.dispose(); compQuad.dispose();
        Object.keys(matCache).forEach(function (k) { matCache[k].dispose(); });
        if (unitShaft) { unitShaft.dispose(); unitCone.dispose(); }
        renderer.dispose();
      }
      while (container.firstChild) container.removeChild(container.firstChild);
      container.classList.remove("tds-ready", "is-active", "is-fs", "is-flying");
    }

    Object.assign(handle, {
      goToStep: goToStep,
      getStep: function () { return current; },
      getState: function () { return states[current] || null; },
      play: play,
      reset: resetMoves,
      resetView: resetView,
      setScene: setScene,
      setModels: setModels,
      getCamera: function () { return webgl ? getCamera() : null; },
      setCamera: function (cam, opts) { if (!webgl || !cam) return; flyTo(cam, opts && opts.animate ? behavior.transitionMs : 0, null); },
      fit: fit,
      setStyle: setStyle,
      getStyle: function () { return style; },
      setProjection: setProjection,
      getProjection: function () { return camera === cameraP ? "perspective" : "orthographic"; },
      pick: function (x, y) { return pickAt(x, y); },
      setSelection: setSelection,
      getSelection: function () { return selection.slice(); },
      previewPlacement: previewPlacement,
      screenshot: screenshot,
      resize: onResize,
      refreshTheme: applyTokens,
      activate: function () { activation.activate(); },
      deactivate: function () { activation.deactivate(); },
      isActive: function () { return activation.active; },
      zoom: dolly,
      dispose: dispose,
      parts: function () { return partList.map(function (p) { return p.id; }); },
      tree: function () { return registry; },
      // Editor hooks for the designer's viewport tools (editor: true only).
      editor: editor ? {
        overlay: function () { return overlay3; },           // a THREE.Scene drawn over the frame (gizmos, previews)
        camera: function () { return camera; },              // the live THREE camera (changes with the projection)
        controls: function () { return controls; },          // the OrbitControls, to pause while a gizmo drags
        canvas: canvas,
        requestRender: requestRender,
        setAnnotationSelection: setAnnotationSelection,
        // A world point to client coordinates: {x, y, visible}.
        project: function (p) {
          if (!webgl) return null;
          var v = new THREE.Vector3().fromArray(p).project(camera);
          var r = canvas.getBoundingClientRect();
          return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, visible: v.z >= -1 && v.z <= 1 };
        },
        // The pointer ray through a client point: {origin, direction} in model space.
        ray: function (clientX, clientY) {
          if (!webgl) return null;
          setRay(clientX, clientY);
          return { origin: raycaster.ray.origin.toArray(), direction: raycaster.ray.direction.toArray() };
        }
      } : null,
      _debug: {
        setFullscreenClass: setFullscreenClass, tokens: function () { return tokens; }, parts: function () { return parts; },
        scene3: function () { return scene3; }, resolveCamera: resolveCamera, isVisible: function () { return visible; },
        controls: function () { return controls; }, behavior: behavior
      }
    });

    // ── Boot sequence ────────────────────────────────────────────────
    refold();
    renderPanelStatic();
    var watchdog = null;
    var initialRef = options.initialStep != null ? options.initialStep : 0;
    try {
      initThree();
    } catch (e) {
      webgl = false;
      if (win.console && win.console.warn) win.console.warn("ThreeDStep: " + e.message);
      showFallback(STR.noWebgl, e.message, true);
      goToStep(initialRef, { animate: false });
      if (stepIndex(initialRef) < 0) goToStep(0, { animate: false });
      if (!states.length) showNoSteps();
      handle.ready = true;
      container.classList.add("tds-ready");
      if (handle.onReady) { try { handle.onReady(handle); } catch (err) { /* ignore */ } }
      return handle;
    }
    showFallback(STR.loading, "", false, true);
    watchdog = win.setTimeout(function () {
      if (!handle.ready && !disposed) showFallback(STR.stillLoading, "", true, true);
    }, 15000);
    loadModels(options.models || {}).then(function (loaded) {
      if (disposed) return;
      buildParts(loaded);
      refold();
      renderPanelStatic();
      hideFallback();
      var i = stepIndex(initialRef);
      if (i < 0) i = 0;
      current = -1;
      if (states.length) goToStep(i, { animate: false });
      else { setCameraNow(homeCamera()); showNoSteps(); }
      render();
      updateLabels();
      handle.ready = true;
      container.classList.add("tds-ready");
      win.clearTimeout(watchdog);
      if (behavior.autoplay && !editor && hasVisibleMoves(states[current])) playMoves(true, true);
      if (handle.onReady) { try { handle.onReady(handle); } catch (err) { /* ignore */ } }
      relayout();
    }).catch(function (e) {
      win.clearTimeout(watchdog);
      fail(e);
      if (states.length && current < 0) goToStep(0, { animate: false });
    });
    return handle;
  }

  // ── boot(): the generated page ─────────────────────────────────────
  function startHeightReporter(root, isFullscreen) {
    var embedded = window.parent !== window;
    var reporter = createHeightReporter({
      measure: function () { return document.body ? document.body.scrollHeight : 0; },
      post: function (h) { try { window.parent.postMessage({ mdIframeHeight: h }, "*"); } catch (e) { /* parent gone */ } },
      isFullscreen: isFullscreen
    });
    function report() {
      if (!embedded) return;
      // The parent sizes the frame to fit: our own scrollbar would only narrow
      // the content and make the height oscillate.
      document.documentElement.style.overflow = isFullscreen() ? "" : "hidden";
      reporter.report();
    }
    window.addEventListener("load", report);
    window.addEventListener("resize", report);
    window.addEventListener("tds-relayout", report);
    if (window.ResizeObserver) { try { new ResizeObserver(report).observe(document.body); } catch (e) { /* ignore */ } }
    document.addEventListener("fullscreenchange", function () { reporter.reset(); report(); });
    report();
    return reporter;
  }

  function boot(options) {
    options = options || {};
    var root = document.getElementById(options.rootId || "tds");
    var sceneEl = document.getElementById(options.sceneId || "tds-scene");
    if (!root || !sceneEl) {
      if (window.console) window.console.error("ThreeDStep.boot: #tds or #tds-scene is missing");
      return null;
    }
    document.documentElement.classList.add("tds-page");
    var scene;
    try { scene = JSON.parse(sceneEl.textContent); } catch (e) {
      if (window.console) window.console.error("ThreeDStep.boot: the scene JSON is invalid", e);
      return null;
    }
    var models = {};
    var modelEls = document.querySelectorAll('script[id^="tds-model-"]');
    for (var i = 0; i < modelEls.length; i++) {
      var elm = modelEls[i];
      var name = elm.getAttribute("data-name") || ("model-" + i);
      try { models[name] = base64ToArrayBuffer(elm.textContent); } catch (e) {
        if (window.console) window.console.error("ThreeDStep.boot: could not decode the model " + name, e);
      }
    }
    var params = parseParams(window.location.search);
    // options.viewer: extra createViewer options (callbacks, editor flags) for
    // pages that boot the generated-page way but want the handle's hooks.
    var viewer = createViewer(root, Object.assign({
      scene: scene,
      models: models,
      controls: params.controls || undefined,
      style: params.style || undefined,
      initialStep: params.step != null ? params.step : 0,
      behavior: params.autoplay ? { autoplay: true } : undefined,
      onReady: options.onReady,
      onError: options.onError,
      standaloneUrl: window.location.href
    }, options.viewer || {}));
    var isFs = function () { return !!(document.fullscreenElement || document.webkitFullscreenElement); };
    var reporter = startHeightReporter(root, isFs);
    window.addEventListener("message", function (e) {
      var d = e.data;
      // A number is a 1-based step number, as in ?step=N.
      if (d && typeof d === "object" && "threedstepStep" in d && viewer) {
        viewer.goToStep(typeof d.threedstepStep === "number" ? String(d.threedstepStep) : d.threedstepStep, {});
      }
    });
    viewer.heightReporter = reporter;
    return viewer;
  }

  window.ThreeDStep = {
    VERSION: VERSION,
    boot: boot,
    createViewer: createViewer,
    foldSteps: foldSteps,
    renderText: renderText,
    defaults: { behavior: BEHAVIOR_DEFAULTS, light: LIGHT, dark: DARK },
    _internals: {
      parseParams: parseParams,
      normalizeTree: normalizeTree,
      escapeHtml: escapeHtml,
      orthoHalfHeight: orthoHalfHeight,
      fitCamera: fitCamera,
      arrowSizes: arrowSizes,
      autoArrowSpan: autoArrowSpan,
      edgeKernel: edgeKernel,
      createActivation: createActivation,
      createHeightReporter: createHeightReporter,
      startHeightReporter: startHeightReporter,
      readBehavior: readBehavior,
      base64ToArrayBuffer: base64ToArrayBuffer,
      STR: STR
    }
  };
})();
