"""Windows persona coherence rules for the local population-model generator (parity with
node/src/windows-coherence.ts and with the cloud generators).

Both rules come from tells a page can read without any permission:

* ANGLE writes the PCI device id into the WebGL renderer string as ``0x`` plus exactly 8 hex digits
  (``ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)``). A
  renderer without it cannot come from a real Chrome on Windows.
* A generated Windows persona claims Windows 11, whose taskbar is 48 CSS px tall, at the bottom (or
  absent when it auto-hides): ``availWidth`` equals ``width``, and ``height - availHeight`` is 48 or 0.
  A side taskbar is a Windows 10 tell.

The generator only draws rows that satisfy both: a graphics row without an id is not drawn (ids are
never made up), a display row with another work area is normalised to a 48 px bottom taskbar.
"""

import re
from typing import Any

_ANGLE_DEVICE_ID = re.compile(r"\(0x[0-9A-Fa-f]{8}\)")

# The Windows 11 taskbar height in CSS px (100, 125 and 150 % scaling).
WIN11_TASKBAR_PX = 48


def has_angle_device_id(renderer: Any) -> bool:
    """Whether a WebGL renderer string carries ANGLE's 8-digit device id."""
    return isinstance(renderer, str) and _ANGLE_DEVICE_ID.search(renderer) is not None


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_win11_taskbar_gap(height: Any, avail_height: Any) -> bool:
    """Whether the screen/available height gap is a Windows 11 taskbar: 48 px, or 0 (auto-hidden)."""
    if not (_is_number(height) and _is_number(avail_height)):
        return False
    gap = height - avail_height
    return gap == WIN11_TASKBAR_PX or gap == 0


def is_win11_screen(width: Any, height: Any, avail_width: Any, avail_height: Any) -> bool:
    """Whether a screen's work area is a Windows 11 one: a full-width bottom taskbar of 48 px, or none."""
    return (_is_number(width) and _is_number(avail_width) and avail_width == width
            and is_win11_taskbar_gap(height, avail_height))


def is_win11_display_row(payload: Any) -> bool:
    """Whether a display row of the population model passes the Windows 11 screen rule."""
    return is_win11_screen(payload.get("width"), payload.get("height"),
                           payload.get("available_width"), payload.get("available_height"))


def normalise_win11_display_row(payload: Any) -> Any:
    """The Windows 11 form of a display row, or None. The screen size and its weight are never touched:
    only the work area is normalised, so the size mix of the model survives.

    * already a full-width bottom 48 px taskbar, or none at all (genuine auto-hide): returned as is;
    * anything else (another gap, a side or top taskbar): a bottom taskbar of exactly 48 CSS px,
      ``available_width = width``, ``available_height = height - 48``.

    None only for a row with no numeric size or a screen too short to hold a taskbar.
    """
    width, height = payload.get("width"), payload.get("height")
    if not (_is_number(width) and _is_number(height)) or height <= WIN11_TASKBAR_PX:
        return None
    if is_win11_display_row(payload):
        return payload
    return {**payload, "available_width": width, "available_height": height - WIN11_TASKBAR_PX}
