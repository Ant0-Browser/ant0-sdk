import base64
import gzip
import json
from pathlib import Path

import pytest

from ant0browser._fingerprint import encode_profile
from ant0browser.identity import prepare_identity_options

SDK = Path(__file__).resolve().parents[2]
BASE = json.loads((SDK / "fixtures" / "synthetic" / "persona-v2.json").read_text(encoding="utf-8"))
SHARED = json.loads((SDK / "fixtures" / "audio-profile-override-v1.json").read_text(encoding="utf-8"))
KEYS = ("fingerprint", "fingerprint_profile", "platform")


def prep(audio_profile="__none__"):
    options = {"identity": {"mode": "captured", "source": json.loads(json.dumps(BASE))}}
    if audio_profile != "__none__":
        options["overrides"] = {"audio_profile": audio_profile}
    return prepare_identity_options(options, KEYS)[1]


def payload(opts):
    return json.loads(gzip.decompress(base64.b64decode(encode_profile(opts["fingerprint_profile"]))))


def test_no_option_is_byte_identical():
    assert encode_profile(prep({})["fingerprint_profile"]) == encode_profile(prep()["fingerprint_profile"])
    assert payload(prep())["audio"] == BASE["audio"]


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda c: c["label"])
def test_shared_cases(case):
    out = payload(prep(case["override"]))
    assert out["audio"] == {**BASE["audio"], **case["audio_overrides"]}
    assert list(out["audio"]) == list(BASE["audio"])
    assert {**out, "audio": 0} == {**payload(prep()), "audio": 0}


def test_each_field_alone_keeps_others():
    b = BASE["audio"]
    assert payload(prep({"sample_rate": 44100}))["audio"] == {**b, "sample_rate": 44100}
    assert payload(prep({"base_latency": 0.02}))["audio"] == {**b, "base_latency": 0.02}
    assert payload(prep({"output_latency": 0.05}))["audio"] == {**b, "output_latency": 0.05}


def test_float_integers_encode_like_node():
    raw = gzip.decompress(base64.b64decode(encode_profile(prep({"sample_rate": 44100.0})["fingerprint_profile"])))
    assert b'"sample_rate":44100,' in raw or b'"sample_rate":44100}' in raw


def test_caller_profile_not_mutated():
    src = json.loads(json.dumps(BASE))
    prepare_identity_options({"identity": {"mode": "captured", "source": src},
                              "overrides": {"audio_profile": {"sample_rate": 44100}}}, KEYS)
    assert src["audio"] == BASE["audio"]


@pytest.mark.parametrize("case", SHARED["invalid"], ids=lambda c: json.dumps(c["override"]))
def test_invalid_rejected(case):
    with pytest.raises((TypeError, ValueError)):
        prep(case["override"])


def test_non_object_and_native_rejected():
    with pytest.raises((TypeError, ValueError)):
        prep(5)
    with pytest.raises(ValueError):
        prepare_identity_options({"overrides": {"audio_profile": {"sample_rate": 44100}}}, KEYS)
