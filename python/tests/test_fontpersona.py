"""Canonical font reachability checks."""

import json

import pytest

from ant0browser import _fontpersona as fpm
from ant0browser._warnings import coherence_warnings


LINUXY = ["DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Mono", "FreeSans"]


def test_profile_fonts_reads_only_v2_families(tmp_path):
    profile = {"schema_version": 2, "fonts": {"families": LINUXY}}
    path = tmp_path / "profile.json"
    path.write_text(json.dumps(profile), encoding="utf-8")
    assert fpm.profile_fonts(profile) == LINUXY
    assert fpm.profile_fonts(path) == LINUXY
    assert fpm.profile_fonts(json.dumps(profile)) == LINUXY
    assert fpm.profile_fonts({"fonts": {"detected": LINUXY}}) == []


def test_warns_when_the_persona_font_identity_is_unreachable():
    warnings = [
        warning for warning in coherence_warnings({"_font_reach": (1513, 65)})
        if warning["code"] == "persona-fonts-unreachable"
    ]
    assert len(warnings) == 1
    assert "1513" in warnings[0]["message"] and "65" in warnings[0]["message"]


@pytest.mark.parametrize("reach", [None, (300, 280), (39, 1), (100, 50)])
def test_no_warning_when_reachable_or_unknown_or_tiny(reach):
    codes = {warning["code"] for warning in coherence_warnings({"_font_reach": reach})}
    assert "persona-fonts-unreachable" not in codes


def test_font_reachability_uses_host_intersection(monkeypatch):
    monkeypatch.setattr(fpm, "host_font_families", lambda: frozenset(x.lower() for x in LINUXY))
    profile = {"schema_version": 2, "fonts": {"families": LINUXY + ["Missing Family"]}}
    assert fpm.font_reachability(profile) == (6, 5)
    assert fpm.font_reachability(None) is None


def test_basic_families_always_count_as_reachable():
    assert fpm.reachable_count(["Arial", "Times New Roman", "monospace"], frozenset()) == 3


def test_font_reachability_folds_in_the_pack():
    from ant0browser import _fontpersona as fp
    profile = {"fonts": {"families": ["Arial", "Segoe UI", "Calibri Light", "Constantia", "ZzzNope"]}}
    import unittest.mock as m
    with m.patch.object(fp, "host_font_families", lambda: frozenset()):
        _, bare = fp.font_reachability(profile)                    # bare host: ~basics only
        _, withpack = fp.font_reachability(profile, {"segoe ui", "calibri", "constantia"})
    assert withpack > bare
    assert withpack >= 4  # Arial(basic) + Segoe UI + Calibri Light(base) + Constantia
