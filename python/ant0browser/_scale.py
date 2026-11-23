"""Persona scale (see ``persona_dpr`` in :mod:`ant0browser._fingerprint`): the pieces around
``--force-device-scale-factor``.

- A Playwright ``viewport`` emulates scale 1 and breaks the match, so a caller viewport gets the
  persona's ``device_scale_factor`` unless it set its own.
- The engine sizes the window from the persona in CSS px and the flag multiplies it, so a persona
  scale above the real display's draws wider than the screen. A headed window is clamped to the real
  display divided by the scale.

Mirror of the Node SDK's ``src/scale.ts``.
"""
from __future__ import annotations

import math
import os
import re
import subprocess
import sys

_WINDOW_FLAGS = ("--window-size", "--start-maximized", "--start-fullscreen", "--kiosk")
_UNSET = object()
_cached_display = _UNSET


def with_device_scale(kwargs, dpr):
    """Return ``kwargs`` with ``device_scale_factor`` added when it carries a viewport but no scale of
    its own. The input is not modified."""
    if dpr is None:
        return kwargs
    viewport = kwargs.get("viewport")
    if not isinstance(viewport, dict) or kwargs.get("device_scale_factor") is not None:
        return kwargs
    return {**kwargs, "device_scale_factor": dpr}


def _size(width, height):
    try:
        w, h = int(width), int(height)
    except (TypeError, ValueError):
        return None
    return (w, h) if w > 0 and h > 0 else None


def parse_display_size(text):
    """Parse ``xrandr --current`` or ``xdpyinfo`` output into ``(width, height)``, or None."""
    m = re.search(r"current\s+(\d+)\s*x\s*(\d+)", text) or re.search(r"dimensions:\s+(\d+)x(\d+)\s+pixels", text)
    return _size(m.group(1), m.group(2)) if m else None


def detect_display_size(platform=None):
    """``ANT0_DISPLAY_SIZE=WIDTHxHEIGHT`` (real pixels) wins; otherwise the X11 screen on Linux. Windows
    and macOS are not detected: the caller (the app) passes ``--window-size`` there. Never raises."""
    global _cached_display
    m = re.fullmatch(r"(\d+)x(\d+)", os.environ.get("ANT0_DISPLAY_SIZE", "").strip(), re.I)
    if m:
        return _size(m.group(1), m.group(2))
    if (platform or sys.platform) != "linux" or not os.environ.get("DISPLAY"):
        return None
    if _cached_display is _UNSET:
        _cached_display = None
        for cmd in (["xrandr", "--current"], ["xdpyinfo"]):
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=2)
            except (OSError, subprocess.SubprocessError):
                continue
            size = parse_display_size(r.stdout) if r.returncode == 0 else None
            if size:
                _cached_display = size
                break
    return _cached_display


def clamped_window_size(dpr, display, persona=None):
    """``(width, height)`` in CSS px that keeps a headed window on ``display`` real pixels at scale
    ``dpr``, or None when no clamp is needed. ``persona`` is the persona's own ``(width, height)``."""
    if not display or not dpr or not dpr > 1:
        return None
    max_w, max_h = math.floor(display[0] / dpr), math.floor(display[1] / dpr)
    pw, ph = persona if persona else (None, None)
    if pw is not None and ph is not None and pw <= max_w and ph <= max_h:
        return None
    return (min(max_w, pw) if pw is not None else max_w, min(max_h, ph) if ph is not None else max_h)


def scale_window_args(sdk_args, dpr, headed, persona=None, caller_args=(), display=_UNSET):
    """Clamp the SDK's own window size for a headed launch at persona scale ``dpr``.

    Takes the SDK-built args (before the caller's ``args`` are appended, so a caller's own
    ``--window-size`` still wins); ``caller_args`` is only checked for a size or maximise flag. An
    existing ``--window-size`` in ``sdk_args`` (the Android phone size) is the persona size to
    clamp; otherwise ``persona``, the persona's available screen.
    """
    out = list(sdk_args)
    if not headed or dpr is None:
        return out
    if any(str(a).split("=", 1)[0] in _WINDOW_FLAGS for a in caller_args):
        return out
    if display is _UNSET:
        display = detect_display_size()
    own = None
    for a in out:
        m = re.fullmatch(r"--window-size=(\d+),(\d+)", str(a))
        if m:
            own = (int(m.group(1)), int(m.group(2)))
    size = clamped_window_size(dpr, display, own or persona)
    if not size:
        return out
    return [a for a in out if not str(a).startswith("--window-size=")] + [f"--window-size={size[0]},{size[1]}"]
