"""Local build metadata used for cache lookup and compatibility warnings."""

import sys

from .chromium_version import CHROMIUM_VERSION

# minisign public key that signs every published Ant0 Browser release (SHA256SUMS.txt.minisig).
# Downloads are refused unless the signature verifies against this key. The private key lives
# only on the release build server. Rotating it requires an SDK release.
RELEASE_PUBLIC_KEY = "RWTvXmwMqczy1xMs5KJs+qS9x7LmikRzIX+la3WGmWIFEKvQvR1JW8d9"

_WINDOWS = {
    "tag": "ant0-m" + CHROMIUM_VERSION,
    "version": CHROMIUM_VERSION,
    "os": "win32",
    "binary": "chrome.exe",
}
_LINUX = {
    "tag": "ant0-m" + CHROMIUM_VERSION,
    "version": CHROMIUM_VERSION,
    "os": "linux",
    "binary": "chrome",
}

PLATFORMS = {"win32": _WINDOWS, "linux": _LINUX}


def platform_release(plat=None):
    """Return local build metadata for a supported platform."""
    return PLATFORMS.get(plat or sys.platform)


RELEASE = platform_release() or _WINDOWS
