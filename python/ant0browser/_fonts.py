"""Linux font wiring.

Two modes, chosen at launch:

* PACK MODE (retired: no pack is ever supplied now, kept for callers that pass one): point
  fontconfig at the real Windows fonts so a page asking for "Segoe UI" / "Calibri" / "Cambria" …
  renders the *real* font with correct metrics, and the persona's font list actually reaches ~200
  families like a genuine Windows box. The clone-substitution rules are DROPPED here so real Arial
  is not replaced by a metric clone.

* CLONE MODE (fallback, no pack): the release bundles metric-compatible clones (Segoe UI->Selawik,
  Arial->Arimo, Times New Roman->Tinos, …) under ``<bin_dir>/fonts/`` with a self-contained
  ``fonts.conf.template``; a bare host still renders the common families instead of collapsing to a
  single default.

At launch we materialize a config into a writable cache dir and point FONTCONFIG_FILE at it. No-op
on non-Linux and on older binaries that ship no ``fonts/`` and have no pack.
"""

import os
import sys
import tempfile


def _cache_dir():
    d = os.path.join(tempfile.gettempdir(), "ant0-fc-cache")
    os.makedirs(d, exist_ok=True)
    return d


def _xml(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


_RENDER_DEFAULTS = (
    '  <match target="font"><edit name="antialias" mode="assign"><bool>true</bool></edit></match>\n'
    '  <match target="font"><edit name="hinting" mode="assign"><bool>true</bool></edit></match>\n'
    '  <match target="font"><edit name="hintstyle" mode="assign"><const>hintslight</const></edit></match>\n'
    '  <match target="font"><edit name="rgba" mode="assign"><const>rgb</const></edit></match>\n'
    '  <match target="font"><edit name="lcdfilter" mode="assign"><const>lcddefault</const></edit></match>\n'
)


def _pack_conf(pack_dir, clones_dir, cache_dir):
    """A fontconfig that serves the REAL Windows fonts (correct metrics), with the bundled clones as
    a fallback for any family not in the pack. No forced Windows->clone substitution."""
    dirs = f"  <dir>{_xml(pack_dir)}</dir>\n"
    if clones_dir and os.path.isdir(clones_dir):
        dirs += f"  <dir>{_xml(clones_dir)}</dir>\n"
    return (
        '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n'
        + dirs
        + f"  <cachedir>{_xml(cache_dir)}</cachedir>\n"
        '  <alias><family>sans-serif</family><prefer><family>Segoe UI</family><family>Arial</family></prefer></alias>\n'
        '  <alias><family>serif</family><prefer><family>Times New Roman</family></prefer></alias>\n'
        '  <alias><family>monospace</family><prefer><family>Consolas</family><family>Courier New</family></prefer></alias>\n'
        '  <alias><family>system-ui</family><prefer><family>Segoe UI</family></prefer></alias>\n'
        '  <alias><family>-webkit-standard</family><prefer><family>Segoe UI</family></prefer></alias>\n'
        + _RENDER_DEFAULTS
        + "</fontconfig>\n"
    )


def linux_font_env(exe_path, pack_dir=None):
    """Return ``{"FONTCONFIG_FILE": ...}`` on Linux (pack mode if ``pack_dir`` given, else clone
    mode from the bundled template), or ``{}`` when there is nothing to wire."""
    if sys.platform != "linux":
        return {}
    clones_dir = os.path.join(os.path.dirname(exe_path), "fonts")
    template = os.path.join(clones_dir, "fonts.conf.template")
    try:
        cache_dir = _cache_dir()
        if pack_dir and os.path.isdir(pack_dir):
            conf = _pack_conf(pack_dir, clones_dir, cache_dir)
            conf_path = os.path.join(cache_dir, "fonts.pack.conf")
            with open(conf_path, "w", encoding="utf-8") as fh:
                fh.write(conf)
            return {"FONTCONFIG_FILE": conf_path}
        if not os.path.isfile(template):
            return {}
        with open(template, "r", encoding="utf-8") as fh:
            conf = fh.read()
        conf = conf.replace("@FONTS_DIR@", clones_dir).replace("@CACHE_DIR@", cache_dir)
        conf_path = os.path.join(clones_dir, "fonts.generated.conf")
        with open(conf_path, "w", encoding="utf-8") as fh:
            fh.write(conf)
        return {"FONTCONFIG_FILE": conf_path}
    except OSError:
        return {}  # never block a launch on font wiring


def apply_font_env(exe_path, pw_kwargs, pack_dir=None):
    """Merge the FONTCONFIG_FILE (pack or clones) into ``pw_kwargs['env']`` for Playwright's launch.

    Playwright replaces the child env when ``env`` is set, so we include ``os.environ`` too.
    Precedence: os.environ < font wiring < caller-supplied env. No-op when there's nothing to add.
    """
    font_env = linux_font_env(exe_path, pack_dir)
    user_env = pw_kwargs.get("env")
    if not font_env and not user_env:
        return
    merged = dict(os.environ)
    merged.update(font_env)
    if user_env:
        merged.update(user_env)
    pw_kwargs["env"] = merged
