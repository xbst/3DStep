# Vendored JavaScript

3DStep ships its third-party JavaScript as committed files, so neither users nor the hosted designer build or download anything at runtime (Pyodide, and occt-import-js on the hosted designer, come from a CDN as a first choice). This folder holds the pins and the build script that produce those files; it needs Python only, no Node or npm.

| File | What it is |
|---|---|
| `pins.json` | The exact npm versions, tarball URLs and SHA-256 hashes of `three`, `occt-import-js`, `meshoptimizer` and the `@esbuild/<platform>` binary packages |
| `entry.js` | The curated list of Three.js exports that make up the viewer bundle (`window.THREE`) |
| `build.py` | Downloads the tarballs into `cache/` (git-ignored), verifies them, runs the standalone esbuild binary and writes the outputs below |
| `cache/` | Downloads and unpacked packages; delete it to start over |

Outputs, all committed:

| Output | Source |
|---|---|
| `src/threedstep/viewer/vendor/three.bundle.js` | Three.js and the addons listed in `entry.js`, one minified IIFE with a banner line naming the version |
| `src/threedstep/viewer/vendor/three.bundle.LICENSE.txt` | Three.js's MIT license |
| `src/threedstep/designer/vendor/occt-import-js.js`, `.wasm` | The STEP importer (LGPL-2.1; OpenCASCADE is LGPL-2.1 with exception). The `.wasm` stays a separate file |
| `src/threedstep/designer/vendor/occt-import-js.LICENSE.txt`, `occt.LICENSE.txt` | Their licenses |
| `src/threedstep/designer/vendor/meshopt_simplifier.module.js` | meshoptimizer's simplifier as an ES module (MIT), used by the designer's Simplify |
| `src/threedstep/designer/vendor/meshopt_simplifier.LICENSE.txt` | Its license |

## When to rerun

- After changing a version in `pins.json` (update the tarball URL and the SHA-256 of the new tarball: download it, hash it, paste the hash; the script refuses a mismatch).
- After adding or removing a name in `entry.js`. The viewer and the designer may only use `THREE.<Name>` for names exported there; a local test checks that.
- Never at a user's runtime, and not in CI: the outputs are committed.

```
python tools/vendor/build.py
python tools/vendor/build.py --only three
python tools/vendor/build.py --offline
```

The script picks the esbuild binary for the current platform from the pinned packages (`win32-x64` and `linux-x64` are pinned; add another `@esbuild/<platform>` entry with its hash to build elsewhere). It prints the size of every output, raw and gzipped.

## Three.js r187 notes

- The npm package ships ES modules only (`build/three.module.js` plus `examples/jsm/`), which is why a bundle is built: the viewer is a classic script.
- The bundle targets ES2022 and WebGL 2 (Three.js dropped WebGL 1 in r163). The viewer shows its fallback when WebGL 2 is missing.
- Keep `entry.js` to what is used: every extra class costs size in every generated page.
