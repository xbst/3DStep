"""The generated page: scene JSON, theme CSS, and one self-contained HTML file.

``generate_html`` inlines everything the page needs: the theme CSS, the viewer
runtime (``viewer/viewer.css``, ``viewer/viewer.js``), the Three.js bundle, the
scene JSON and every model as base64. The command line and the designer (under
Pyodide) run this same code on the same package files, so they produce the same
bytes; nothing here may depend on the platform, the clock or the environment.
"""
from __future__ import annotations

import base64
import html
import json
import re
import urllib.parse
from dataclasses import dataclass, fields
from pathlib import Path

from . import __version__, glb
from .config import (
    CameraSpec,
    Project,
    Theme,
    ThemeBehavior,
    check_arrows,
    check_ids,
    load_models,
    load_project,
    load_theme,
)

_VIEWER = Path(__file__).parent / "viewer"
_BUNDLE = _VIEWER / "vendor" / "three.bundle.js"


# ── Scene JSON ───────────────────────────────────────────────────────

def _camera(cam: CameraSpec | None) -> dict | None:
    """A camera as the scene carries it. A step camera holds only the keys its
    TOML gives: fov and projection are inherited when absent, so filling in a
    default here would override the previous step's."""
    if cam is None:
        return None
    out: dict = {}
    if cam.position is not None and cam.target is not None:
        out["position"] = list(cam.position)
        out["target"] = list(cam.target)
    if cam.fit:
        out["fit"] = list(cam.fit)
    if cam.fov is not None:
        out["fov"] = cam.fov
    if cam.projection is not None:
        out["projection"] = cam.projection
    return out


def build_scene(project: Project) -> dict:
    """The scene object the viewer consumes (SPEC 8), defaults applied."""
    a = project.assembly
    return {
        "version": 1,
        "title": a.title,
        "description": a.description,
        "style": a.style,
        "up": a.up,
        "start": a.start,
        "arrow_scale": a.arrow_scale,
        "camera": _camera(project.camera),
        "models": [{"name": name} for name in a.models],
        # Only the parts a [[part]] table describes. An empty name or color
        # means "not set": the viewer falls back to the node's label, then its
        # id, and to the model's own color.
        "parts": {p.id: {"name": p.name, "color": p.color} for p in project.parts},
        "steps": [{
            "id": s.id,
            "title": s.title,
            "text": s.text,
            "note": s.note,
            "show": list(s.show),
            "hide": list(s.hide),
            "highlight": list(s.highlight),
            "ghost": list(s.ghost),
            "camera": _camera(s.camera),
            "moves": [{
                "parts": list(m.parts),
                "offset": list(m.offset),
                "rotate": list(m.rotate),
                "arrow": m.arrow,
            } for m in s.moves],
            "arrows": [{
                "from": list(ar.from_),
                "to": list(ar.to),
                "kind": ar.kind,
                "turns": ar.turns,
                "radius": ar.radius,
                "color": ar.color,
                "label": ar.label,
                "attach": ar.attach,
            } for ar in s.arrows],
            "labels": [{
                "text": lab.text,
                "at": list(lab.at),
                "side": lab.side,
                "attach": lab.attach,
            } for lab in s.labels],
        } for s in project.steps],
    }


