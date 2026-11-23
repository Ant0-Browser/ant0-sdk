import copy
import hashlib
import json
from pathlib import Path

import pytest

import ant0browser
from ant0browser import generate_persona_profile, validate_persona_profile
from ant0browser._speech_coherence import (
    DOCUMENTED_WINDOWS_VOICE_SETS, GOOGLE_VOICES, LINUX_VOICES, WINDOWS_VOICE_SETS, cohere_speech, language_tag, builtin_speech_if_contradicting, builtin_speech_voices, BUILTIN_WINDOWS_VOICES,
)

SDK = Path(__file__).resolve().parents[2]
GOLDEN = json.loads((SDK / "fixtures" / "speech-coherence-v1.json").read_text(encoding="utf-8"))
MODEL = json.loads((SDK / "fixtures" / "synthetic" / "population-generate-v1.json").read_text(encoding="utf-8"))["model"]
CAPTURED = json.loads((SDK / "fixtures" / "synthetic" / "persona-v2.json").read_text(encoding="utf-8"))


def bare(tag):
    return tag.lower().split("-")[0]


def profile_for(i):
    return generate_persona_profile("k%d" % i, hashlib.sha256(("d%d" % i).encode()).hexdigest(), MODEL)


def co(profile, platform, lang=None, brand="chrome"):
    """The persona's language is locale.primary_language; the launch language argument is ignored."""
    if lang:
        profile = {**profile, "locale": {**profile.get("locale", {}), "primary_language": lang, "languages": [lang, lang.split("-")[0]]}}
    return cohere_speech(profile, platform, None, brand)


