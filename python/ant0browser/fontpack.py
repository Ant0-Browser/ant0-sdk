"""Font pack (retired).

Earlier versions could locate, download or cache a pack of real Windows fonts. Those fonts may not
be redistributed, so the SDK no longer fetches, caches or applies any pack: Windows profiles on
Linux use the bundled open look-alike fonts only. The names below are kept so existing imports keep
working; ``resolve_font_pack`` always returns ``None``.
"""

import os
import subprocess

PACK_VERSION = "windows-v1"  # deprecated: kept for import compatibility
_FONT_EXTS = (".ttf", ".ttc", ".otf")


def resolve_font_pack(quiet=False, download=True):
    """Deprecated: always returns ``None``.

    The SDK no longer downloads, caches or applies a font pack, and ``ANT0_BROWSER_FONT_PACK`` is
    ignored. The bundled look-alike fonts are used.
    """
    return None


def pack_families(pack_dir):
    """Lower-cased family names in the pack (cached in ``families.txt``; fc-scan once if missing)."""
    if not pack_dir:
        return frozenset()
    manifest = os.path.join(pack_dir, "families.txt")
    try:
        if os.path.isfile(manifest):
            with open(manifest, encoding="utf-8") as handle:
                return frozenset(line.strip().lower() for line in handle if line.strip())
    except OSError:
        pass
    fams = set()
    try:
        files = [os.path.join(pack_dir, n) for n in os.listdir(pack_dir) if n.lower().endswith(_FONT_EXTS)]
        proc = subprocess.run(["fc-scan", "--format", "%{family}\n", *files],
                              capture_output=True, text=True, timeout=60)
        for line in proc.stdout.splitlines():
            for part in line.split(","):
                part = part.strip().lower()
                if part:
                    fams.add(part)
        if fams:
            with open(manifest, "w", encoding="utf-8") as handle:
                handle.write("\n".join(sorted(fams)) + "\n")
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    return frozenset(fams)


__all__ = ["resolve_font_pack", "pack_families", "PACK_VERSION"]
