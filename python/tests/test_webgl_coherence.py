import copy
import json
from pathlib import Path

import pytest

from ant0browser import PersonaProfileValidationError, validate_persona_profile
from ant0browser._webgl_coherence import webgl_limit_violations

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"
BASE = json.loads((FIXTURES / "persona-v2.json").read_text(encoding="utf-8"))


def profile(webgl1=None, webgl2=None):
    p = copy.deepcopy(BASE)
    p["graphics"]["webgl"]["webgl1"]["parameters"].update(webgl1 or {})
    p["graphics"]["webgl"]["webgl2"]["parameters"].update(webgl2 or {})
    return p


def blocks(v, f, c, b):
    return {"MAX_VERTEX_UNIFORM_BLOCKS": v, "MAX_FRAGMENT_UNIFORM_BLOCKS": f,
            "MAX_COMBINED_UNIFORM_BLOCKS": c, "MAX_UNIFORM_BUFFER_BINDINGS": b}


ACCEPT = [
    profile(),
    profile(webgl2=blocks(12, 12, 24, 24)),
    profile(webgl2=blocks(14, 14, 28, 28)),
    profile(webgl2={"MAX_VERTEX_UNIFORM_BLOCKS": 8}),
    profile({"MAX_COMBINED_UNIFORM_BLOCKS": 20, "MAX_UNIFORM_BUFFER_BINDINGS": 24},
            {"MAX_VERTEX_UNIFORM_BLOCKS": 8, "MAX_FRAGMENT_UNIFORM_BLOCKS": 8}),
    profile({"MAX_VERTEX_TEXTURE_IMAGE_UNITS": 16, "MAX_TEXTURE_IMAGE_UNITS": 16,
             "MAX_COMBINED_TEXTURE_IMAGE_UNITS": 32}),
    profile({"MAX_COMBINED_TEXTURE_IMAGE_UNITS": 96}),
    profile({"STENCIL_VALUE_MASK": 4294967295, "STENCIL_WRITEMASK": 4294967295,
             "STENCIL_BACK_VALUE_MASK": 4294967295, "STENCIL_BACK_WRITEMASK": 4294967295}),
    profile({"MAX_TEXTURE_IMAGE_UNITS": 16, "MAX_VERTEX_TEXTURE_IMAGE_UNITS": 16,
             "MAX_VERTEX_ATTRIBS": 16, "MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS": 120,
             "UNIFORM_BUFFER_OFFSET_ALIGNMENT": 256}),
]

REJECT = [
    (profile(webgl2=blocks(12, 12, 20, 24)),
     "incoherent WebGL limits: webgl2 MAX_VERTEX_UNIFORM_BLOCKS (12) + MAX_FRAGMENT_UNIFORM_BLOCKS (12) exceeds MAX_COMBINED_UNIFORM_BLOCKS (20)"),
    (profile(webgl2=blocks(14, 12, 24, 24)),
     "incoherent WebGL limits: webgl2 MAX_VERTEX_UNIFORM_BLOCKS (14) + MAX_FRAGMENT_UNIFORM_BLOCKS (12) exceeds MAX_COMBINED_UNIFORM_BLOCKS (24)"),
    (profile(webgl2=blocks(12, 12, 24, 16)),
     "incoherent WebGL limits: webgl2 MAX_COMBINED_UNIFORM_BLOCKS (24) exceeds MAX_UNIFORM_BUFFER_BINDINGS (16)"),
    (profile(webgl2={"MAX_COMBINED_UNIFORM_BLOCKS": 20}),
     "incoherent WebGL limits: webgl2 MAX_VERTEX_UNIFORM_BLOCKS (12) + MAX_FRAGMENT_UNIFORM_BLOCKS (12) exceeds MAX_COMBINED_UNIFORM_BLOCKS (20)"),
    (profile(webgl2={"MAX_UNIFORM_BUFFER_BINDINGS": 10}),
     "incoherent WebGL limits: webgl2 MAX_COMBINED_UNIFORM_BLOCKS (24) exceeds MAX_UNIFORM_BUFFER_BINDINGS (10)"),
    (profile(blocks(12, 12, 24, 24), {"MAX_COMBINED_UNIFORM_BLOCKS": 20}),
     "incoherent WebGL limits: webgl2 MAX_VERTEX_UNIFORM_BLOCKS (12) + MAX_FRAGMENT_UNIFORM_BLOCKS (12) exceeds MAX_COMBINED_UNIFORM_BLOCKS (20)"),
    (profile({"MAX_VERTEX_TEXTURE_IMAGE_UNITS": 20, "MAX_TEXTURE_IMAGE_UNITS": 16,
              "MAX_COMBINED_TEXTURE_IMAGE_UNITS": 32}),
     "incoherent WebGL limits: webgl1 MAX_VERTEX_TEXTURE_IMAGE_UNITS (20) + MAX_TEXTURE_IMAGE_UNITS (16) exceeds MAX_COMBINED_TEXTURE_IMAGE_UNITS (32)"),
    (profile({"MAX_VERTEX_TEXTURE_IMAGE_UNITS": 20}),
     "incoherent WebGL limits: webgl1 MAX_VERTEX_TEXTURE_IMAGE_UNITS (20) + MAX_TEXTURE_IMAGE_UNITS (16) exceeds MAX_COMBINED_TEXTURE_IMAGE_UNITS (32)"),
]


@pytest.mark.parametrize("p", ACCEPT)
def test_accepts_coherent_limits(p):
    validate_persona_profile(p)


@pytest.mark.parametrize("p,message", REJECT)
def test_rejects_with_a_message_naming_the_relation_and_values(p, message):
    with pytest.raises(PersonaProfileValidationError) as info:
        validate_persona_profile(p)
    assert info.value.path == "graphics.webgl.parameters"
    assert info.value.message == message


def test_non_integer_limit_is_a_violation():
    found = webgl_limit_violations("windows", "chromium", {}, {"MAX_COMBINED_UNIFORM_BLOCKS": 24.5})
    assert found == ["MAX_COMBINED_UNIFORM_BLOCKS must be a non-negative integer, got 24.5"]
    assert webgl_limit_violations("windows", "chromium", {}, {"MAX_COMBINED_UNIFORM_BLOCKS": True})


def test_unknown_pair_has_no_rule_known_pairs_do():
    bad = {"MAX_COMBINED_UNIFORM_BLOCKS": 20}
    assert webgl_limit_violations("android", "chromium", {}, bad) == []
    assert webgl_limit_violations("windows", "firefox", {}, bad) == []
    assert len(webgl_limit_violations("linux", "chromium", {}, bad)) == 1
    assert len(webgl_limit_violations("macos", "chromium", {}, bad)) == 1