def _scene_json(scene: dict) -> str:
    # Sorted keys and ASCII only, so the bytes never depend on dict order or
    # an encoder's choices; <, > and & escaped so no string (a step text
    # holding "</script>", say) can end or inject into the script element.
    return (
        json.dumps(scene, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        .replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    )


# ── Theme CSS ────────────────────────────────────────────────────────

def _theme_fonts(theme: Theme) -> list:
    """The theme's fonts (main first, then a distinct label font if any)."""
    fonts = [theme.font]
    if theme.label_font is not None:
        fonts.append(theme.label_font)
    return fonts


def _render_font_head(theme: Theme) -> str:
    """<head> markup to load the theme's Google fonts (preconnect + one css2
    link).  Bundled fonts ship as @font-face in the main stylesheet and system
    fonts need nothing, so those contribute no head markup here."""
    specs: list[str] = []
    seen: set[str] = set()
    for f in _theme_fonts(theme):
        if f.source != "google" or f.family in seen:
            continue
        seen.add(f.family)
        fam = urllib.parse.quote_plus(f.family)
        weights = urllib.parse.quote(f.weights, safe=";,.")
        specs.append(f"{fam}:wght@{weights}" if weights else fam)
    if not specs:
        return ""
    href = "https://fonts.googleapis.com/css2?family=" + "&family=".join(specs) + "&display=swap"
    return (
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        f'<link href="{html.escape(href)}" rel="stylesheet">'
    )


def _render_theme_css(theme: Theme) -> str:
    """Emit a theme's CSS: @font-face for any bundled fonts, the font-family
    variables (--ui-font, --label-font), then the color custom-property blocks
    (light on :root, dark under both prefers-color-scheme and [data-theme=dark],
    an explicit [data-theme=light] override), then any raw extra CSS.

    Each color block also declares ``color-scheme``.  A browser only lets an
    iframe's canvas stay transparent while the embedded document's used
    color-scheme matches the embedder's, so without this a ``bg`` of
    ``transparent`` paints opaque white inside a dark host page."""
    def block(selector: str, colors: dict[str, str], scheme: str) -> str:
        decls = "".join(f"--{k}:{v};" for k, v in colors.items())
        return f"{selector}{{{decls}color-scheme:{scheme}}}"

    parts: list[str] = []

    seen_faces: set[str] = set()
    for f in _theme_fonts(theme):
        if f.source == "bundled" and f.data_uri and f.family not in seen_faces:
            seen_faces.add(f.family)
            parts.append(
                f"@font-face{{font-family:'{f.family}';"
                f"src:url({f.data_uri}) format('{f.fmt}');font-display:swap}}"
            )

    ui_font = theme.font.css_family("system-ui,sans-serif")
    label_font = theme.label_font.css_family("sans-serif") if theme.label_font else "var(--ui-font)"
    parts.append(f":root{{--ui-font:{ui_font};--label-font:{label_font}}}")

    light, dark = theme.colors_light, theme.colors_dark
    parts.extend([
        block(":root", light, "light"),
        f"@media(prefers-color-scheme:dark){{{block(':root', dark, 'dark')}}}",
        block(':root[data-theme="dark"]', dark, "dark"),
        block(':root[data-theme="light"]', light, "light"),
    ])
    css = "\n".join(parts)
    if theme.extra_css.strip():
        css += "\n" + theme.extra_css.strip()
    return css


def _num(value: float) -> str:
    """A number as CSS and data attributes carry it: 35.0 -> "35", 1.6 -> "1.6"."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return repr(value)


# The stacked layout: the panel under the view instead of beside it. The
# viewer's own stylesheet does the same for `.tds.is-stacked`, which its boot
# script sets; this copy, in a media query at the theme's breakpoint, lays the
# page out before any script runs.
_STACKED = ".tds .tds-main{flex-direction:column}.tds .tds-panel{flex:none;width:auto;max-width:none}"


def _render_behavior_css(theme: Theme) -> str:
    """Behavior-driven CSS: the layout variables the viewer's stylesheet reads,
    plus the panel stacking rules for ``panel_placement`` ("right" stacks at or
    under the breakpoint, "below" always, "overlay" never). Emitted after the
    viewer's stylesheet so its rules override the base layout."""
    b = theme.behavior
    parts = [
        f":root{{--panel-max:min({b.panel_max_width}px,40vw);--font-scale:{_num(b.font_scale)};"
        f"--view-aspect:{_num(b.viewport_aspect)};--view-min-h:{b.viewport_min_height}px;"
        f"--view-max-h:{b.viewport_max_height}px}}"
    ]
    if b.panel_placement == "right":
        parts.append(f"@media(max-width:{b.panel_stack_breakpoint}px){{{_STACKED}}}")
    elif b.panel_placement == "below":
        parts.append(_STACKED)
    return "\n".join(parts)


def _behavior_attrs(behavior: ThemeBehavior) -> str:
    """Every behavior as a ``data-*`` attribute on ``.tds`` (``transition_ms``
    becomes ``data-transition-ms``), so the viewer reads numbers and switches
    from its root element instead of parsing CSS."""
    out = []
    for f in fields(behavior):
        value = getattr(behavior, f.name)
        if isinstance(value, bool):
            text = "true" if value else "false"
        elif isinstance(value, (int, float)):
            text = _num(value)
        else:
            text = str(value)
        out.append(f' data-{f.name.replace("_", "-")}="{html.escape(text)}"')
    return "".join(out)


def _theme_sync_script() -> str:
    """PinConnect's theme-sync script, verbatim but for this comment.

    It sets ``data-theme`` on <html>, which the theme CSS keys its palettes on.
    The message key ``pinconnectTheme`` is PinConnect's on purpose: one host
    script drives the scheme of every embedded tool."""
    return """\
/* Theme sync: ?theme=dark|light forces a theme; otherwise follow the embedding
   page's toggle (MkDocs Material / Zensical set data-md-color-scheme on body,
   "slate" = dark) via same-origin parent access + MutationObserver, or a
   {pinconnectTheme:"dark"|"light"} postMessage for cross-origin embeds (the
   key PinConnect uses, so one host script drives both tools).
   With no signal, data-theme stays unset and prefers-color-scheme applies. */
(function(){
  var root=document.documentElement;
  function apply(t){
    if(t==='dark'||t==='light')root.setAttribute('data-theme',t);
    else root.removeAttribute('data-theme');
  }
  window.addEventListener('message',function(e){
    if(e.data&&typeof e.data==='object'&&'pinconnectTheme' in e.data)apply(e.data.pinconnectTheme);
  });
  var forced=null;
  try{forced=new URLSearchParams(location.search).get('theme')}catch(err){}
  if(forced==='dark'||forced==='light'){apply(forced);return}
  function fromParent(){
    try{
      if(window.parent===window)return null;
      var pd=window.parent.document;
      var md=(pd.body&&pd.body.getAttribute('data-md-color-scheme'))||
             pd.documentElement.getAttribute('data-md-color-scheme');
      if(md)return md==='slate'?'dark':'light';
      var dt=pd.documentElement.getAttribute('data-theme')||
             (pd.body&&pd.body.getAttribute('data-theme'));
      if(dt==='dark'||dt==='light')return dt;
      if(pd.documentElement.classList.contains('dark')||
         (pd.body&&pd.body.classList.contains('dark')))return 'dark';
      return null;
    }catch(err){return null}
  }
  function sync(){var t=fromParent();if(t)apply(t)}
  sync();
  try{
    if(window.parent!==window){
      var pd=window.parent.document;
      var mo=new MutationObserver(sync);
      mo.observe(pd.documentElement,{attributes:true});
      if(pd.body)mo.observe(pd.body,{attributes:true});
    }
  }catch(err){}
})();"""


# ── Runtime files ────────────────────────────────────────────────────

def _read_runtime(path: Path) -> str:
    try:
        # Text mode turns a CRLF checkout's line endings into LF, so a page
        # rendered from a Windows clone matches one rendered anywhere else.
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise FileNotFoundError(f"the viewer runtime is missing: {path}\nReinstall 3dstep.") from None


def _runtime_files() -> tuple[str, str, str]:
    """``viewer.css``, ``viewer.js`` and the Three.js bundle, read from the
    package at render time, so the CLI and the designer inline the same bytes.

    A missing bundle is an empty string rather than an error: the page then
    shows only its written steps (:func:`runtime_warnings` says so).
    """
    css = _read_runtime(_VIEWER / "viewer.css")
    js = _read_runtime(_VIEWER / "viewer.js")
    bundle = _read_runtime(_BUNDLE) if _BUNDLE.is_file() else ""
    return css, js, bundle


def runtime_warnings() -> list[str]:
    if not _BUNDLE.is_file():
        return ["viewer bundle missing; the page will show the written steps only"]
    return []


def _inline_js(code: str) -> str:
    # "</script" anywhere inside a script element ends it, even in a string or
    # a comment. "<\/script" means the same to JavaScript.
    return re.sub(r"</(script)", r"<\\/\1", code, flags=re.IGNORECASE)


def _inline_css(css: str) -> str:
    return re.sub(r"</(style)", r"<\\/\1", css, flags=re.IGNORECASE)


# ── Page ─────────────────────────────────────────────────────────────

def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n[ \t]*\n", text.strip()) if p.strip()]


def _render_fallback(project: Project) -> str:
    """The written instructions, readable with no script and no WebGL (and by
    search engines). The viewer replaces them with its own panel."""
    esc = html.escape
    a = project.assembly
    lines = ['<div class="tds-static">', f'<h1 class="tds-static-title">{esc(a.title)}</h1>']
    if a.description.strip():
        lines.append(f'<p class="tds-static-desc">{esc(a.description.strip())}</p>')
    if project.steps:
        lines.append('<ol class="tds-static-steps">')
        for step in project.steps:
            lines.append(f'<li data-step="{esc(step.id)}">')
            lines.append(f"<h2>{esc(step.title)}</h2>")
            lines.extend(f"<p>{esc(p)}</p>" for p in _paragraphs(step.text))
            if step.note.strip():
                lines.append(f'<p class="tds-note">{esc(step.note.strip())}</p>')
            lines.append("</li>")
        lines.append("</ol>")
    lines.append("</div>")
    return "\n".join(lines)


_TOKEN_RE = re.compile(r"@@([A-Z_]+)@@")

# An inline icon (a cube outline), so a page opened on its own (the fullscreen
# fallback's new tab) shows one and the browser never asks the host for a
# /favicon.ico it may not have, which would log an error.
_ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E"
         "%3Cpath d='M8 1.5l5.6 3.2v6.6L8 14.5l-5.6-3.2V4.7zM2.4 4.7L8 8l5.6-3.3M8 8v6.5' "
         "fill='none' stroke='%232563eb' stroke-width='1.4' stroke-linejoin='round'/%3E%3C/svg%3E")

