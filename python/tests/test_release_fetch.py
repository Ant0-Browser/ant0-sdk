"""Release download trust chain: minisign signature over SHA256SUMS.txt, then hashes for the
manifest and archive. Every failure must refuse the install; nothing is trusted from the store."""

import base64
import hashlib
import io
import json
import os
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

from ant0browser import release_fetch
from ant0browser.release import RELEASE_PUBLIC_KEY, platform_release
from ant0browser.release_fetch import (
    ReleaseError,
    SignatureError,
    _ed25519_verify_pure,
    ed25519_verify,
    install_release,
    parse_minisign_public_key,
    verify_minisign,
)

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "release"

# RFC 8032 section 7.1 test vectors (public key, message, signature), hex.
RFC8032 = [
    ("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    ("fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
]


@pytest.mark.parametrize("pk,msg,sig", RFC8032)
def test_pure_python_ed25519_accepts_rfc8032_vectors(pk, msg, sig):
    assert _ed25519_verify_pure(bytes.fromhex(pk), bytes.fromhex(sig), bytes.fromhex(msg))


@pytest.mark.parametrize("pk,msg,sig", RFC8032)
def test_pure_python_ed25519_rejects_tampering(pk, msg, sig):
    bad_sig = bytearray(bytes.fromhex(sig)); bad_sig[0] ^= 1
    assert not _ed25519_verify_pure(bytes.fromhex(pk), bytes(bad_sig), bytes.fromhex(msg))
    assert not _ed25519_verify_pure(bytes.fromhex(pk), bytes.fromhex(sig), bytes.fromhex(msg) + b"x")


def test_dispatching_verifier_agrees_with_pure_python():
    pk, msg, sig = RFC8032[2]
    assert ed25519_verify(bytes.fromhex(pk), bytes.fromhex(sig), bytes.fromhex(msg))
    assert not ed25519_verify(bytes.fromhex(pk), bytes.fromhex(sig), b"other")


def test_embedded_release_key_parses():
    key_id, raw = parse_minisign_public_key(RELEASE_PUBLIC_KEY)
    assert len(key_id) == 8 and len(raw) == 32


def test_real_minisign_signature_from_release_key_verifies():
    """Independent check: a signature produced by the minisign tool with the production key."""
    message = (FIXTURES / "fixture.txt").read_bytes()
    sig = (FIXTURES / "fixture.txt.minisig").read_text(encoding="utf-8")
    assert verify_minisign(message, sig, RELEASE_PUBLIC_KEY) == "ant0 sdk fixture"


def test_real_minisign_signature_rejects_modified_message_and_comment():
    message = (FIXTURES / "fixture.txt").read_bytes()
    sig = (FIXTURES / "fixture.txt.minisig").read_text(encoding="utf-8")
    with pytest.raises(SignatureError, match="not authentic"):
        verify_minisign(message + b"\n", sig, RELEASE_PUBLIC_KEY)
    with pytest.raises(SignatureError, match="trusted comment"):
        verify_minisign(message, sig.replace("ant0 sdk fixture", "ant0 sdk fixturE"), RELEASE_PUBLIC_KEY)


def test_signature_from_other_key_is_rejected():
    message = (FIXTURES / "fixture.txt").read_bytes()
    sig = (FIXTURES / "fixture.txt.minisig").read_text(encoding="utf-8")
    other = base64.b64encode(b"Ed" + b"\x01" * 8 + b"\x02" * 32).decode()
    with pytest.raises(SignatureError, match="different key"):
        verify_minisign(message, sig, other)


# --------------------------------------------------------------------------------------------
# End-to-end install from a fake release store served over file://
# --------------------------------------------------------------------------------------------

class Signer:
    """Produces minisign-format signatures with an in-test Ed25519 key (prehashed 'ED' mode)."""

    def __init__(self):
        crypto = pytest.importorskip("cryptography.hazmat.primitives.asymmetric.ed25519")
        self._sk = crypto.Ed25519PrivateKey.generate()
        from cryptography.hazmat.primitives import serialization
        raw = self._sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self.key_id = b"\x11\x22\x33\x44\x55\x66\x77\x88"
        self.public_key = base64.b64encode(b"Ed" + self.key_id + raw).decode()

    def sign(self, message, trusted="test release"):
        sig = self._sk.sign(hashlib.blake2b(message, digest_size=64).digest())
        glob = self._sk.sign(sig + trusted.encode())
        return "\n".join([
            "untrusted comment: test", base64.b64encode(b"ED" + self.key_id + sig).decode(),
            f"trusted comment: {trusted}", base64.b64encode(glob).decode(), "",
        ])


def make_store(root, signer, *, chromium=None, version=None, tamper=None):
    """Lay out <root>/channels/stable.json + releases/<version>/... for the current platform."""
    release = platform_release()
    chromium = chromium or release["version"]
    version = version or f"{chromium}-ant0.3"
    target = release_fetch.TARGET_FOR_PLATFORM[sys.platform]
    marker = b"ant0-browser-capabilities/persona-profile-v1"
    files = {release["binary"]: b"MZ" + marker, "icudtl.dat": b"i" * 16, "snapshot_blob.bin": b"s" * 16,
             "resources.pak": b"r" * 16, "locales/en-US.pak": b"l" * 8}
    if sys.platform == "win32":
        files.update({"chrome.dll": marker, "chrome_elf.dll": b"e" * 8})
        name, buf = f"ant0-browser-{version}-windows-x64.zip", io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for path, data in files.items():
                zf.writestr(path, data)
    else:
        name, buf = f"ant0-browser-{version}-linux-x64.tar.xz", io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:xz") as tf:
            for path, data in files.items():
                info = tarfile.TarInfo(path); info.size = len(data); info.mode = 0o755 if path == release["binary"] else 0o644
                tf.addfile(info, io.BytesIO(data))
    archive = buf.getvalue()
    if tamper == "archive":
        archive = archive[:-1] + bytes([archive[-1] ^ 0xFF])

    rel = Path(root) / "releases" / version
    (rel / target).mkdir(parents=True)
    (rel / target / name).write_bytes(archive)
    manifest = {"schema": "ant0-release-manifest/v1", "version": version, "chromium": chromium, "ant0_build": 3,
                "targets": {target: {"file": f"{target}/{name}", "size": len(buf.getvalue()), "sha256": hashlib.sha256(buf.getvalue()).hexdigest(), "binary": release["binary"]}}}
    manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
    (rel / "manifest.json").write_bytes(manifest_bytes)
    sums = f"{hashlib.sha256(buf.getvalue()).hexdigest()}  {target}/{name}\n{hashlib.sha256(manifest_bytes).hexdigest()}  manifest.json\n"
    (rel / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    sig = signer.sign(sums.encode(), f"ant0-browser {version}")
    if tamper == "signature":
        sums = sums.replace("manifest.json", "manifest.jsoN")
        (rel / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    (rel / "SHA256SUMS.txt.minisig").write_text(sig, encoding="utf-8")
    (Path(root) / "channels").mkdir()
    (Path(root) / "channels" / "stable.json").write_text(json.dumps(
        {"schema": "ant0-release-channel/v1", "channel": "stable", "version": version, "chromium": chromium,
         "manifest": f"releases/{version}/manifest.json"}), encoding="utf-8")
    return Path(root).as_uri(), version


def test_install_release_end_to_end(tmp_path):
    signer = Signer()
    url, version = make_store(tmp_path / "store", signer)
    base = tmp_path / "cache" / "ant0-mtest"
    exe = install_release(url, str(base), quiet=True, public_key=signer.public_key)
    assert os.path.isfile(exe) and os.path.basename(exe) == platform_release()["binary"]
    assert (base / ".verified").read_text().strip() == version
    assert json.loads((base / ".release.json").read_text())["version"] == version
    assert (base / ".manifest.json").exists()
    assert (base / "browser" / "locales" / "en-US.pak").exists()


def test_install_release_uses_channel_pointer_then_pinned_version(tmp_path):
    signer = Signer()
    url, version = make_store(tmp_path / "store", signer)
    resolved, prefix = release_fetch.resolve_release(url)
    assert resolved == version and prefix.endswith(f"releases/{version}")
    resolved, _ = release_fetch.resolve_release(url, version="pinned-1")
    assert resolved == "pinned-1"


def test_install_refuses_bad_signature(tmp_path):
    signer = Signer()
    url, _ = make_store(tmp_path / "store", signer, tamper="signature")
    with pytest.raises(SignatureError):
        install_release(url, str(tmp_path / "cache"), quiet=True, public_key=signer.public_key)
    assert not (tmp_path / "cache" / "browser").exists()


def test_install_refuses_untrusted_key(tmp_path):
    url, _ = make_store(tmp_path / "store", Signer())
    with pytest.raises(SignatureError):
        install_release(url, str(tmp_path / "cache"), quiet=True, public_key=Signer().public_key)


def test_install_refuses_tampered_archive(tmp_path):
    signer = Signer()
    url, _ = make_store(tmp_path / "store", signer, tamper="archive")
    with pytest.raises(ReleaseError, match="SHA-256 mismatch"):
        install_release(url, str(tmp_path / "cache"), quiet=True, public_key=signer.public_key)
    assert not (tmp_path / "cache" / "browser").exists()


def test_install_refuses_wrong_chromium_for_this_sdk(tmp_path):
    signer = Signer()
    url, _ = make_store(tmp_path / "store", signer, chromium="150.0.1.1")
    with pytest.raises(ReleaseError, match="expects"):
        install_release(url, str(tmp_path / "cache"), quiet=True, public_key=signer.public_key)


def test_ensure_binary_installs_only_when_opted_in(tmp_path, monkeypatch):
    from ant0browser import download

    signer = Signer()
    url, _ = make_store(tmp_path / "store", signer)
    monkeypatch.delenv("ANT0_BROWSER_RELEASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="ANT0_BROWSER_RELEASE_URL"):
        download.ensure_binary(cache_dir=str(tmp_path / "cache"), quiet=True)
    monkeypatch.setenv("ANT0_BROWSER_RELEASE_URL", url)
    monkeypatch.setattr(release_fetch, "RELEASE_PUBLIC_KEY", signer.public_key)
    exe = download.ensure_binary(cache_dir=str(tmp_path / "cache"), quiet=True)
    assert os.path.isfile(exe)
    # Second call: served from cache, no network (delete the store to prove it).
    import shutil; shutil.rmtree(tmp_path / "store")
    assert download.ensure_binary(cache_dir=str(tmp_path / "cache"), quiet=True) == exe
