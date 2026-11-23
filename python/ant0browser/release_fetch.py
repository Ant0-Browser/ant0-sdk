"""Fetch, verify, and install a published Ant0 Browser release.

Opt-in: nothing here runs unless ``ANT0_BROWSER_RELEASE_URL`` is set (or ``install_release`` is
called explicitly). The base URL points at an Ant0 release store laid out by
``scripts/publish_release.py``::

    <base>/channels/<channel>.json                  -> which version a channel currently serves
    <base>/releases/<version>/manifest.json
    <base>/releases/<version>/SHA256SUMS.txt
    <base>/releases/<version>/SHA256SUMS.txt.minisig
    <base>/releases/<version>/<target>/<archive>

Trust chain: ``SHA256SUMS.txt`` is verified against the minisign public key embedded in this SDK
(``release.RELEASE_PUBLIC_KEY``); the manifest and the archive are then verified against the
hashes it lists. Anything served by the store is untrusted until that chain closes.
"""

import base64
import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from .release import RELEASE_PUBLIC_KEY, platform_release
from ._errors import Coded, ENVIRONMENT

USER_AGENT = "ant0-browser-sdk/python"
CHANNEL_SCHEMA = "ant0-release-channel/v1"
MANIFEST_SCHEMA = "ant0-release-manifest/v1"
TARGET_FOR_PLATFORM = {"win32": "windows-x64", "linux": "linux-x64"}


class ReleaseError(Coded, RuntimeError):
    code = "sdk.release_failed"
    error_class = ENVIRONMENT


class SignatureError(ReleaseError):
    code = "sdk.release_signature_invalid"


# --------------------------------------------------------------------------------------------
# Ed25519 verification (RFC 8032). Prefers the audited `cryptography` package; falls back to a
# compact pure-Python implementation. Verification only: no private keys are ever handled here.
# --------------------------------------------------------------------------------------------

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _inv(x):
    return pow(x, _P - 2, _P)


def _edwards_add(p, q):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % _P
    b = (y1 + x1) * (y2 + x2) % _P
    c = 2 * t1 * t2 * _D % _P
    d = 2 * z1 * z2 % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _scalar_mult(point, scalar):
    result = (0, 1, 1, 0)
    while scalar:
        if scalar & 1:
            result = _edwards_add(result, point)
        point = _edwards_add(point, point)
        scalar >>= 1
    return result


