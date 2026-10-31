"""Build the vendored JavaScript that 3DStep commits (maintainer tool).

Standard library only: no Node, no npm.  It downloads the npm tarballs pinned
in ``pins.json`` into ``tools/vendor/cache/`` (git-ignored), checks their
SHA-256, unpacks them, runs the standalone esbuild binary from the
``@esbuild/<platform>`` package on ``entry.js`` and writes:

    src/threedstep/viewer/vendor/three.bundle.js          Three.js + addons as one IIFE exposing window.THREE
    src/threedstep/viewer/vendor/three.bundle.LICENSE.txt
    src/threedstep/designer/vendor/occt-import-js.js      the STEP importer (LGPL-2.1) and its .wasm
    src/threedstep/designer/vendor/occt-import-js.wasm
    src/threedstep/designer/vendor/occt-import-js.LICENSE.txt
    src/threedstep/designer/vendor/occt.LICENSE.txt       OpenCASCADE's license (LGPL-2.1 with exception)
    src/threedstep/designer/vendor/meshopt_simplifier.module.js   meshoptimizer's simplifier (ES module, MIT)
    src/threedstep/designer/vendor/meshopt_simplifier.LICENSE.txt

Run it from anywhere::

    python tools/vendor/build.py            # download what is missing, build everything
    python tools/vendor/build.py --offline  # fail instead of downloading
    python tools/vendor/build.py --only three   # one package (three, occt-import-js, meshoptimizer)

Rerun it after changing ``pins.json`` or ``entry.js``, then commit the outputs.
Users of 3DStep never run this: the outputs are committed.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE / "cache"
PINS_FILE = HERE / "pins.json"
ENTRY = HERE / "entry.js"
VIEWER_VENDOR = ROOT / "src" / "threedstep" / "viewer" / "vendor"
DESIGNER_VENDOR = ROOT / "src" / "threedstep" / "designer" / "vendor"

BUNDLE_NAME = "three.bundle.js"
BUNDLE_LICENSE = "three.bundle.LICENSE.txt"


def log(msg: str) -> None:
    print(msg, flush=True)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(name: str, pin: dict, offline: bool) -> Path:
    """Return the verified tarball for ``pin``, downloading it when missing."""
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / f"{name}-{pin['version']}.tgz"
    if not target.exists():
        if offline:
            raise SystemExit(f"Error: {target.name} is not in the cache and --offline was given")
        log(f"Downloading {pin['tarball']}")
        tmp = target.with_suffix(".part")
        with urllib.request.urlopen(pin["tarball"]) as resp, tmp.open("wb") as out:
            shutil.copyfileobj(resp, out)
        tmp.replace(target)
    digest = sha256_of(target)
    if digest != pin["sha256"]:
        target.unlink()
        raise SystemExit(
            f"Error: SHA-256 mismatch for {target.name}: expected {pin['sha256']}, got {digest} "
            "(the file was deleted; check pins.json or the registry)"
        )
    return target


def extract(tarball: Path, dest: Path) -> Path:
    """Unpack the npm tarball's ``package/`` folder into ``dest`` (replacing it)."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tarball, "r:gz") as tar:
        members = [m for m in tar.getmembers() if m.name.startswith("package/")]
        for m in members:
            if m.islnk() or m.issym() or ".." in Path(m.name).parts:
                raise SystemExit(f"Error: refusing to unpack {m.name} from {tarball.name}")
        try:
            tar.extractall(dest.parent, members=members, filter="data")
        except TypeError:  # Python without the extraction filter (before 3.8.17)
            tar.extractall(dest.parent, members=members)
    (dest.parent / "package").rename(dest)
    return dest


def platform_key() -> str:
    machine = platform.machine().lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, machine)
    system = {"win32": "win32", "linux": "linux", "darwin": "darwin"}.get(sys.platform, sys.platform)
    return f"{system}-{arch}"


def esbuild_binary(pins: dict, offline: bool) -> Path:
    key = platform_key()
    platforms = pins["esbuild"]["platforms"]
    if key not in platforms:
        raise SystemExit(
            f"Error: no esbuild pin for {key}; add the @esbuild/{key} package to pins.json "
            f"(pinned: {', '.join(sorted(platforms))})"
        )
    pin = dict(platforms[key], version=pins["esbuild"]["version"])
    tarball = fetch(f"esbuild-{key}", pin, offline)
    folder = extract(tarball, CACHE / "pkg" / f"esbuild-{key}")
    binary = folder / Path(pin["binary"]).relative_to("package")
    if os.name != "nt":
        binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return binary


def banner(pins: dict) -> str:
    three = pins["three"]["version"]
    esb = pins["esbuild"]["version"]
    return (
        f"/* three@{three} (three.js r{three.split('.')[1]}), MIT license, https://threejs.org. "
        f"Bundled for 3DStep by tools/vendor/build.py with esbuild {esb}; "
        f"the exports are listed in tools/vendor/entry.js, the license in {BUNDLE_LICENSE}. */"
    )


