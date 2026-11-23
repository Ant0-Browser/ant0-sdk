"""Canvas mode per profile, and the per-profile canvas noise key.

Two modes:

* ``real``  this computer's genuine canvas output. Every profile on this computer shows the same
  canvas result. This is the default.
* ``noise`` a canvas result that is unique to the profile, stable across launches and across sites.
  Needs a 16-hex key; the engine takes it as ``--fingerprint-noise-key=<key>``.

Mapping of the options onto the mode (``canvas_mode``)::

    canvas    canvas_noise   fingerprint_noise   mode
    "real"    any            any                 real
    "noise"   any            any                 noise (the key is required)
    unset     any            any                 real

Only ``canvas="noise"`` selects noise. The legacy ``canvas_noise`` and ``fingerprint_noise`` flags never
do: on earlier releases ``True`` sent nothing and ``False`` sent ``--disable-canvas-noise`` /
``--disable-fingerprint-noise``, and a profile that already existed must not change its fingerprint on
upgrade. They keep exactly that behaviour; ``True`` now also gets the ``canvas-noise-no-key`` warning.
"""

import hashlib
import re
import secrets

from ._errors import SdkValueError

#: The engine switch that carries the key. One constant so the spelling is a one-line change.
CANVAS_NOISE_KEY_SWITCH = "--fingerprint-noise-key"
#: The key is exactly this many lowercase hex characters (8 bytes), with no 0x prefix.
CANVAS_NOISE_KEY_LENGTH = 16
#: Domain separator for the key derived for older identity files (v1 and v2 wrappers), which store none.
CANVAS_NOISE_KEY_DOMAIN = b"ant0/canvas-noise-key/v1\0"

_KEY_RE = re.compile(r"[0-9a-f]{16}")


def is_canvas_noise_key(value):
    """True when ``value`` is a valid canvas noise key: 16 lowercase hex characters."""
    return isinstance(value, str) and _KEY_RE.fullmatch(value) is not None


def assert_canvas_option(canvas):
    if canvas is not None and canvas not in ("real", "noise"):
        raise SdkValueError("sdk.canvas_invalid", 'canvas must be "real" or "noise"')


def assert_canvas_noise_key(key):
    if key is not None and not is_canvas_noise_key(key):
        raise SdkValueError("sdk.canvas_invalid", "canvas_noise_key must be 16 lowercase hex characters")


def canvas_mode(opts):
    """Resolve the canvas mode from an options mapping (see the table at the top of this file)."""
    canvas = opts.get("canvas")
    assert_canvas_option(canvas)
    if canvas is not None:
        return canvas
    return "real"


def new_canvas_noise_key():
    """A fresh random canvas noise key (CSPRNG, 8 bytes as 16 lowercase hex)."""
    return secrets.token_hex(8)


def derive_canvas_noise_key(identity_key):
    """The key for an identity stored without one: the first 8 bytes of
    SHA-256("ant0/canvas-noise-key/v1\\0" + identity_key), as 16 lowercase hex. ``identity_key`` is the
    string the caller gave as ``identity["key"]``; it is hashed as UTF-8."""
    if not isinstance(identity_key, str):
        raise SdkValueError("sdk.canvas_invalid", "identity_key must be a string")
    return hashlib.sha256(CANVAS_NOISE_KEY_DOMAIN + identity_key.encode("utf-8")).digest()[:8].hex()


def canvas_noise_key_for(persisted, identity_key):
    """The canvas noise key of a persisted identity: its stored ``canvas_noise_key``, else the key
    derived from ``identity_key``. The wrapper does not record the identity key (its file name is an
    HMAC of it), so the caller passes it."""
    stored = (persisted or {}).get("canvas_noise_key")
    if stored is not None:
        if not is_canvas_noise_key(stored):
            raise SdkValueError("sdk.canvas_invalid", "stored canvas_noise_key is not 16 lowercase hex characters")
        return stored
    return derive_canvas_noise_key(identity_key)


__all__ = [
    "CANVAS_NOISE_KEY_SWITCH", "CANVAS_NOISE_KEY_LENGTH", "CANVAS_NOISE_KEY_DOMAIN",
    "is_canvas_noise_key", "canvas_mode", "new_canvas_noise_key", "derive_canvas_noise_key",
    "canvas_noise_key_for",
]
