from ant0browser import fontpack


def _pack(tmp_path, name="pack"):
    d = tmp_path / name; d.mkdir(); (d / "Arial.ttf").write_bytes(b"x"); return d


def test_env_folder_is_ignored(monkeypatch, tmp_path):
    monkeypatch.setenv("ANT0_BROWSER_FONT_PACK", str(_pack(tmp_path)))
    assert fontpack.resolve_font_pack(quiet=True) is None


def test_cached_pack_is_ignored(monkeypatch, tmp_path):
    monkeypatch.delenv("ANT0_BROWSER_FONT_PACK", raising=False)
    monkeypatch.setenv("ANT0_BROWSER_CACHE", str(tmp_path))
    dest = tmp_path / "fontpack" / fontpack.PACK_VERSION; dest.mkdir(parents=True)
    (dest / "Arial.ttf").write_bytes(b"x")
    assert fontpack.resolve_font_pack(quiet=True, download=False) is None


def test_never_downloads(monkeypatch):
    monkeypatch.setenv("ANT0_BROWSER_FONT_PACK_URL", "https://127.0.0.1:1/pack.zip")
    assert fontpack.resolve_font_pack(quiet=True, download=True) is None
    assert not hasattr(fontpack, "PACK_URL")


def test_pack_families_reads_manifest(tmp_path):
    d = _pack(tmp_path)
    (d / "families.txt").write_text("Arial\nSegoe UI\nCalibri\n", encoding="utf-8")
    fams = fontpack.pack_families(str(d))
    assert "arial" in fams and "segoe ui" in fams and "calibri" in fams
