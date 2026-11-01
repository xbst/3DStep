"""Command-line interface: the ``3dstep`` command.

The positional argument picks the mode: none opens the designer, a ``.toml``
project renders a page, a ``.step`` / ``.stp`` model converts to a GLB (with the
optional ``3dstep[step]`` dependency). Flags that belong to another mode are
usage errors rather than silently ignored.
"""
from __future__ import annotations

import argparse
import math
import os
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


def _same_file(a: Path, b: Path) -> bool:
    """Whether two paths name one existing file. Comparing the paths would miss
    a case variant, a short name or a link on Windows; samefile does not."""
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _check_not_a_folder(out_path: Path, default_name: str) -> None:
    """Refuse an output path that names a folder. Opening one fails with
    "Permission denied" on Windows, which reads like a permissions problem."""
    if out_path.is_dir():
        _error(f"the output is a folder, not a file: {out_path} "
               f"(give a file name, such as {out_path / default_name})")


def _render_inputs(project_path: Path, theme_name: str) -> list[tuple[str, Path]]:
    """The files a render reads that an output path must not replace: the
    project, every model it names, and the theme file, if one was found."""
    from .config import _BUNDLED_THEMES, load_project

    project = load_project(project_path)
    inputs = [("the project file", project_path)]
    inputs += [("a model it names", (project_path.parent / m).resolve())
               for m in project.assembly.models]
    # The same search load_theme makes: the project's theme_dir, then the bundled themes.
    name = theme_name or project.assembly.theme
    inputs += [("the theme file", p) for p in (
        (project_path.parent / project.assembly.theme_dir).resolve() / f"{name}.toml",
        _BUNDLED_THEMES / f"{name}.toml",
    ) if name]
    return inputs


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

    default_name = project_path.with_suffix(".3dstep.html").name
    out_path: Path = args.output or project_path.parent / default_name
    _check_not_a_folder(out_path, default_name)
    # build_page has read every input already, so writing over one would succeed
    # and silently destroy the author's project, model or theme.
    for what, source in _render_inputs(project_path, args.theme or ""):
        if _same_file(out_path, source):
            _error(f"the output would overwrite {what}: {source}")
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
    if not step_path.is_file():
        _error(f"STEP file not found: {step_path}")
    # The name the designer gives the same import, so a project it wrote finds
    # the GLB this regenerates.
    default_name = stepconv.glb_name_for(step_path)
    out_path: Path = args.output or step_path.with_name(default_name)
    _check_not_a_folder(out_path, default_name)
    if _same_file(out_path, step_path):
        _error(f"the output would overwrite the STEP file: {step_path}")
    try:
        result = stepconv.write(
            step_path, out_path,
            min_size=args.min_size or 0.0,
            merge_bodies=args.merge_bodies is not False,
            **stepconv.tessellation(args.quality, args.deflection, args.angle),
        )
    except MemoryError:
        _error(f"out of memory while converting {step_path.name}: use --quality coarse, "
               "or split the assembly into smaller STEP files")
    except (ValueError, OSError) as e:
        _error(e)
    print(f"Wrote {out_path}  ({result.parts} part{'s' * (result.parts != 1)}, "
          f"{result.triangles} triangles, {result.size / 1048576:.2f} MB)")


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
        help="Output file.  Defaults to <stem>.3dstep.html beside a project, or "
             "beside a model the GLB name the designer gives it (My Board.step: "
             "my_board.glb).",
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
        help="Convert only: the largest distance between a surface and its "
             "triangles, instead of the preset's share of each model's size.",
    )
    parser.add_argument(
        "--angle",
        type=float,
        default=None,
        metavar="DEG",
        help="Convert only: the largest angle between neighboring triangles, "
             "instead of the preset's.",
    )
    parser.add_argument(
        "--min-size",
        type=float,
        default=None,
        metavar="MM",
        help="Convert only: drop bodies whose bounding-box diagonal is smaller "
             "(ids stay the same).",
    )
    parser.add_argument(
        "--merge-bodies",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Convert only: one part per product, its bodies merged (the "
             "default), or one part per body.",
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
        "--merge-bodies": args.merge_bodies is True,
        "--no-merge-bodies": args.merge_bodies is False,
    }
    return [name for name in names if flags[name]]


def _verb(flags: list[str], one: str, many: str) -> str:
    return f"{' and '.join(flags)} {one if len(flags) == 1 else many}"


_DESIGNER_FLAGS = ("--port", "--no-browser")
_RENDER_FLAGS = ("--theme",)
_CONVERT_FLAGS = ("--quality", "--deflection", "--angle", "--min-size", "--merge-bodies",
                  "--no-merge-bodies")


def _check_convert_values(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.quality is not None and (args.deflection is not None or args.angle is not None):
        parser.error("--quality is a preset for --deflection and --angle: give one or the other")
    if args.deflection is not None and not (math.isfinite(args.deflection) and args.deflection > 0):
        parser.error(f"--deflection must be a positive number of millimeters, got {args.deflection:g}")
    if args.angle is not None and not (math.isfinite(args.angle) and 0 < args.angle < 180):
        parser.error(f"--angle must be between 0 and 180 degrees, got {args.angle:g}")
    if args.min_size is not None and not (math.isfinite(args.min_size) and args.min_size >= 0):
        parser.error(f"--min-size must be zero or a positive number of millimeters, got {args.min_size:g}")


def main(argv: list[str] | None = None) -> None:
    """The ``3dstep`` command: open the designer, render a project, or convert a model."""
    # A piped stdout on Windows (a CI log, `> log.txt`) gets the ANSI code page
    # with strict errors, so printing a path it cannot encode (a CJK folder)
    # would fail after the page was written. Escape such characters instead,
    # as Python already does on stderr.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
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
    _check_convert_values(parser, args)
    _convert(args)


if __name__ == "__main__":
    main()
