import base64
import copy
import gzip
import hashlib
import json
from pathlib import Path

from ant0browser._speech_coherence import BUILTIN_WINDOWS_VOICES, builtin_speech_if_contradicting, cohere_speech
from ant0browser.identity import prepare_identity_options
from ant0browser._fingerprint import FINGERPRINT_KEYS, encode_profile
from ant0browser.population_model import generate_persona_profile

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "fixtures" / "synthetic"
                      / "speech-locale-generate-v1.json").read_text(encoding="utf-8"))
BUILTIN = [n for n, _, _ in BUILTIN_WINDOWS_VOICES]


def model_for(locale):
    m = copy.deepcopy(FIXTURE["model"])
    m["constants"]["locale"] = {**m["constants"]["locale"], "primary_language": locale, "languages": [locale]}
    return m


def gen(locale, key):
    return generate_persona_profile(key, "0" * 64, model_for(locale))


def default_lang(p):
    return next(v for v in p["speech"]["voices"] if v["default"])["language"]


def names(p):
    return [v["name"] for v in p["speech"]["voices"]]


def test_golden_cases_match_node():
    for c in FIXTURE["cases"]:
        p = generate_persona_profile(c["identity_key"], c["device_key"], model_for(c["primary_language"]))
        assert p["speech"]["voices"] == c["expected_voices"]


def test_en_us_persona_gets_en_default_never_ru():
    for i in range(80):
        assert default_lang(gen("en-US", f"k{i}")) == "en-US"


def test_ru_persona_gets_ru_set():
    for i in range(40):
        assert default_lang(gen("ru-RU", f"k{i}")) == "ru-RU"


def test_en_gb_and_bare_en():
    assert all(default_lang(gen("en-GB", f"k{i}")) == "en-GB" for i in range(20))
    langs = {default_lang(gen("en", f"k{i}")) for i in range(80)}
    assert all(lang.startswith("en-") for lang in langs) and len(langs) > 1


def test_no_match_uses_builtin_set():
    p = gen("de-DE", "k1")
    assert names(p) == BUILTIN
    assert BUILTIN == [
        "Microsoft David - English (United States)",
        "Microsoft Zira - English (United States)",
        "Microsoft Mark - English (United States)",
    ]
    assert sum(v["default"] for v in p["speech"]["voices"]) == 1


def test_other_groups_unchanged():
    a, b = gen("en-US", "k9"), gen("de-DE", "k9")
    for x in (a, b):
        x["speech"] = x["locale"] = None
    assert a == b


def test_safety_net_swaps_on_persona_language_without_mutating():
    p = gen("en-US", "k1")
    p["speech"] = copy.deepcopy(gen("ru-RU", "k1")["speech"])
    before = copy.deepcopy(p)
    out = builtin_speech_if_contradicting(p, "windows")
    assert names(out) == BUILTIN
    assert p == before
    # Accept-Language is ignored, in both directions.
    assert builtin_speech_if_contradicting(p, "windows", "ru-RU,ru") == out
    ru = gen("ru-RU", "k1")
    assert builtin_speech_if_contradicting(ru, "windows", "en-US") is ru


def test_safety_net_leaves_agreeing_and_other_platforms():
    p = gen("ru-RU", "k1")
    assert builtin_speech_if_contradicting(p, "windows", None) is p
    assert builtin_speech_if_contradicting(p, "linux", "en-US") is p
    en = gen("en-US", "k1")
    assert builtin_speech_if_contradicting(en, "windows", "de-DE") is en


CROSS_SDK_SHA256 = "221f1db0757a294dc5453a7d2a9fd662459014f596a7ebf3e06eb8155560cdf6"


def test_launch_accept_language_never_changes_payload(tmp_path):
    root, ids = tmp_path / "model", tmp_path / "ids"
    root.mkdir()
    (root / "population-model-v1.json").write_text(json.dumps(FIXTURE["model"]), encoding="utf-8")

    def launch(**extra):
        _, prepared = prepare_identity_options({
            "identity": {"mode": "synthetic", "key": "acct-1", "model_directory": str(root),
                         "identity_directory": str(ids)},
            "overrides": extra}, FINGERPRINT_KEYS)
        return prepared["fingerprint_profile"]

    def payload(**extra):
        return gzip.decompress(base64.b64decode(encode_profile(launch(**extra)))).decode("utf-8")

    def saved():
        return "|".join(p.read_text(encoding="utf-8") for p in sorted(ids.glob("*.json")))

    launch()
    before = saved()
    base = payload()
    assert default_lang(launch()) == "en-US"
    for lang in ("en-US", "de-DE", "fr-FR", "ru-RU,ru"):
        assert payload(accept_language=lang) == base
    assert saved() == before


def test_fixed_stale_persona_matches_node_payload():
    stale = gen("en-US", "k1")
    stale["speech"] = copy.deepcopy(gen("ru-RU", "k1")["speech"])
    out, _ = cohere_speech(stale, "windows", "de-DE", "chrome")
    fixed = builtin_speech_if_contradicting(out, "windows", "fr-FR")
    raw = gzip.decompress(base64.b64decode(encode_profile(fixed))).decode("utf-8")
    canon = json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert hashlib.sha256(canon.encode("utf-8")).hexdigest() == CROSS_SDK_SHA256
