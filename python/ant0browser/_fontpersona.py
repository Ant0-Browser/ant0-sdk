"""Host reachability checks for canonical persona font lists.

WHY FONTS AND NOT SOMETHING ELSE. Measured over the capture corpus, the font set is the most
identifying surface by a wide margin -- 9.45 bits of entropy, and 35.0% of real machines carry a
font set nobody else has. The WebGL renderer string is 7.25 bits / 1.7% unique, screen width
3.29 bits / 1.4%. Canvas and GPU put a machine in a bucket; a font list frequently names it.

WHAT THE ENGINE ALREADY DOES. For every family a page asks for, Blink decides present/absent in
FontCache::GetFontPlatformData (Blink's font cache, in the persona
block). It picks a reference list -- the canonical per-OS set
(GetPlatformFonts) or, when a profile was imported, THAT PROFILE'S OWN font list
-- and reports anything outside it absent. What the page finally sees is therefore
host INTERSECT list: a listed font that is not installed still fails to load and measures
absent, so a list can never over-claim.

Canonical v2 identities already carry a complete font list. This module only reports how much of
that list the current host can actually render so coherence warnings can identify poor host/profile
matches.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any, Optional

_host_families: Optional[frozenset] = None
_host_families_done = False


# --------------------------------------------------------------------------------------- host

def _families_windows() -> Optional[frozenset]:
    try:
        import winreg
    except ImportError:
        return None
    names = []
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            key = winreg.OpenKey(
                hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")
        except OSError:
            continue
        try:
            for i in range(winreg.QueryInfoKey(key)[1]):
                names.append(winreg.EnumValue(key, i)[0])
        except OSError:
            pass
    if not names:
        return None
    fams = set()
    for value in names:
        # "Segoe UI Semibold (TrueType)", "Arial Bold & Arial Bold Italic (TrueType)"
        value = re.sub(r"\s*\((?:TrueType|OpenType|VGA res|All res)[^)]*\)\s*$", "", value)
        for part in value.split("&"):
            part = part.strip()
            if part:
                fams.add(part.lower())
    return frozenset(fams)


def _families_fontconfig() -> Optional[frozenset]:
    try:
        proc = subprocess.run(["fc-list", ":", "family"], capture_output=True,
                              text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    fams = set()
    for line in proc.stdout.splitlines():
        for part in line.split(","):
            part = part.strip()
            if part:
                fams.add(part.lower())
    return frozenset(fams) or None


def host_font_families() -> Optional[frozenset]:
    """Lower-cased family names installed on THIS host, or None when it cannot be determined.

    Windows reads the font registry (no subprocess); Linux/BSD shells out to fc-list once.
    macOS returns None deliberately: the cheap enumerations there (globbing the font
    directories) give file names rather than family names, and the accurate one
    (`system_profiler SPFontsDataType`) takes seconds -- too slow for a launch path. Callers
    must treat None as "unknown", never as "no fonts".
    """
    global _host_families, _host_families_done
    if _host_families_done:
        return _host_families
    _host_families_done = True
    try:
        if sys.platform == "win32":
            _host_families = _families_windows()
        elif sys.platform == "darwin":
            _host_families = None
        else:
            _host_families = _families_fontconfig()
    except Exception:
        _host_families = None
    return _host_families


#: Families the engine lets through regardless of the reference list -- IsBasicFont(),
#: They resolve on every OS, so they are always reachable.
_BASIC = frozenset(x.lower() for x in (
    "-webkit-standard", "system-ui", "Arial", "Courier New", "Courier", "Helvetica",
    "Helvetica Neue", "Roboto", "Sans", "Times New Roman", "Times", "cursive", "fantasy",
    "monospace", "sans-serif", "serif", "math", "BlinkMacSystemFont"))


_STYLE = re.compile(
    r"\b(bold|italic|oblique|light|semibold|semilight|medium|black|thin|regular|condensed|cond|"
    r"narrow|heavy|demibold|extrabold|extralight|ultralight|book|roman)\b")


def _base_family(name: str) -> str:
    """Family name with trailing style words stripped ('Arial Bold' -> 'arial'), so a style
    variant counts as reachable when its base family is installed/in the pack."""
    return re.sub(r"\s+", " ", _STYLE.sub("", name.lower())).strip()


def reachable_count(claimed, families) -> int:
    """How many of `claimed` can actually render here (families INTERSECT list, plus basics).

    Matches a claimed family or its style-stripped base against `families` (also expanded to base
    forms), because the engine reports a listed font absent only when the family truly is not
    installed -- 'Arial Bold' renders wherever 'Arial' does.
    """
    fam = set(families)
    fam |= {_base_family(f) for f in fam}
    n = 0
    for f in claimed:
        low = str(f).lower()
        if low in _BASIC or low in fam or _base_family(low) in fam:
            n += 1
    return n


# -------------------------------------------------------------------------------- coherence

def profile_fonts(value) -> list:
    """Canonical ``fonts.families`` from a v2 profile dict/path/JSON string."""
    try:
        if isinstance(value, dict):
            obj = value
        elif isinstance(value, (bytes, bytearray)):
            obj = json.loads(value)
        elif isinstance(value, (str, os.PathLike)) and os.path.isfile(value):
            with open(value, encoding="utf-8") as handle:
                obj = json.load(handle)
        else:
            obj = json.loads(value)
    except (ValueError, OSError, TypeError):
        return []
    if not isinstance(obj, dict):
        return []
    families = (obj.get("fonts") or {}).get("families")
    return [f for f in families if isinstance(f, str)] if isinstance(families, list) else []


def font_reachability(profile: Any, extra_families=None) -> Optional[tuple]:
    """``(claimed, reachable)`` for a canonical profile, or None when it cannot be judged.

    ``extra_families`` folds in fonts the SDK is about to wire that the host does not natively have
    -- e.g. the real Windows font pack on Linux (see ``fontpack.py``) -- so the coherence warning
    reflects what the launched browser will actually render, not the bare host. When the pack is
    wired the reachable count jumps to ~the full list and the warning auto-resolves.
    """
    claimed = profile_fonts(profile)
    if not claimed:
        return None
    families = set()
    host = host_font_families()
    if host:
        families |= host
    if extra_families:
        families |= set(extra_families)
    if not families and host is None:
        return None
    return len(claimed), reachable_count(claimed, families)