def _decode_point(raw):
    if len(raw) != 32:
        raise SignatureError("bad point length")
    y = int.from_bytes(raw, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _P:
        raise SignatureError("point y out of range")
    y2 = y * y % _P
    u, v = (y2 - 1) % _P, (_D * y2 + 1) % _P
    x2 = u * _inv(v) % _P
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P:
        x = x * _I % _P
    if (x * x - x2) % _P:
        raise SignatureError("point not on curve")
    if x & 1 != sign:
        x = _P - x
    return (x, y, 1, x * y % _P)


def _encode_point(p):
    x, y, z, _t = p
    zi = _inv(z)
    x, y = x * zi % _P, y * zi % _P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


_BASE = _decode_point(bytes([0x58] + [0x66] * 31))


def _ed25519_verify_pure(public_key, signature, message):
    if len(signature) != 64 or len(public_key) != 32:
        return False
    r = signature[:32]
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        return False
    try:
        a = _decode_point(public_key)
        r_point = _decode_point(r)
    except SignatureError:
        return False
    k = int.from_bytes(hashlib.sha512(r + public_key + message).digest(), "little") % _L
    left = _scalar_mult(_BASE, s)
    right = _edwards_add(r_point, _scalar_mult(a, k))
    return _encode_point(left) == _encode_point(right)


def ed25519_verify(public_key, signature, message):
    """Return True when ``signature`` over ``message`` is valid for the raw 32-byte public key."""
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        return _ed25519_verify_pure(public_key, signature, message)
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


# --------------------------------------------------------------------------------------------
# minisign format
# --------------------------------------------------------------------------------------------

def parse_minisign_public_key(text):
    """Return (key_id, raw_public_key) from a minisign public key string or file content."""
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    encoded = lines[-1] if lines else ""
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise SignatureError("minisign public key is not valid base64") from None
    if len(raw) != 42 or raw[:2] != b"Ed":
        raise SignatureError("unrecognized minisign public key format")
    return raw[2:10], raw[10:]


def verify_minisign(message, signature_text, public_key_text):
    """Verify a minisign signature file over ``message`` bytes. Raises SignatureError on failure."""
    key_id, public_key = parse_minisign_public_key(public_key_text)
    lines = signature_text.splitlines()
    if len(lines) < 4:
        raise SignatureError("minisign signature file is truncated")
    try:
        sig_blob = base64.b64decode(lines[1].strip(), validate=True)
        global_sig = base64.b64decode(lines[3].strip(), validate=True)
    except ValueError:
        raise SignatureError("minisign signature is not valid base64") from None
    if len(sig_blob) != 74 or len(global_sig) != 64:
        raise SignatureError("minisign signature has unexpected length")
    alg, sig_key_id, signature = sig_blob[:2], sig_blob[2:10], sig_blob[10:]
    if sig_key_id != key_id:
        raise SignatureError("signature was made with a different key than the SDK trusts")
    if alg == b"ED":
        signed = hashlib.blake2b(message, digest_size=64).digest()
    elif alg == b"Ed":
        signed = message
    else:
        raise SignatureError("unsupported minisign algorithm")
    if not ed25519_verify(public_key, signature, signed):
        raise SignatureError("SHA256SUMS.txt signature does not verify: the release is not authentic")
    trusted_prefix = "trusted comment: "
    if not lines[2].startswith(trusted_prefix):
        raise SignatureError("minisign trusted comment missing")
    trusted_comment = lines[2][len(trusted_prefix):].encode("utf-8")
    if not ed25519_verify(public_key, global_sig, signature + trusted_comment):
        raise SignatureError("minisign trusted comment signature does not verify")
    return lines[2][len(trusted_prefix):]


def parse_sums(text):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        digest, _, name = line.partition("  ")
        if len(digest) != 64 or not name:
            raise ReleaseError("malformed SHA256SUMS.txt")
        out[name.strip()] = digest.lower()
    return out


# --------------------------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------------------------

def _join(base, path):
    return base.rstrip("/") + "/" + path.lstrip("/")


def _open(url, timeout=60):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        raise ReleaseError(f"{url}: HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        raise ReleaseError(f"{url}: {exc.reason}") from None


def fetch_bytes(url, limit=8 * 1024 * 1024):
    with _open(url) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ReleaseError(f"{url}: response larger than {limit} bytes")
    return data


def fetch_json(url):
    try:
        return json.loads(fetch_bytes(url).decode("utf-8"))
    except ValueError:
        raise ReleaseError(f"{url}: not valid JSON") from None


def resolve_release(base_url, version=None, channel=None):
    """Return (version, manifest_url_prefix) after consulting the channel pointer if needed."""
    if not version:
        channel = channel or os.environ.get("ANT0_BROWSER_RELEASE_CHANNEL") or "stable"
        doc = fetch_json(_join(base_url, f"channels/{channel}.json"))
        if doc.get("schema") != CHANNEL_SCHEMA or not doc.get("version"):
            raise ReleaseError(f"channel {channel!r} document is not a recognized Ant0 release channel")
        version = doc["version"]
    return version, _join(base_url, f"releases/{version}")


def download_to(url, dest, expected_sha256, log):
    digest = hashlib.sha256()
    with _open(url, timeout=120) as response, open(dest, "wb") as handle:
        total = response.headers.get("Content-Length")
        total = int(total) if total and total.isdigit() else None
        done = 0
        next_report = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            handle.write(block)
            digest.update(block)
            done += len(block)
            if total and done >= next_report:
                log(f"downloading {os.path.basename(url)}: {done * 100 // total}%")
                next_report += max(total // 10, 1)
    if digest.hexdigest() != expected_sha256.lower():
        raise ReleaseError(f"{os.path.basename(url)}: SHA-256 mismatch after download; refusing to install")


def _safe_extract_path(dest, name):
    target = os.path.realpath(os.path.join(dest, name))
    if not (target == os.path.realpath(dest) or target.startswith(os.path.realpath(dest) + os.sep)):
        raise ReleaseError(f"archive entry escapes destination: {name!r}")
    return target


def extract_archive(archive, dest):
    os.makedirs(dest, exist_ok=True)
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                target = _safe_extract_path(dest, info.filename)
                if info.is_dir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
    elif archive.endswith((".tar.xz", ".txz")):
        with tarfile.open(archive, "r:xz") as tf:
            for member in tf.getmembers():
                if not (member.isfile() or member.isdir()):
                    raise ReleaseError(f"unsupported archive entry type: {member.name!r}")
                _safe_extract_path(dest, member.name)
            if hasattr(tarfile, "data_filter"):
                tf.extractall(dest, filter="data")
            else:
                tf.extractall(dest)
    else:
        raise ReleaseError(f"unsupported archive type: {archive}")


def install_release(base_url, install_base, *, version=None, channel=None, target=None, quiet=False,
                    public_key=None, expected_chromium=None):
    """Download, verify, and unpack a release into ``<install_base>/browser``.

    Returns the path to the browser executable. ``install_base`` is the per-release cache
    directory (``<cache>/<release.tag>``); the caller decides where that is. ``public_key``
    defaults to the key embedded in this SDK and exists only so tests can substitute a test key.
    """
    from .download import _write_manifest

    def log(msg):
        if not quiet:
            sys.stderr.write(f"[ant0-browser] {msg}\n")

    public_key = public_key or RELEASE_PUBLIC_KEY
    release = platform_release()
    target = target or TARGET_FOR_PLATFORM.get(sys.platform)
    if not target or not release:
        raise ReleaseError(f"no Ant0 Browser release target for platform {sys.platform!r}")
    version, prefix = resolve_release(base_url, version=version, channel=channel)
    log(f"resolving release {version} from {base_url}")

    sums_text = fetch_bytes(_join(prefix, "SHA256SUMS.txt")).decode("utf-8")
    sig_text = fetch_bytes(_join(prefix, "SHA256SUMS.txt.minisig")).decode("utf-8")
    verify_minisign(sums_text.encode("utf-8"), sig_text, public_key)
    sums = parse_sums(sums_text)

    manifest_bytes = fetch_bytes(_join(prefix, "manifest.json"))
    if hashlib.sha256(manifest_bytes).hexdigest() != sums.get("manifest.json"):
        raise ReleaseError("manifest.json does not match the signed SHA256SUMS.txt")
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("version") != version:
        raise ReleaseError("manifest.json is not a recognized Ant0 release manifest for this version")
    expected_chromium = expected_chromium or release["version"]
    if manifest.get("chromium") != expected_chromium:
        raise ReleaseError(
            f"release {version} is Chromium {manifest.get('chromium')} but this SDK expects "
            f"{expected_chromium}; upgrade the SDK or pin ANT0_BROWSER_RELEASE_VERSION"
        )
    entry = (manifest.get("targets") or {}).get(target)
    if not entry:
        raise ReleaseError(f"release {version} has no {target} artifact")
    if sums.get(entry["file"]) != entry["sha256"]:
        raise ReleaseError("manifest target hash does not match the signed SHA256SUMS.txt")

    os.makedirs(install_base, exist_ok=True)
    browser_dir = os.path.join(install_base, "browser")
    with tempfile.TemporaryDirectory(dir=install_base, prefix=".download-") as tmp:
        archive = os.path.join(tmp, os.path.basename(entry["file"]))
        download_to(_join(prefix, entry["file"]), archive, entry["sha256"], log)
        staging = os.path.join(tmp, "browser")
        extract_archive(archive, staging)
        exe = _find_binary(staging, release["binary"])
        if not exe:
            raise ReleaseError(f"{release['binary']} not found in the downloaded archive")
        if os.path.isdir(browser_dir):
            shutil.rmtree(browser_dir)
        os.replace(staging, browser_dir)
    _write_manifest(install_base, browser_dir)
    with open(os.path.join(install_base, ".verified"), "w", encoding="utf-8") as handle:
        handle.write(f"{version}\n")
    with open(os.path.join(install_base, ".release.json"), "w", encoding="utf-8") as handle:
        json.dump({"version": version, "chromium": manifest["chromium"], "target": target, "source": base_url}, handle)
    log(f"installed Ant0 Browser {version} ({target})")
    return _find_binary(browser_dir, release["binary"])


def _find_binary(root, name):
    name = name.lower()
    for dirpath, _dirs, files in os.walk(root):
        for filename in files:
            if filename.lower() == name:
                return os.path.join(dirpath, filename)
    return None
