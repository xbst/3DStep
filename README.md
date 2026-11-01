# 3DStep

Step-by-step interactive 3D assembly instructions for documentation sites. 3DStep turns a CAD assembly (STEP) into a page where each instruction shows the parts it installs, moves them into place and frames them from a good angle, and the reader can rotate the model to look closer. It renders one self-contained HTML file you can open in a browser or embed in an MkDocs or Zensical site.

<!-- Demo GIF: added with the documentation. -->

Documentation is coming at **<https://doctools.isiks.tech/3dstep/>**.

## Quick start

1. Open the designer at **<https://3dstep.isiks.tech>**, import your STEP file, and build the steps: which parts show, where they move from, what is highlighted, arrows, labels, a camera and a text per step. Save the project: a `.toml` file and one `.glb` per imported model, kept side by side.
2. Install the command line tool (Python 3.9 or later) and render the project to one HTML file:

   ```bash
   pip install "git+https://github.com/xbst/3DStep.git"
   3dstep assembly.toml
   ```

   This writes `assembly.3dstep.html` beside the TOML. `3dstep` with no file opens the designer locally.
3. Embed the page in an MkDocs or Zensical site with [md-iframe](https://github.com/xbst/md-iframe) (`markdown_extensions: [attr_list, md_iframe]`), which sizes the frame to the page and keeps it in step with the site's light and dark mode:

   ```markdown
   ![Assembly](assembly.3dstep.html){ type=iframe }
   ```

`examples/pican2/` is a finished project to start from: `3dstep examples/pican2/pican2.toml`.

## License

This project is licensed under GPL-3.0. See [LICENSE](LICENSE).

If you'd like to support the development of this and other open-source projects, you can donate on [GitHub Sponsors](https://github.com/sponsors/xbst/) or [Patreon](https://patreon.com/isikstech).