def build_three(pins: dict, offline: bool) -> None:
    pin = pins["three"]
    tarball = fetch("three", pin, offline)
    modules = CACHE / "node_modules"
    extract(tarball, modules / "three")
    exe = esbuild_binary(pins, offline)
    VIEWER_VENDOR.mkdir(parents=True, exist_ok=True)
    out = VIEWER_VENDOR / BUNDLE_NAME
    # esbuild resolves bare imports through node_modules next to the entry file,
    # so the entry is copied beside the cache's node_modules folder.
    entry = CACHE / "entry.js"
    shutil.copyfile(ENTRY, entry)
    cmd = [
        str(exe), entry.name,
        "--bundle", "--format=iife", "--global-name=THREE", "--minify",
        "--target=es2022", "--legal-comments=none", "--charset=utf8",
        f"--banner:js={banner(pins)}",
        f"--outfile={out}",
    ]
    log(f"Running esbuild {pins['esbuild']['version']} on {ENTRY.relative_to(ROOT)}")
    proc = subprocess.run(cmd, cwd=str(CACHE), capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"Error: esbuild failed with exit code {proc.returncode}")
    if proc.stderr.strip():
        log(proc.stderr.strip())
    license_text = (modules / "three" / "LICENSE").read_text(encoding="utf-8")
    (VIEWER_VENDOR / BUNDLE_LICENSE).write_text(
        f"three.js {pin['version']} (https://threejs.org), bundled into {BUNDLE_NAME} by tools/vendor/build.py.\n"
        "The bundle contains the Three.js core and the addons listed in tools/vendor/entry.js,\n"
        "all under the MIT license below.\n\n" + license_text,
        encoding="utf-8", newline="\n",
    )
    report(out)


def build_occt(pins: dict, offline: bool) -> None:
    pin = pins["occt-import-js"]
    folder = extract(fetch("occt-import-js", pin, offline), CACHE / "pkg" / "occt-import-js")
    DESIGNER_VENDOR.mkdir(parents=True, exist_ok=True)
    dist = folder / "dist"
    for src, dst in (
        (dist / "occt-import-js.js", "occt-import-js.js"),
        (dist / "occt-import-js.wasm", "occt-import-js.wasm"),
        (dist / "license.occt-import-js.txt", "occt-import-js.LICENSE.txt"),
        (dist / "license.occt.txt", "occt.LICENSE.txt"),
    ):
        shutil.copyfile(src, DESIGNER_VENDOR / dst)
        report(DESIGNER_VENDOR / dst)


def build_meshopt(pins: dict, offline: bool) -> None:
    pin = pins["meshoptimizer"]
    folder = extract(fetch("meshoptimizer", pin, offline), CACHE / "pkg" / "meshoptimizer")
    DESIGNER_VENDOR.mkdir(parents=True, exist_ok=True)
    # meshoptimizer 1.x ships the simplifier as an ES module named
    # meshopt_simplifier.js; 3DStep keeps the explicit .module.js name.
    src = folder / "meshopt_simplifier.js"
    text = src.read_text(encoding="utf-8")
    if "export { MeshoptSimplifier }" not in text:
        raise SystemExit(f"Error: {src.name} is not the ES module build expected by the designer")
    shutil.copyfile(src, DESIGNER_VENDOR / "meshopt_simplifier.module.js")
    report(DESIGNER_VENDOR / "meshopt_simplifier.module.js")
    shutil.copyfile(folder / "LICENSE.md", DESIGNER_VENDOR / "meshopt_simplifier.LICENSE.txt")
    report(DESIGNER_VENDOR / "meshopt_simplifier.LICENSE.txt")


def report(path: Path) -> None:
    raw = path.stat().st_size
    with path.open("rb") as f:
        packed = len(gzip.compress(f.read(), compresslevel=6))
    log(f"  {path.relative_to(ROOT).as_posix():<58} {raw / 1024:8.1f} KB  ({packed / 1024:.1f} KB gzipped)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the vendored JavaScript for 3DStep.")
    parser.add_argument("--offline", action="store_true", help="use the cache only; never download")
    parser.add_argument("--only", choices=["three", "occt-import-js", "meshoptimizer"],
                        help="build one package instead of all three")
    args = parser.parse_args(argv)
    pins = json.loads(PINS_FILE.read_text(encoding="utf-8"))
    builders = {
        "three": build_three,
        "occt-import-js": build_occt,
        "meshoptimizer": build_meshopt,
    }
    for name, fn in builders.items():
        if args.only and args.only != name:
            continue
        log(f"{name} {pins[name]['version']}")
        fn(pins, args.offline)
    log("Done. Commit the files under src/threedstep/viewer/vendor/ and src/threedstep/designer/vendor/.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
