"""Offline Ant0 Browser binary discovery and install-integrity helpers."""

import json
import os
import shutil
import sys

from ._errors import SdkRuntimeError
from .release import platform_release

ANT0_CAPABILITY = b"ant0-browser-capabilities/persona-profile-v1"
_capability_checked = set()


def _contains_capability(path):
    """Return whether a native module contains the compiled Ant0 SDK marker. Raises ``OSError`` when the file
    cannot be read (a lock, an antivirus scan, permissions): that says nothing about the binary."""
    overlap = len(ANT0_CAPABILITY) - 1
    previous = b""
    with open(path, "rb") as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                return False
            data = previous + block
            if ANT0_CAPABILITY in data:
                return True
            previous = data[-overlap:]


def _is_ant0_binary(exe):
    """Whether the binary (or its chrome.dll) carries the marker. Raises ``OSError`` when a file cannot be
    read, so a locked file is never taken for a foreign build (callers let the spawn decide)."""
    resolved = os.path.realpath(exe)
    paths = [resolved]
    sibling = os.path.join(os.path.dirname(resolved), "chrome.dll")
    if os.path.isfile(sibling):
        paths.append(sibling)
    identity = tuple(
        (path, os.stat(path).st_size, os.stat(path).st_mtime_ns) for path in paths
    )
    if identity in _capability_checked:
        return True
    if any(_contains_capability(path) for path in paths):
        _capability_checked.add(identity)
        return True
    return False


def incompatible_binary_error(exe):
    return RuntimeError(
        "The selected executable is not a compatible Ant0 Browser build:\n"
        f"    {exe}\n"
        "Required SDK capability persona-profile-v1 was not found. "
        "Refusing to launch arbitrary Chrome/Chromium."
    )


def _log(quiet, msg):
    if not quiet:
        sys.stderr.write(f"[ant0-browser] {msg}\n")


def _cache_root():
    env = os.environ.get("ANT0_BROWSER_CACHE")
    if env:
        return env
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
        return os.path.join(base, "ant0-browser", "Cache")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~/Library/Caches"), "ant0-browser")
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "ant0-browser")


def _find(dirpath, name):
    name = name.lower()
    for root, _dirs, files in os.walk(dirpath):
        for filename in files:
            if filename.lower() == name:
                return os.path.join(root, filename)
    return None


MANIFEST = ".manifest.json"
CRITICAL_FILES = {
    "win32": ["chrome.exe", "chrome.dll", "chrome_elf.dll", "icudtl.dat",
              "snapshot_blob.bin", "resources.pak"],
    "other": ["icudtl.dat", "snapshot_blob.bin", "resources.pak"],
}
_scanned = set()


def _critical_names():
    return CRITICAL_FILES["win32" if sys.platform == "win32" else "other"]


def _write_manifest(base, browser_dir):
    files = {}
    for root, _dirs, names in os.walk(browser_dir):
        for name in names:
            path = os.path.join(root, name)
            try:
                files[os.path.relpath(path, browser_dir).replace("\\", "/")] = os.path.getsize(path)
            except OSError:
                pass
    try:
        with open(os.path.join(base, MANIFEST), "w", encoding="utf-8") as handle:
            json.dump({"files": files}, handle)
    except OSError:
        pass


def _check_names(browser_dir, names, sizes=None):
    problems = []
    for name in names:
        path = os.path.join(browser_dir, name.replace("/", os.sep))
        try:
            got = os.path.getsize(path)
        except OSError:
            problems.append(f"{name} — missing")
            continue
        want = (sizes or {}).get(name)
        if want is not None and got != want:
            problems.append(f"{name} — {got:,} bytes, expected {want:,}")
        elif want is None and got == 0:
            problems.append(f"{name} — empty (0 bytes)")
    return problems


