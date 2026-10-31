# AGENTS.md

Guidance for AI coding agents working in the 3DStep repository. Human-facing documentation lives in a separate repository, [doctools-docs](https://github.com/xbst/doctools-docs), to be published at <https://doctools.isiks.tech/3dstep/>; this repository keeps only a short [`README.md`](README.md). This file covers how the pieces fit together and the conventions to follow when changing them.

## What this project is

3DStep turns a CAD assembly (STEP) into step-by-step interactive 3D assembly instructions for documentation sites. It is one tool, **`3dstep`**: one command, one distribution (`3dstep`), one Python package (`threedstep`). It has the same shape as [PinConnect](https://github.com/xbst/PinConnect), and copies its patterns wherever they apply:

1. **The designer** (`src/threedstep/designer/`): a browser app that imports STEP (or GLB) files, tessellates them in the browser, and builds the steps: which parts show, where moved parts sit, what is highlighted, arrows, labels, a camera and text per step. It writes a project TOML plus one GLB per imported model, and renders the page by loading the `threedstep` package into the browser under Pyodide, so it never reimplements the renderer. `3dstep` with no arguments serves it locally; it will also be hosted at <https://3dstep.isiks.tech>.
2. **The command line** (`3dstep assembly.toml`): reads the TOML and the GLBs and writes one self-contained HTML file, `assembly.3dstep.html`. `3dstep model.step` converts a STEP to a GLB on a machine, with the optional `3dstep[step]` dependency (OCP), for CI pipelines that keep only the STEP.
3. **The generated page**: a Three.js viewer with a step panel, embedded in MkDocs / Zensical sites with [md-iframe](https://github.com/xbst/md-iframe). It follows the host's light/dark scheme and reports its height with the same contracts as PinConnect's pages.

The project TOML is the interface between the designer and the renderer; the generated HTML is the interface between the renderer and the publishing step.

**Status.** In place: the package core (the project and theme loaders, the GLB reader and writer, the renderer, the command line, the local server, the Pyodide payload, the designer's bridge, the bundled themes and a synthetic example), the viewer runtime (`viewer/`, with the vendored Three.js bundle), the browser's STEP import pipeline (`designer/js/import/`, `designer/vendor/`) and the STEP converter (`stepconv.py`, the `step` extra). Still to come: the designer app (`designer/index.html` is a placeholder) and its viewport tools.

## Repository layout

- `pyproject.toml`: the `3dstep` distribution (src layout). Declares one console script, `3dstep`, and the `step` extra. `setup.py` clears setuptools' staged `build/lib/threedstep` before each build so deleted files never reach a wheel. `MANIFEST.in` keeps a working copy's tests out of the sdist.
- `src/threedstep/`: the package.
  - `cli.py`: `main()`, the `3dstep` command: no file opens the designer, a `.toml` renders, a `.step` / `.stp` converts. `__main__.py` makes `python -m threedstep` call `main()`.
  - `config.py`: the project dataclasses (`Project`, `Assembly`, `CameraSpec`, `PartMeta`, `Step`, `Move`, `Arrow`, `Label`), `load_project`, `load_models`, `check_ids`; the theme dataclasses (`Theme`, `ThemeFont`, `ThemeBehavior`) and `load_theme`.
  - `glb.py`: the GLB reader (`read_glb`, `node_ids`, `tree`, `triangle_count`, `bbox`, `metadata`, `validate`) and writer (`Model`, `Node`, `Mesh`, `Primitive`, `slugify`, `assign_ids`, `write_glb`).
  - `renderer.py`: `build_scene` (the scene JSON the viewer consumes), the theme and behavior CSS, the theme-sync script, `generate_html`, and `build_page`, the one sequence (load, read models, check ids, theme, render) that both the command line and the bridge run.
  - `serve.py`: the local designer server (the designer at `/`, the viewer runtime at `/viewer/`). `payload.py`: locates the designer and builds the Pyodide payload; `python -m threedstep.payload [--force]` builds it by hand.
  - `stepconv.py`: the STEP converter behind `3dstep model.step` (the optional `step` extra, see below): `read_step`, `build_model`, `convert_step`, `write`. Only the convert mode imports it, and the payload leaves it out.
  - `themes/`: theme definitions (`*.toml`). **Source of truth** for themes, read by the designer through the bridge.
  - `viewer/`: the runtime every generated page inlines and the designer loads: `viewer.js` (a classic script exposing `window.ThreeDStep`), `viewer.css`, and `vendor/three.bundle.js` (built by `tools/vendor/`).
  - `designer/`: the designer (vanilla ES modules, no framework, no bundler) and `py/bridge.py`, the only Python it adds.
  - `designer/threedstep.zip`: the payload the browser fetches at startup. **Generated and git-ignored.**
- `examples/demo/`: a synthetic project (a board on standoffs, held by screws) that uses every key of the project TOML once. `demo.glb` was written by `glb.write_glb`.
- `.github/workflows/pages.yml`: deploys the designer to GitHub Pages.

## Key facts and gotchas

- **The designer's Generate matches the CLI byte for byte.** Both call `renderer.build_page` on the same files: the bridge writes the TOML and the models to `/threedstep/work/` in Pyodide's filesystem first. Everything in the output must be deterministic: `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=True)` for the scene, never iterate a `set` into output, no `zlib` / `gzip` / `zipfile` compression in the page (CPython on Windows links zlib-ng, Pyodide links zlib, and their DEFLATE output differs), no timestamps, random values, platform, absolute paths or environment (the version comes from `__version__`), explicit little-endian `struct` formats, and LF newlines (the CLI writes with `newline="\n"`; runtime files are read in text mode so a CRLF checkout inlines LF).
- **The page is assembled by token replacement, not `str.format`.** `@@NAME@@` tokens in `_HTML_TEMPLATE` are replaced in one pass, so the inlined CSS and JavaScript need no brace escaping and nothing inserted is scanned again. Every string from the TOML that lands in HTML is escaped; the scene JSON escapes `<`, `>` and `&`; inlined scripts and styles have `</script` / `</style` neutralized.
- **The renderer does not transform step text.** The viewer renders its markup (paragraphs, `**bold**`, `` `code` ``, links) with `ThreeDStep.renderText`, the same code in the designer's preview and the page. The renderer only writes the text as plain paragraphs into the static fallback, which keeps the instructions readable without JavaScript or WebGL.
- **The viewer runtime is read from the package at render time** (`renderer._runtime_files`), from `Path(__file__).parent`, which works in an editable install, a wheel and Pyodide alike. A missing `viewer/vendor/three.bundle.js` renders anyway, with a `Warning:` line: the page then shows its written steps only.
- **Unknown keys in a project TOML are errors**, in every table, and so are wrong types, enum values outside their list, bad ids, vectors that are not three finite numbers, duplicate step ids, an id in both `show` and `hide` of a step, and `turns = 0`. Errors read `<file>: <table>: <message>`. Id references are checked against the models by `check_ids`, which lists the nearest existing ids; it also warns about `[[part]]` tables for unknown ids, ids two models share, and steps that highlight, ghost or move a part hidden in that step. Theme files are lenient where PinConnect's are: unknown `[behavior]` keys and tables are warnings, unknown color tokens pass through as CSS variables, bad enum values are errors.
- **Model units are millimeters and the axes are the CAD file's** (`[assembly] up`, Z by default). glTF says meters and Y-up; 3DStep deliberately does not convert, so every coordinate an author sees is the same number in the TOML, the designer and their CAD tool. Nothing is normalized.
- **GLB conventions** (`glb.write_glb`; the designer's `glb-writer.js` follows the same): one node per part named by its id, groups without meshes; positions baked in the assembly's world coordinates, quantized as `SHORT` normalized with the part node's translation at the mesh's bounding-box center and a uniform scale of the largest half extent (`KHR_mesh_quantization`, required); normals `BYTE` normalized padded to 4 bytes; `UNSIGNED_SHORT` indices up to 65535 vertices; one material per color named `color_<rrggbb>`; `asset.extras.threedstep` holds `{version, units, up, generator}`. The node `extras` carry the CAD `label` (and a free-form `src`).
- **Ids come from one rule implemented twice**: `glb.slugify` / `glb.assign_ids` here and `designer/js/import/ids.js` in the designer (NFKD, drop non-ASCII, lowercase, runs of other characters to `_`, strip `_`, empty is `part`; duplicates get `_2`, `_3`, … in document order, skipping any taken id). Change both or neither.
- **The payload holds `bridge.py` at its root and the package under `threedstep/`**: every `.py`, `.toml`, `.js`, `.css` and `.txt` except the designer and the server-side modules (`cli.py`, `serve.py`, `payload.py`, `stepconv.py`, `__main__.py`). The zip's comment is a digest of every member's name and bytes, and `payload_is_stale` compares it rather than mtimes. It is built beside the designer in a source checkout and in the per-user cache (`<cache>/threedstep/<hash of the package path>/`) for an installed package, exactly as PinConnect's.
- **Package data is listed by file type** in `pyproject.toml` (`designer/js/*.js` and so on), not with a recursive glob: older setuptools releases do not expand `**`, and the explicit list keeps the payload zip and bytecode caches out of the wheel. A new kind of file (a new folder or extension) needs a line there.
- **The designer only sees bundled themes.** A project naming its own `theme_dir` renders in the browser with the bundled theme of the same name, or the default; `bridge.generate` and `bridge.validate` return a warning saying so. Keep that reporting intact: without it the designer silently disagrees with the CLI.
- **The generated page can be driven from outside**, with PinConnect's contracts: `?theme=dark|light`, a `{pinconnectTheme: "dark"|"light"}` message (the key is PinConnect's on purpose, so one host script drives both tools), or the same-origin parent's `data-md-color-scheme` / `data-theme` / `dark` class, tracked live; else `prefers-color-scheme`. The theme-sync script in `renderer.py` is PinConnect's verbatim; keep it so. Height reporting (`{mdIframeHeight: h}` for md-iframe) lives in the viewer's `boot()`, not in the renderer.
- **Behaviors reach the viewer two ways**: CSS variables (`--panel-max`, `--font-scale`, `--view-aspect`, `--view-min-h`, `--view-max-h`) plus the panel stacking media query, and a `data-*` attribute on `.tds` for every behavior key (`transition_ms` is `data-transition-ms`; booleans are `"true"` / `"false"`). The project's `style` is `data-style`.

## The STEP converter (`3dstep[step]`)

- **The extra.** `pip install "3dstep[step]"` adds `cadquery-ocp-novtk` (OCP 8.0, the Python bindings of OpenCascade 8.0: wheels for CPython 3.11 to 3.14 on Windows, Linux and macOS, 48 to 68 MB each, about 170 MB installed). On Python 3.9 and 3.10 the extra installs nothing and `3dstep model.step` says what is missing. Nothing but the convert mode imports OCP: rendering, the designer and the payload never need it.
- **The parity rule.** The converter repeats the designer's import step by step, so the same STEP file gives the same tree, ids, labels, colors and primitives on both sides, and a project TOML the designer wrote validates against the GLB the command line writes. `read_step` walks the file the way occt-import-js 0.0.23 does (its `importer-xcaf.cpp` and `importer-utils.cpp`: free shapes in label order, the mesh-node rule that flattens everything below the first level of components, names and colors found through `XCAFDoc_ShapeTool::Search` and followed through references, located shapes, the bounding-box-ratio deflection) and `build_model` is a port of `buildModel` in `designer/js/import/step-import.js` (groups, merged or split bodies, labels, ids assigned before the size filter, one primitive per color). The default output name is the designer's too (`glb_name_for`: `ToqueCAN 2.step` becomes `toquecan_2.glb`). Change both sides together; the local `tests/test_stepconv.py` compares them on the fixtures.
- **Mesh bytes differ between the two importers.** occt-import-js is built on OpenCascade 7.6 and OCP on 8.0, and their meshers do not always split a face the same way: the small fixtures get the same vertex and triangle counts but not always the same triangles, and `ToqueCAN.step` gets 14% more triangles from OCP (150 of its 541 bodies differ). Commit the GLB the designer wrote; use the converter in pipelines that regenerate GLBs from STEP files, not where a byte-identical file is expected.
- **OpenCascade prints to stdout** through its default messenger. `read_step` swaps the messenger's printer for a temporary file while it reads, so the command prints only its own lines, and quotes the reader's last messages when a file cannot be read.

## Old names

None: 3DStep has had one name from the start.

## Common commands

Install for development and run the designer (Python 3.9+):

```bash
pip install -e .
3dstep                       # builds the payload, picks a port, opens a browser
3dstep --port 8000 --no-browser
```

Render a project:

```bash
3dstep examples/demo/demo.toml          # writes examples/demo/demo.3dstep.html
3dstep examples/demo/demo.toml -t slate -o demo-slate.html
```

Convert a STEP model (needs `pip install "3dstep[step]"`, Python 3.11+):

```bash
3dstep model.step --quality fine        # writes model.glb
3dstep "ToqueCAN 2.step" --min-size 2   # writes toquecan_2.glb, the name the designer gives it
```

Build the designer's payload by hand (only needed to serve `src/threedstep/designer/` some other way):

```bash
python -m threedstep.payload --force
```

Nothing needs regenerating after editing a theme: the designer reads it through the bridge, and `3dstep` rebuilds the payload whenever the package changes, including when a file is **removed**.

## Documentation

The docs will live in [doctools-docs](https://github.com/xbst/doctools-docs) (a sibling checkout, `..\doctools-docs`), the Zensical site shared with PinConnect and md-iframe, under `docs/3dstep/`. Topics shared by every tool (publishing from CI, light and dark mode, theming) are under its `docs/guides/`.

- **A behavior change here usually needs a docs change there.** Make it in doctools-docs in step with the code change, as a commit in that repository, and mention it in this one's commit message.

## Conventions

- **Docs use one line per paragraph.** GitHub's Markdown viewer soft-wraps, so do not hard-wrap prose in the README, this file or doctools-docs.
- **Code, comments and docs are US English.** Prose uses `colors`, `behaviors`, `gray`, `labeled`, matching the TOML keys users type.
- **Commit messages** are a short imperative sentence ("Add the step panel", "Fix the edge pass on Safari"), no conventional-commit prefixes.
- **Generated and ephemeral files are git-ignored** through a local-only `.gitignore` (it ignores itself, as in PinConnect, so a fresh clone or worktree has none: copy it in). Never commit `*.3dstep.html`, `src/threedstep/designer/threedstep.zip`, `tests/`, `venv/` or `tools/vendor/cache/`.
- **No new runtime dependencies without reason.** `3dstep` relies only on the standard library (`tomllib`, with a `tomli` fallback below 3.11); the optional `step` extra is the one exception, imported lazily by the convert mode only. The designer and the viewer are dependency-free at runtime apart from the vendored, committed libraries and Pyodide from a CDN.

## Verifying changes

- After editing `renderer.py`, `config.py` or a theme, render `examples/demo/demo.toml` and open the HTML to look at the result, standalone and in light and dark (`?theme=dark`).
- After editing a theme or the bridge, restart `3dstep` and confirm the designer still lists and applies what you changed.
- After changing packaging, build a wheel (`python -m build`) and list it: it should hold exactly `threedstep/**` plus metadata, with no zip and no tests.
- **Tests are not committed** (`tests/` and `test_*.py` are git-ignored), so a fresh clone has none. A working copy may still have `tests/`: if they are present, run `python -m pytest tests` (and `node --test tests/js/` for the JavaScript) before finishing, and add cases for new behavior. Never `git add` a test file.
- Beyond that, validate by generating output and viewing it.