def default_of(profile):
    return next(v for v in profile["speech"]["voices"] if v["default"])


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["label"])
def test_golden_cases_shared_with_node(case):
    profile, fallback = cohere_speech(case["profile"], case["platform"], case["accept_language"], case.get("brand"))
    voices = profile["speech"]["voices"]
    got = {
        "fallback": fallback, "count": len(voices),
        "default": next((v["name"] for v in voices if v["default"]), None),
        "sha256": hashlib.sha256(json.dumps(voices, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest(),
    }
    assert got == case["expect"]


WITH_DATA = ["en-US", "en-GB", "de-DE", "fr-FR", "es-MX", "pt-BR", "ru-RU", "zh-CN", "tr-TR", "it-IT"]


def test_windows_default_voice_has_persona_language_over_many_seeds():
    changed = 0
    for i in range(2000):
        orig = profile_for(i)
        for lang in WITH_DATA:
            profile, fallback = co(orig, "windows", lang)
            assert bare(default_of(profile)["language"]) == bare(lang), (i, lang)
            assert fallback is False
            changed += profile["speech"] != orig["speech"]
    assert changed > 0  # otherwise the test passes on a no-op


def test_exact_tag_preferred():
    for i in range(300):
        assert default_of(co(profile_for(i), "windows", "en-GB")[0])["language"] == "en-GB"


def test_linux_gets_exactly_the_measured_chrome_list_whatever_the_language():
    expected = [n for n, _l, _d in LINUX_VOICES]
    assert len(expected) == 19
    for i in range(2000):
        for lang in WITH_DATA + ["ja-JP", "ko-KR", "xx-YY"]:
            profile, fallback = co(profile_for(i), "linux", lang)
            voices = profile["speech"]["voices"]
            assert [v["name"] for v in voices] == expected
            assert not any("Microsoft" in v["name"] or v["local_service"] for v in voices)
            assert [v["name"] for v in voices if v["default"]] == ["Google Deutsch"]
            assert fallback is False


def test_default_voice_is_first_and_native_precede_network():
    for i in range(500):
        for plat in ("windows", "linux"):
            for lang in ("en-US", "de-DE", "ru-RU", "ja-JP"):
                voices = co(profile_for(i), plat, lang)[0]["speech"]["voices"]
                assert [k for k, v in enumerate(voices) if v["default"]] == [0]
                net = next((k for k, v in enumerate(voices) if not v["local_service"]), None)
                if net is not None:
                    assert all(not v["local_service"] for v in voices[net:])


def test_misplaced_default_is_moved_first_when_profile_list_is_kept():
    p = dict(profile_for(1))
    p["speech"] = {"voices": [
        {"voice_uri": "a", "name": "Microsoft Zira - English (United States)", "language": "en-US", "local_service": True, "default": False},
        {"voice_uri": "b", "name": "Microsoft David - English (United States)", "language": "en-US", "local_service": True, "default": True}]}
    names = [v["name"] for v in co(p, "windows", "en-US", None)[0]["speech"]["voices"]]
    assert names == ["Microsoft David - English (United States)", "Microsoft Zira - English (United States)"]


def test_stable_and_does_not_mutate_input():
    p = profile_for(1)
    before = copy.deepcopy(p)
    assert co(p, "windows", "fr-FR")[0]["speech"] == co(p, "windows", "fr-FR")[0]["speech"]
    co(p, "linux", "en-US")
    assert p == before


def test_other_platforms_untouched_and_fallback_reported():
    p = profile_for(1)
    assert cohere_speech(p, "macos", "en-US", "chrome")[0] is p
    profile, fallback = co(p, "windows", "ar-EG")
    assert fallback is True and default_of(profile)["language"] == "en-US"


def test_outputs_validate_and_use_only_real_names():
    real = {n for n, _ in GOOGLE_VOICES} | {v[0] for lst in WINDOWS_VOICE_SETS.values() for _, _, vs in lst for v in vs} | {v[0] for lst in DOCUMENTED_WINDOWS_VOICE_SETS.values() for _, _, vs in lst for v in vs}
    for i in range(200):
        orig = profile_for(i)
        for plat in ("windows", "linux"):
            profile, _ = co(orig, plat, "de-DE")
            validate_persona_profile(profile)
            if profile["speech"] != orig["speech"]:
                assert all(v["name"] in real for v in profile["speech"]["voices"])


def test_language_tag():
    assert language_tag("en-us,en;q=0.9") == "en-US"
    assert language_tag("de_DE") == "de-DE"
    assert language_tag("") == "" and language_tag(None) == "" and language_tag("not a tag") == ""


def test_identity_wiring():
    def voices(**opts):
        _mode, prepared = ant0browser.prepare_identity_options(
            {"identity": {"mode": "captured", "source": CAPTURED}, **opts}, ant0browser.FINGERPRINT_KEYS)
        return prepared["fingerprint_profile"]["speech"]["voices"]
    # (A linux platform override on this Windows capture is refused; see test_platform_mismatch.py.)
    assert any("Example Voice" in v["name"] for v in voices(overrides={"platform": "windows"}))
    base = voices()
    for lang in ("fr-FR", "ru-RU", "de-DE"):
        assert voices(overrides={"accept_language": lang}) == base


def test_ja_uses_documented_microsoft_voices_not_english_fallback():
    for i in range(300):
        profile, fallback = co(profile_for(i), "windows", "ja-JP")
        voices = profile["speech"]["voices"]
        assert fallback is False
        assert [v["name"] for v in voices[:3]] == [
            "Microsoft Ayumi - Japanese (Japan)", "Microsoft Haruka - Japanese (Japan)", "Microsoft Ichiro - Japanese (Japan)"]
        assert voices[0]["default"] is True and voices[0]["language"] == "ja-JP"
    assert "ja" not in WINDOWS_VOICE_SETS


def test_launch_language_never_changes_the_list():
    for i in range(200):
        for plat in ("windows", "linux"):
            p = profile_for(i)
            base = cohere_speech(p, plat, None, "chrome")[0]["speech"]
            for launch in ("ru-RU", "de-DE", "en-US", "ja-JP", "", None):
                assert cohere_speech(p, plat, launch, "chrome")[0]["speech"] == base


def test_stable_key_does_not_depend_on_int_versus_float_memory():
    from ant0browser._speech_coherence import _stable_key
    a = profile_for(3)
    b = {**a, "hardware": {**a["hardware"], "device_memory_gb": float(a["hardware"]["device_memory_gb"])}}
    assert _stable_key(a) == _stable_key(b)
    assert cohere_speech(a, "windows")[0]["speech"] == cohere_speech(b, "windows")[0]["speech"]


# ---- network voices follow the brand ----
GOOGLE = [n for n, _ in GOOGLE_VOICES]


def _net(profile):
    return [v["name"] for v in profile["speech"]["voices"] if not v["local_service"]]


def _names(profile):
    return [v["name"] for v in profile["speech"]["voices"]]


DAVID = {"voice_uri": "d", "name": "Microsoft David - English (United States)", "language": "en-US", "local_service": True, "default": True}


def _gv(n):
    return [{"voice_uri": name, "name": name, "language": lang, "local_service": False, "default": False}
            for name, lang in GOOGLE_VOICES[:n]]


def _run(voices, brand):
    return cohere_speech({**profile_for(1), "speech": {"voices": voices}}, "windows", None, brand)[0]["speech"]["voices"]


def test_chrome_lists_local_voices_then_at_most_the_19_network_voices_never_doubled():
    with_net = 0
    for i in range(300):
        for lang in ("en-US", "de-DE", "ru-RU", "ja-JP"):
            profile, _ = co(profile_for(i), "windows", lang, "chrome")
            v = profile["speech"]["voices"]
            n = _net(profile)
            assert len(n) in (0, 19), (i, lang)
            if n:
                with_net += 1
                assert n == GOOGLE and all(not x["local_service"] for x in v[len(v) - 19:])
            assert v[0]["default"] is True and sum(1 for x in v if x["default"]) == 1
    assert with_net > 0


def test_chrome_local_only_is_left_for_the_engine_full_kept_partial_made_exact():
    assert [v["name"] for v in _run([DAVID], "chrome")] == [DAVID["name"]]
    assert [v["name"] for v in _run([DAVID] + _gv(19), "Chrome")] == [DAVID["name"]] + GOOGLE
    partial = _run([DAVID] + _gv(3), "chrome")
    assert [v["name"] for v in partial] == [DAVID["name"]] + GOOGLE
    assert [v["name"] for v in partial if v["default"]] == [DAVID["name"]]
    p = {**profile_for(1), "speech": {"voices": partial}}
    assert cohere_speech(p, "windows", None, "chrome")[0] is p


def test_chrome_linux_is_the_19_network_voices_with_google_deutsch_default():
    profile, _ = co(profile_for(3), "linux", "en-US", "chrome")
    assert _names(profile) == GOOGLE
    assert [v["name"] for v in profile["speech"]["voices"] if v["default"]] == ["Google Deutsch"]


@pytest.mark.parametrize("brand", ["Edge", "edge", "Opera", "Vivaldi", "Brave", "", "chromium"])
def test_other_brands_have_no_network_voices_on_windows(brand):
    assert [v["name"] for v in _run([DAVID] + _gv(19), brand)] == [DAVID["name"]]
    assert [v["name"] for v in _run([DAVID] + _gv(3), brand)] == [DAVID["name"]]
    for i in range(100):
        profile, _ = co(profile_for(i), "windows", "en-US", brand)
        assert _net(profile) == [] and not any(n.startswith("Google") for n in _names(profile))
        assert profile["speech"]["voices"][0]["default"] is True


@pytest.mark.parametrize("brand", [None, 5])
def test_no_brand_has_no_network_voices_and_an_empty_linux_list(brand):
    assert _net(co(profile_for(3), "windows", "en-US", brand)[0]) == []
    assert _names(co(profile_for(3), "linux", "en-US", brand)[0]) == []
    assert _names(co(profile_for(3), "linux", "en-US", "Edge")[0]) == []


def test_android_and_macos_untouched_under_every_brand():
    p = profile_for(2)
    for brand in ("chrome", "Edge", None):
        for plat in ("android", "macos"):
            assert cohere_speech(p, plat, None, brand)[0] is p


def test_engine_builtin_set_is_left_for_the_engine_under_every_brand():
    builtin = {**profile_for(1), "speech": {"voices": builtin_speech_voices()}}
    for brand in ("chrome", "Edge", None):
        assert cohere_speech(builtin, "windows", None, brand)[0] is builtin
    stale = {**profile_for(1), "locale": {**profile_for(1)["locale"], "primary_language": "de-DE"},
             "speech": {"voices": [{"voice_uri": "x", "name": "Microsoft Irina - Russian (Russia)", "language": "ru-RU", "local_service": True, "default": True}]}}
    assert _names(builtin_speech_if_contradicting(stale, "windows", None)) == [n for n, _, _ in BUILTIN_WINDOWS_VOICES]


def test_launch_options_brand_decides():
    with_net = {**CAPTURED, "speech": {"voices": list(CAPTURED["speech"]["voices"]) + _gv(19)}}

    def net_voices(overrides):
        _m, prepared = ant0browser.prepare_identity_options(
            {"identity": {"mode": "captured", "source": with_net}, "overrides": overrides}, ant0browser.FINGERPRINT_KEYS)
        return [v["name"] for v in prepared["fingerprint_profile"]["speech"]["voices"] if not v["local_service"]]
    assert net_voices({}) == GOOGLE  # the default brand is chrome
    assert net_voices({"brand": "chrome"}) == GOOGLE
    assert net_voices({"brand": "Edge"}) == []