def verify_install(browser_dir, base=None, full=None):
    problems = _check_names(browser_dir, _critical_names())
    if problems:
        return problems
    manifest = os.path.join(base or os.path.dirname(browser_dir), MANIFEST)
    key = os.path.normcase(os.path.abspath(browser_dir))
    if full is False or (full is None and key in _scanned) or not os.path.exists(manifest):
        return problems
    try:
        with open(manifest, encoding="utf-8") as handle:
            sizes = (json.load(handle) or {}).get("files") or {}
    except (OSError, ValueError):
        return problems
    problems = _check_names(browser_dir, list(sizes), sizes)
    if not problems:
        _scanned.add(key)
    return problems


def broken_install_error(browser_dir, problems, repairable=True):
    shown = "\n".join(f"    {problem}" for problem in problems[:8])
    more = f"\n    ... and {len(problems) - 8} more" if len(problems) > 8 else ""
    fix = (
        f"Delete the damaged local cache folder and point the SDK at a complete local build:\n"
        f"    {os.path.dirname(browser_dir)}\n"
        if repairable else
        "Re-create this browser directory from a complete local build.\n"
    )
    return RuntimeError(
        f"Ant0 Browser browser install is incomplete or corrupted:\n    {browser_dir}\n"
        f"{shown}{more}\n\n{fix}"
        "Set executable_path or ANT0_BROWSER_BINARY to the resulting chrome executable.\n"
        "Common causes include antivirus quarantine, a full disk, or an interrupted copy."
    )


def check_install(exe):
    if not exe or not os.path.isfile(exe) or not _is_ant0_binary(exe):
        raise incompatible_binary_error(exe)
    browser_dir = os.path.dirname(os.path.abspath(exe))
    payload = [name for name in _critical_names() if not name.lower().startswith("chrome.ex")]
    if not any(os.path.exists(os.path.join(browser_dir, name)) for name in payload):
        return
    problems = verify_install(browser_dir)
    if problems:
        raise broken_install_error(browser_dir, problems, repairable=False)


def _cached(base, binary, quiet=False):
    if not os.path.exists(os.path.join(base, ".verified")):
        return None
    browser_dir = os.path.join(base, "browser")
    cached = _find(browser_dir, binary)
    if not cached:
        return None
    try:
        ant0 = _is_ant0_binary(cached)
    except OSError:
        return None  # unreadable right now (a lock, a scan): not proof that it is foreign, so nothing is deleted
    if not ant0:
        shutil.rmtree(browser_dir, ignore_errors=True)
        for marker in (".verified", MANIFEST):
            try:
                os.remove(os.path.join(base, marker))
            except OSError:
                pass
        return None
    problems = verify_install(browser_dir, base)
    if problems:
        _log(quiet, f"cached browser is damaged ({problems[0]}); removing it")
        shutil.rmtree(browser_dir, ignore_errors=True)
        for marker in (".verified", MANIFEST):
            try:
                os.remove(os.path.join(base, marker))
            except OSError:
                pass
        return None
    return cached


def ensure_binary(cache_dir=None, quiet=False):
    """Return the pinned-cache binary, installing it from a release store only when opted in.

    Without ``ANT0_BROWSER_RELEASE_URL`` this never touches the network. With it, a missing cache
    is filled from that store after the release signature and hashes verify; an existing cache is
    always used as-is (updates are an explicit action, see ``release_fetch.install_release``).
    """
    release = platform_release()
    base = os.path.join(cache_dir or _cache_root(), release["tag"]) if release else None
    if base:
        cached = _cached(base, release["binary"], quiet)
        if cached:
            return cached
    release_url = os.environ.get("ANT0_BROWSER_RELEASE_URL")
    if release_url and base:
        from .release_fetch import install_release

        exe = install_release(
            release_url, base, quiet=quiet,
            version=os.environ.get("ANT0_BROWSER_RELEASE_VERSION") or None,
            channel=os.environ.get("ANT0_BROWSER_RELEASE_CHANNEL") or None,
        )
        check_install(exe)
        return exe
    raise SdkRuntimeError("sdk.engine_not_found", 
        "No local Ant0 Browser binary was found. Build the browser first, then pass "
        "executable_path=... or set ANT0_BROWSER_BINARY to chrome/chrome.exe. To install a published "
        "release instead, set ANT0_BROWSER_RELEASE_URL to your release store."
    )
