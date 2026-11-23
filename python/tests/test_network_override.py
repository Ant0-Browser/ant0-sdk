import base64
import gzip
import json
from pathlib import Path

import pytest

from ant0browser._fingerprint import encode_profile
from ant0browser.identity import prepare_identity_options
from ant0browser.persona_profile import validate_persona_profile, PersonaProfileValidationError

SDK = Path(__file__).resolve().parents[2]
BASE = json.loads((SDK / "fixtures" / "synthetic" / "persona-v2.json").read_text(encoding="utf-8"))
SHARED = json.loads((SDK / "fixtures" / "network-override-v1.json").read_text(encoding="utf-8"))
KEYS = ("fingerprint", "fingerprint_profile", "platform")


def prep(network="__none__"):
    options = {"identity": {"mode": "captured", "source": json.loads(json.dumps(BASE))}}
    if network != "__none__":
        options["overrides"] = {"network": network}
    return prepare_identity_options(options, KEYS)[1]


def payload(opts):
    return json.loads(gzip.decompress(base64.b64decode(encode_profile(opts["fingerprint_profile"]))))


def test_no_option_is_byte_identical_and_has_no_block():
    assert encode_profile(prep({})["fingerprint_profile"]) == encode_profile(prep()["fingerprint_profile"])
    assert "network" not in payload(prep())


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda c: c["label"])
def test_shared_cases(case):
    out = payload(prep(case["override"]))
    if case["network_block"] is None:
        assert "network" not in out
    else:
        assert out["network"] == case["network_block"]
    out.pop("network", None)
    assert out == BASE


def test_float_integers_encode_like_node():
    raw = gzip.decompress(base64.b64decode(encode_profile(prep({"rtt": 100.0})["fingerprint_profile"])))
    assert b'"rtt_ms":100}' in raw


def test_payload_validates_and_input_not_mutated():
    src = json.loads(json.dumps(BASE))
    out = prepare_identity_options({"identity": {"mode": "captured", "source": src},
                                    "overrides": {"network": {"rtt": 100}}}, KEYS)[1]
    validate_persona_profile(out["fingerprint_profile"])
    assert "network" not in src


def test_validator_rejects_malformed_block():
    for bad in ({"rtt_ms": 0}, {"effective_type": "5g"}, {"x": 1}):
        with pytest.raises(PersonaProfileValidationError):
            validate_persona_profile({**BASE, "network": bad})


@pytest.mark.parametrize("case", SHARED["invalid"], ids=lambda c: json.dumps(c["override"]))
def test_invalid_rejected(case):
    with pytest.raises((TypeError, ValueError)):
        prep(case["override"])


def test_non_object_and_native_rejected():
    with pytest.raises((TypeError, ValueError)):
        prep(5)
    with pytest.raises(ValueError):
        prepare_identity_options({"overrides": {"network": {"rtt": 50}}}, KEYS)


def test_null_network_and_fields_mean_not_given():
    assert encode_profile(prep(None)["fingerprint_profile"]) == encode_profile(prep()["fingerprint_profile"])
    assert "network" not in payload(prep({"rtt": None, "downlink": None}))
    assert payload(prep({"rtt": 100, "downlink": None}))["network"] == {"rtt_ms": 100}
    prepare_identity_options({"overrides": {"network": None}}, KEYS)  # native identity: not given, not an error
