"""The Linux font pack is resolved BEFORE the launch ticket is fetched, on every launch path.

WHY: engine ant0.11 rejects a ticket whose iat is over 300 s old (claim_stale). The first-run font
pack download can take minutes, so the ticket must be the last network step before the spawn.
"""
import json
import sys
import types
from pathlib import Path

import pytest

import ant0browser
from ant0browser import _serve

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures/synthetic/persona-v2.json"
IDENTITY = {"mode": "captured", "source": json.loads(FIXTURE.read_text(encoding="utf-8"))}
pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="font pack is wired on Linux only")


class Spawned(Exception):
    pass


class _Stop(Exception):
    pass


@pytest.fixture
def order(monkeypatch, tmp_path):
    calls = []
    exe = tmp_path / "fake-chrome.exe"
    exe.write_bytes(b"ant0-browser-capabilities/persona-profile-v1")

    def runtime(**k):
        calls.append("ticket")
        return types.SimpleNamespace(executable=str(exe), ticket_args=[], release=None, engine_version="ant0.3")

    def pack(quiet=False, download=True):
        calls.append("fonts")
        return str(tmp_path)

    monkeypatch.setattr(ant0browser, "prepare_runtime_launch", runtime)
    monkeypatch.setattr(ant0browser, "_guard", lambda e: None)
    monkeypatch.setattr("ant0browser.fontpack.resolve_font_pack", pack)
    monkeypatch.setattr("ant0browser.fontpack.pack_families", lambda p: [])
    monkeypatch.setattr("ant0browser._fonts.linux_font_env", lambda e, pack=None: {})

    def boom(*a, **k):
        raise Spawned
    monkeypatch.setattr(_serve.subprocess, "Popen", boom)
    monkeypatch.setattr(ant0browser, "_playwright", lambda: (_ for _ in ()).throw(Spawned()))
    return types.SimpleNamespace(calls=calls, exe=str(exe), tmp=tmp_path)


def _common(o):
    return dict(identity=IDENTITY, headless=True, quiet=True, executable_path=o.exe)


def test_launch(order):
    with pytest.raises(Spawned):
        ant0browser.launch(ephemeral_profile=False, **_common(order))
    assert order.calls == ["fonts", "ticket"]


def test_persistent(order):
    with pytest.raises(Spawned):
        ant0browser.launch_persistent_context(str(order.tmp / "udd"), **_common(order))
    assert order.calls == ["fonts", "ticket"]


def test_serve(order):
    with pytest.raises(Spawned):
        _serve.serve(user_data_dir=str(order.tmp / "udd"), **_common(order))
    assert order.calls == ["fonts", "ticket"]


async def test_async_launch(order, monkeypatch):
    from ant0browser import async_api

    async def start():
        raise Spawned
    monkeypatch.setattr(async_api, "_start_driver", start)
    with pytest.raises(Spawned):
        await async_api.launch(ephemeral_profile=False, **_common(order))
    assert order.calls == ["fonts", "ticket"]
