"""Headless context geometry defaults.

Persona, imported-profile, and direct available-area geometry is owned by the browser. The SDK only
disables Playwright's emulated viewport for those modes. A seedless headless launch still needs a
stable synthetic screen and matching viewport because there is no native display persona.
"""

import hashlib
import sys


ENGINE_FRAME_WIDTH = 16 if sys.platform == "win32" else 8
ENGINE_FRAME_HEIGHT = 134 if sys.platform == "win32" else 131

# (screen_width, screen_height, weight, os_hint)
HEADLESS_SCREEN_PROFILES = (
    (1920, 1080, 24, "windows"),
    (2560, 1440, 13, "windows"),
    (1920, 1200, 6, "linux"),
    (1366, 768, 3, "windows"),
    (1600, 900, 3, "linux"),
    (3440, 1440, 2, "windows"),
    (3840, 2160, 2, "windows"),
    (1680, 1050, 2, "windows"),
)

_CALLER_GEOMETRY_KEYS = ("viewport", "no_viewport", "screen")
_CALLER_WINDOW_FLAGS = ("--window-size", "--window-position", "--start-maximized")


def native_display_active(args):
    """Whether Chromium owns initial window geometry for this launch."""
    names = {str(arg).split("=", 1)[0] for arg in (args or [])}
    return (
        "--fingerprint" in names
        or "--fingerprint-profile" in names
        or {"--fingerprint-avail-width", "--fingerprint-avail-height"}.issubset(names)
    )


def caller_sized_the_window(args):
    """Whether the caller supplied command-line window geometry."""
    return any(str(arg).split("=", 1)[0] in _CALLER_WINDOW_FLAGS for arg in (args or []))


_DEFAULT_HEADLESS_GEOMETRY_SEED = "ant0-headless-geometry"


def _hash_point(seed):
    """Weighted-table point a seed maps to (full sha256 digest as an integer, mod the total weight)."""
    key = str(seed if seed not in (None, "") else _DEFAULT_HEADLESS_GEOMETRY_SEED)
    return int(hashlib.sha256(key.encode("utf-8")).hexdigest(), 16) % sum(
        row[2] for row in HEADLESS_SCREEN_PROFILES
    )


def _pick(seed):
    point = _hash_point(seed)
    for row in HEADLESS_SCREEN_PROFILES:
        point -= row[2]
        if point < 0:
            return row
    return HEADLESS_SCREEN_PROFILES[-1]


def headless_geometry(seed=None):
    """Return deterministic seedless-headless screen and viewport context options."""
    width, height, _weight, _os = _pick(seed)
    return {
        "screen": {"width": width, "height": height},
        "viewport": {
            "width": width - ENGINE_FRAME_WIDTH,
            "height": height - ENGINE_FRAME_HEIGHT,
        },
    }


def apply_headless_geometry(pw_kwargs, seed=None, args=None):
    """Apply context defaults in place, leaving explicit caller context geometry untouched."""
    if pw_kwargs.get("headless") is False:
        return None
    if any(key in pw_kwargs for key in _CALLER_GEOMETRY_KEYS):
        return None
    if native_display_active(args):
        pw_kwargs["no_viewport"] = True
        return {"mode": "native"}
    geom = headless_geometry(seed)
    pw_kwargs.update(geom)
    return {"mode": "corpus", **geom}


def initial_window_args(args, applied_geometry):
    """Place corpus headless windows at the origin before launch, unless the caller chose geometry."""
    result = list(args or [])
    if (applied_geometry and applied_geometry.get("mode") == "corpus"
            and not caller_sized_the_window(result)):
        result.append("--window-position=0,0")
    return result


def geometry_is_coherent(screen, avail, inner, outer):
    """Return whether ``inner <= outer <= avail <= screen`` on both axes."""
    return (
        inner[0] <= outer[0] and inner[1] <= outer[1]
        and outer[0] <= avail[0] and outer[1] <= avail[1]
        and avail[0] <= screen[0] and avail[1] <= screen[1]
    )