# Tokens are replaced in one pass, so nothing inserted is scanned again: a step
# text or a script that happens to contain "@@SCENE@@" stays as it is. The
# inlined CSS and JavaScript need no brace escaping either.
_HTML_TEMPLATE = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>@@TITLE@@</title>
<link rel="icon" href="@@ICON@@">
@@HEAD@@<style>
@@STYLE@@
</style>
<script>
@@THEME_SYNC@@
</script>
</head>
<body>
<div class="tds" id="tds"@@ATTRS@@>
@@FALLBACK@@
</div>
<script type="application/json" id="tds-scene">@@SCENE@@</script>
@@MODELS@@
@@BUNDLE@@<script>
@@VIEWER@@
</script>
<script>ThreeDStep.boot();</script>
<!-- @@NOTICE@@ -->
</body>
</html>
"""


def generate_html(project: Project, models: dict[str, bytes], *,
                  theme: Theme | None = None) -> str:
    """The page for a project (SPEC 9.1). ``models`` maps each file name in
    ``[assembly] models`` to its bytes."""
    if theme is None:
        theme = Theme()
    css, js, bundle = _runtime_files()
    a = project.assembly

    model_tags = []
    for i, name in enumerate(a.models):
        if name not in models:
            raise ValueError(f"no data for the model '{name}'")
        data = base64.b64encode(bytes(models[name])).decode("ascii")
        model_tags.append(f'<script type="application/octet-stream" id="tds-model-{i}" '
                          f'data-name="{html.escape(name)}">{data}</script>')

    head = ""
    if a.description.strip():
        head += f'<meta name="description" content="{html.escape(a.description.strip())}">\n'
    font_head = _render_font_head(theme)
    if font_head:
        head += font_head + "\n"

    notice = f"3DStep {__version__} (https://github.com/xbst/3DStep), GPL-3.0."
    if bundle:
        notice += " Includes three.js (https://threejs.org), MIT License, copyright three.js authors."

    values = {
        "TITLE": html.escape(a.title),
        "ICON": _ICON,
        "HEAD": head,
        "STYLE": _inline_css("\n".join(
            part for part in (_render_theme_css(theme), css.strip(), _render_behavior_css(theme)) if part
        )),
        "THEME_SYNC": _theme_sync_script(),
        "ATTRS": f' data-style="{html.escape(a.style)}"' + _behavior_attrs(theme.behavior),
        "FALLBACK": _render_fallback(project),
        "SCENE": _scene_json(build_scene(project)),
        "MODELS": "\n".join(model_tags),
        "BUNDLE": f"<script>\n{_inline_js(bundle.strip())}\n</script>\n" if bundle.strip() else "",
        "VIEWER": _inline_js(js.strip()),
        "NOTICE": notice,
    }
    return _TOKEN_RE.sub(lambda m: values[m.group(1)], _HTML_TEMPLATE)


# ── Rendering a project file ─────────────────────────────────────────

@dataclass
class Page:
    """A rendered project: the HTML, every warning, and what the CLI reports."""
    html: str
    warnings: list[str]
    steps: int
    parts: int


def _count_parts(nodes: list[dict]) -> int:
    count, stack = 0, list(nodes)
    while stack:                    # a stack, not recursion: any depth counts
        node = stack.pop()
        count += int(node["has_mesh"])
        stack.extend(node["children"])
    return count


def build_page(path: Path, *, theme_name: str = "") -> Page:
    """Load a project file and the models it names, check them, and render.

    The ``3dstep`` command and the designer's bridge both call this, so the
    designer's Generate and the command line produce the same bytes for the
    same files. ``theme_name`` overrides ``[assembly] theme``. Raises
    ValueError for a problem in the project or a model, and FileNotFoundError
    for a theme that does not exist.
    """
    path = Path(path)
    project = load_project(path)
    models = load_models(project)
    trees: dict[str, list] = {}
    boxes: dict[str, dict | None] = {}
    model_warnings: list[str] = []
    parts = 0
    for name in project.assembly.models:
        try:
            doc = glb.read_glb(models[name])
        except ValueError as e:
            raise ValueError(f"{name}: {e}") from None
        model_warnings.extend(f"{name}: {w}" for w in glb.validate(doc))
        trees[name] = glb.tree(doc)
        boxes[name] = glb.bbox(doc)
        parts += _count_parts(trees[name])
    check_ids(project, trees)
    theme = load_theme(theme_name or project.assembly.theme, path, project.assembly.theme_dir)
    check_arrows(project, boxes, theme.behavior.arrow_scale)
    page = generate_html(project, models, theme=theme)
    warnings = model_warnings + project.warnings + theme.warnings + runtime_warnings()
    return Page(html=page, warnings=warnings, steps=len(project.steps), parts=parts)
