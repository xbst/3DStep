"""Command-line interface: the ``3dstep`` command.

The positional argument picks the mode: none opens the designer, a ``.toml``
project renders a page, a ``.step`` / ``.stp`` model converts to a GLB (with the
optional ``3dstep[step]`` dependency). Flags that belong to another mode are
usage errors rather than silently ignored.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__

_MODES = """\
modes:
  3dstep                  open the designer in a browser
  3dstep assembly.toml    render assembly.toml to assembly.3dstep.html
  3dstep model.step       convert model.step to model.glb (needs 3dstep[step])
"""

_QUALITIES = ("fine", "normal", "coarse")


def _error(message: object, code: int = 1) -> None:
    """Print a runtime problem as ``Error:`` lines and exit. A message with
    several lines (one per unknown id, say) gets the prefix on each."""
    for line in str(message).splitlines() or [""]:
        print(f"Error: {line}", file=sys.stderr)
    sys.exit(code)


def _serve_designer(port: int, open_browser: bool) -> None:
    from .serve import serve
    try:
        serve(port, open_browser=open_browser)
    except (FileNotFoundError, ValueError, OSError) as e:
        # A bad port, an unwritable install and a missing designer all
        # deserve a message rather than a traceback.
        _error(e)


def _render(args: argparse.Namespace) -> None:
    from .renderer import build_page

    project_path: Path = args.file.resolve()
    if not project_path.exists():
        _error(f"project file not found: {project_path}")
    try:
        page = build_page(project_path, theme_name=args.theme or "")
    except (ValueError, OSError) as e:
        # OSError covers more than a missing file: a project path that is a
        # directory, or one the user cannot read.
        _error(e)
    for warning in page.warnings:
        print(f"Warning: {warning}", file=sys.stderr)

    out_path: Path = args.output or project_path.with_suffix(".3dstep.html")
    # Write LF explicitly. Text mode translates to CRLF on Windows, so the same
    # project rendered on two machines would produce two different files, and
    # the designer (which always writes LF) would disagree with the CLI.
    # Path.write_text only grew a newline argument in 3.10, and this supports 3.9.
    try:
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(page.html)
    except OSError as e:
        # A missing output directory is the common case; -o says it must exist.
        _error(f"cannot write output file: {out_path}: {e}")
    size = len(page.html.encode("utf-8")) / 1048576
    print(f"Generated: {out_path}  ({page.steps} step{'s' * (page.steps != 1)}, "
          f"{page.parts} part{'s' * (page.parts != 1)}, {size:.2f} MB)")


def _convert(args: argparse.Namespace) -> None:
    try:
        from . import stepconv
    except ImportError:
        _error('STEP conversion needs the optional dependency: pip install "3dstep[step]"')

    step_path: Path = args.file.resolve()
    if not step_path.exists():
        _error(f"STEP file not found: {step_path}")
    out_path: Path = args.output or step_path.with_suffix(".glb")
    try:
        parts, triangles = stepconv.convert(
            step_path, out_path,
            quality=args.quality, deflection=args.deflection, angle=args.angle,
            min_size=args.min_size, merge_bodies=args.merge_bodies,
        )
    except (ValueError, OSError) as e:
        _error(e)
    size = out_path.stat().st_size / 1048576
    print(f"Wrote {out_path}  ({parts} part{'s' * (parts != 1)}, {triangles} triangles, "
          f"{size:.2f} MB)")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="3dstep",
        # Wrapped by hand: the raw formatter keeps the epilog's columns, and
        # it applies to the description too.
        description="Render a project TOML to an interactive page of 3D assembly "
                    "instructions\nfor documentation sites.  Without a file, open "
                    "the visual designer that\nwrites one.",
        epilog=_MODES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "file",
        nargs="?",
        type=Path,
        default=None,
        help="A .toml project to render, or a .step / .stp model to convert.",
    )
    parser.add_argument(
        "-o", "--output",
        type=Path,
        default=None,
        metavar="OUT",
        help="Output file.  Defaults to <stem>.3dstep.html (render) or "
             "<stem>.glb (convert) beside the input.",
    )
    parser.add_argument(
        "-t", "--theme",
        default=None,
        metavar="NAME",
        help="Render only: the theme to apply, overriding [assembly] theme.  "
             "Resolved from the project's theme_dir, then the bundled themes.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        metavar="N",
        help="Designer only: serve on this port.  Without it, a free port is chosen.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Designer only: do not open a browser window.",
    )
    parser.add_argument(
        "--quality",
        choices=_QUALITIES,
        default=None,
        help="Convert only: the tessellation preset (default: normal).",
    )
    parser.add_argument(
        "--deflection",
        type=float,
        default=None,
        metavar="MM",
        help="Convert only: linear deflection instead of a preset.",
    )
    parser.add_argument(
        "--angle",
        type=float,
        default=None,
        metavar="DEG",
        help="Convert only: angular deflection instead of a preset.",
    )
    parser.add_argument(
        "--min-size",
        type=float,
        default=None,
        metavar="MM",
        help="Convert only: drop bodies whose bounding-box diagonal is smaller.",
    )
    parser.add_argument(
        "--merge-bodies",
        action="store_true",
        help="Convert only: merge every body under a product into one part.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"3dstep {__version__}",
    )
    return parser


def _given(args: argparse.Namespace, names: tuple[str, ...]) -> list[str]:
    flags = {
        "--output": args.output is not None,
        "--theme": args.theme is not None,
        "--port": args.port is not None,
        "--no-browser": args.no_browser,
        "--quality": args.quality is not None,
        "--deflection": args.deflection is not None,
        "--angle": args.angle is not None,
        "--min-size": args.min_size is not None,
        "--merge-bodies": args.merge_bodies,
    }
    return [name for name in names if flags[name]]


def _verb(flags: list[str], one: str, many: str) -> str:
    return f"{' and '.join(flags)} {one if len(flags) == 1 else many}"


_DESIGNER_FLAGS = ("--port", "--no-browser")
_RENDER_FLAGS = ("--theme",)
_CONVERT_FLAGS = ("--quality", "--deflection", "--angle", "--min-size", "--merge-bodies")


def main(argv: list[str] | None = None) -> None:
    """The ``3dstep`` command: open the designer, render a project, or convert a model."""
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.file is None:
        flags = _given(args, ("--output",) + _RENDER_FLAGS + _CONVERT_FLAGS)
        if flags:
            parser.error(f"{_verb(flags, 'needs', 'need')} a .toml project or a .step model")
        _serve_designer(args.port or 0, open_browser=not args.no_browser)
        return

    suffix = args.file.suffix.lower()
    if suffix not in (".toml", ".step", ".stp"):
        parser.error("expected a .toml project or a .step model")
    designer = _given(args, _DESIGNER_FLAGS)
    if designer:
        parser.error(f"{_verb(designer, 'applies', 'apply')} only to the designer, "
                     "which opens when no file is given")
    if suffix == ".toml":
        convert = _given(args, _CONVERT_FLAGS)
        if convert:
            parser.error(f"{_verb(convert, 'applies', 'apply')} only to converting a .step model")
        _render(args)
        return

    render = _given(args, _RENDER_FLAGS)
    if render:
        parser.error(f"{_verb(render, 'applies', 'apply')} only to rendering a .toml project")
    if args.quality is not None and (args.deflection is not None or args.angle is not None):
        parser.error("--quality is a preset for --deflection and --angle: give one or the other")
    _convert(args)


if __name__ == "__main__":
    main()
