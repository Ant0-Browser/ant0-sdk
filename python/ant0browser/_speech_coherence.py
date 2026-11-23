"""Coherent ``speechSynthesis`` voice lists, built from rules (mirrors the Node SDK's
``speech-coherence.ts``; the shared fixture ``fixtures/speech-coherence-v1.json`` pins both).

The population model draws a persona's voices independently of its platform and language, so a
measured 82.6 percent of personas had a default voice in another language than the persona, and 98
percent of Linux personas carried Windows (Microsoft) voices. At launch, when the platform and
language are known, ``cohere_speech`` rewrites ``speech.voices`` by these rules, keyed on the
persona's own language (``locale.primary_language``), never on the launch language, which can follow
a proxy's exit IP (the one exception is the launch-time safety net ``builtin_speech_if_contradicting``
at the end of this module):

* Linux persona: never a Microsoft voice. The list is ``LINUX_VOICES``, ONE TABLE ENTRY THAT MAY
  STILL CHANGE WITH FURTHER MEASUREMENT: edit it here and in ``speech-coherence.ts`` (and the
  fixture). It is exactly what real Chrome 158 Beta on Linux listed (tests/voices-linux, measured on
  a server; that a desktop matches is inferred): 19 network ``Google ...`` voices, no local ones,
  ``Google Deutsch`` (de-DE) default under --lang en-US, de-DE, ja-JP and fr-FR alike. The default
  does not follow the language, so the Linux list is the same for every identity and language, and
  the "default voice has the persona language" rule applies to Windows only.
* Windows persona: the profile's own list is kept when its default voice already has the persona
  language (it is a real capture). Otherwise one of the real captured Windows sets whose default
  voice is in that language is chosen, weighted by capture frequency and keyed on the profile so the
  same profile always gets the same list. An exact tag (en-GB) is preferred over the bare language
  (en). For a language with no capture but listed in Microsoft's Appendix A (ja-JP, ko-KR, pl-PL,
  ...), ``DOCUMENTED_WINDOWS_VOICE_SETS`` is used: the voice names are Microsoft's, NOT captured from a
  browser, and the display labels are inferred (lower confidence). With neither (for example ar-EG)
  it falls back to English and the result's ``fallback`` is True.
* Every list this module builds has its default voice first, because stock Chrome marks the first
  listed voice as the default (``is_default = (i == 0)`` in speech_synthesis_impl.cc); on Windows the
  persona-language voice leads and native voices come before the network ones, as in every capture.
* Any other platform (macos, android): left as is. The repo holds no real voice capture for them.

Voice names are those in the population model's captures (real browsers) and, marked as documented
rather than captured, Microsoft's Appendix A. Nothing else is made up.
"""

import hashlib
import re

#: The 19 network voices real Chrome lists (name, language), in captured order.
GOOGLE_VOICES = (
    ("Google Deutsch", "de-DE"),
    ("Google US English", "en-US"),
    ("Google UK English Female", "en-GB"),
    ("Google UK English Male", "en-GB"),
    ("Google espa\u00f1ol", "es-ES"),
    ("Google espa\u00f1ol de Estados Unidos", "es-US"),
    ("Google fran\u00e7ais", "fr-FR"),
    ("Google \u0939\u093f\u0928\u094d\u0926\u0940", "hi-IN"),
    ("Google Bahasa Indonesia", "id-ID"),
    ("Google italiano", "it-IT"),
    ("Google \u65e5\u672c\u8a9e", "ja-JP"),
    ("Google \ud55c\uad6d\uc758", "ko-KR"),
    ("Google Nederlands", "nl-NL"),
    ("Google polski", "pl-PL"),
    ("Google portugu\u00eas do Brasil", "pt-BR"),
    ("Google \u0440\u0443\u0441\u0441\u043a\u0438\u0439", "ru-RU"),
    ("Google\u00a0\u666e\u901a\u8bdd\uff08\u4e2d\u56fd\u5927\u9646\uff09", "zh-CN"),
    ("Google\u00a0\u7ca4\u8a9e\uff08\u9999\u6e2f\uff09", "zh-HK"),
    ("Google \u570b\u8a9e\uff08\u81fa\u7063\uff09", "zh-TW"),
)

#: Linux persona voice list (name, language, default). Single entry, flagged: see the module docstring.
LINUX_VOICES = tuple((n, lang, n == "Google Deutsch") for n, lang in GOOGLE_VOICES)

#: Real captured Windows voice sets by the bare language of their default voice:
#: (capture weight in the population model, whether the Google voices followed, local voices).
WINDOWS_VOICE_SETS = {
    "ru": [
        (418614, True, [("Microsoft Irina - Russian (Russia)", "ru-RU", True), ("Microsoft Pavel - Russian (Russia)", "ru-RU", False)]),
        (234653, True, [("Microsoft Irina - Russian (Russia)", "ru-RU", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft David - English (United States)", "en-US", False), ("Microsoft Pavel - Russian (Russia)", "ru-RU", False)]),
        (5743, False, [("Microsoft Irina - Russian (Russia)", "ru-RU", True), ("Microsoft Pavel - Russian (Russia)", "ru-RU", False)]),
        (4950, True, [("Microsoft Irina - Russian (Russia)", "ru-RU", True), ("Microsoft Hazel - English (United Kingdom)", "en-GB", False), ("Microsoft Susan - English (United Kingdom)", "en-GB", False), ("Microsoft David - English (United States)", "en-US", False), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft George - English (United Kingdom)", "en-GB", False), ("Microsoft Pavel - Russian (Russia)", "ru-RU", False)]),
        (3366, True, [("Microsoft Irina Mobile - Russian (Russia)", "ru-RU", True), ("Microsoft Pavel Mobile - Russian (Russia)", "ru-RU", False)]),
        (2772, False, [("Microsoft Irina - Russian (Russia)", "ru-RU", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft David - English (United States)", "en-US", False), ("Microsoft Pavel - Russian (Russia)", "ru-RU", False)]),
    ],
    "en": [
        (153663, True, [("Microsoft David - English (United States)", "en-US", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False)]),
        (37030, True, [("Microsoft Zira Desktop - English (United States)", "en-US", True)]),
        (20198, True, [("Microsoft David - English (United States)", "en-US", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft Irina - Russian (Russia)", "ru-RU", False), ("Microsoft Pavel - Russian (Russia)", "ru-RU", False)]),
        (7327, True, [("Microsoft George - English (United Kingdom)", "en-GB", True), ("Microsoft Hazel - English (United Kingdom)", "en-GB", False), ("Microsoft Susan - English (United Kingdom)", "en-GB", False)]),
        (5347, True, [("Microsoft David Mobile - English (United States)", "en-US", True), ("Microsoft Mark Mobile - English (United States)", "en-US", False), ("Microsoft Zira Mobile - English (United States)", "en-US", False)]),
        (4950, True, [("Microsoft David - English (United States)", "en-US", True), ("Microsoft Ravi - English (India)", "en-IN", False), ("Microsoft Heera - English (India)", "en-IN", False), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False)]),
        (4752, True, [("Microsoft George - English (United Kingdom)", "en-GB", True), ("Microsoft Hazel - English (United Kingdom)", "en-GB", False), ("Microsoft Susan - English (United Kingdom)", "en-GB", False), ("Microsoft David - English (United States)", "en-US", False), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False)]),
        (3564, True, [("Microsoft David - English (United States)", "en-US", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft An - Vietnamese (Vietnam)", "vi-VN", False)]),
        (3564, False, [("Microsoft David - English (United States)", "en-US", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False)]),
        (2970, True, [("Microsoft David - English (United States)", "en-US", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft Asaf - Hebrew (Israel)", "he-IL", False)]),
    ],
    "tr": [
        (23168, True, [("Microsoft Tolga - Turkish (Turkey)", "tr-TR", True)]),
        (1980, True, [("Microsoft Tolga - Turkish (Turkey)", "tr-TR", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft David - English (United States)", "en-US", False)]),
    ],
    "fr": [
        (10693, True, [("Microsoft Hortense - French (France)", "fr-FR", True), ("Microsoft Julie - French (France)", "fr-FR", False), ("Microsoft Paul - French (France)", "fr-FR", False)]),
        (4158, True, [("Microsoft Hortense - French (France)", "fr-FR", True), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft David - English (United States)", "en-US", False), ("Microsoft Julie - French (France)", "fr-FR", False), ("Microsoft Paul - French (France)", "fr-FR", False)]),
    ],
    "zh": [
        (10693, True, [("Microsoft Huihui - Chinese (Simplified, PRC)", "zh-CN", True), ("Microsoft Kangkang - Chinese (Simplified, PRC)", "zh-CN", False), ("Microsoft Yaoyao - Chinese (Simplified, PRC)", "zh-CN", False)]),
    ],
    "pt": [
        (8713, True, [("Microsoft Daniel - Portuguese (Brazil)", "pt-BR", True), ("Microsoft Maria - Portuguese (Brazil)", "pt-BR", False)]),
    ],
    "es": [
        (4752, True, [("Microsoft Helena - Spanish (Spain)", "es-ES", True), ("Microsoft Laura - Spanish (Spain)", "es-ES", False), ("Microsoft Pablo - Spanish (Spain)", "es-ES", False)]),
    ],
    "it": [
        (2574, True, [("Microsoft Cosimo - Italian (Italy)", "it-IT", True), ("Microsoft Elsa - Italian (Italy)", "it-IT", False)]),
    ],
    "de": [
        (1980, True, [("Microsoft Hedda - German (Germany)", "de-DE", True), ("Microsoft Katja - German (Germany)", "de-DE", False), ("Microsoft Stefan - German (Germany)", "de-DE", False), ("Microsoft David - English (United States)", "en-US", False), ("Microsoft Mark - English (United States)", "en-US", False), ("Microsoft Zira - English (United States)", "en-US", False), ("Microsoft Irina - Russian (Russia)", "ru-RU", False), ("Microsoft Pavel - Russian (Russia)", "ru-RU", False)]),
    ],
}

# Languages with no real capture, taken from Microsoft's Appendix A (supported languages and voices).
# DOCUMENTED, NOT CAPTURED: the voice names are Microsoft's; the display label and the Google voices
# following them follow the captured sets' format and are inferred. Lower confidence than WINDOWS_VOICE_SETS.
DOCUMENTED_WINDOWS_VOICE_SETS = {
    "ja": [(1, True, [('Microsoft Ayumi - Japanese (Japan)', 'ja-JP', True), ('Microsoft Haruka - Japanese (Japan)', 'ja-JP', False), ('Microsoft Ichiro - Japanese (Japan)', 'ja-JP', False)])],
    "ko": [(1, True, [('Microsoft Heami - Korean (Korea)', 'ko-KR', True)])],
    "pl": [(1, True, [('Microsoft Paulina - Polish (Poland)', 'pl-PL', True), ('Microsoft Adam - Polish (Poland)', 'pl-PL', False)])],
    "cs": [(1, True, [('Microsoft Jakub - Czech (Czech Republic)', 'cs-CZ', True)])],
    "hu": [(1, True, [('Microsoft Szabolcs - Hungarian (Hungary)', 'hu-HU', True)])],
    "ro": [(1, True, [('Microsoft Andrei - Romanian (Romania)', 'ro-RO', True)])],
    "sk": [(1, True, [('Microsoft Filip - Slovak (Slovakia)', 'sk-SK', True)])],
    "th": [(1, True, [('Microsoft Pattara - Thai (Thailand)', 'th-TH', True)])],
    "hi": [(1, True, [('Microsoft Kalpana - Hindi (India)', 'hi-IN', True), ('Microsoft Hemant - Hindi (India)', 'hi-IN', False)])],
    "id": [(1, True, [('Microsoft Andika - Indonesian (Indonesia)', 'id-ID', True)])],
    "nl": [(1, True, [('Microsoft Frank - Dutch (Netherlands)', 'nl-NL', True)])],
    "sv": [(1, True, [('Microsoft Bengt - Swedish (Sweden)', 'sv-SE', True)])],
    "da": [(1, True, [('Microsoft Helle - Danish (Denmark)', 'da-DK', True)])],
    "fi": [(1, True, [('Microsoft Heidi - Finnish (Finland)', 'fi-FI', True)])],
    "el": [(1, True, [('Microsoft Stefanos - Greek (Greece)', 'el-GR', True)])],
    "bg": [(1, True, [('Microsoft Ivan - Bulgarian (Bulgaria)', 'bg-BG', True)])],
    "hr": [(1, True, [('Microsoft Matej - Croatian (Croatia)', 'hr-HR', True)])],
    "sl": [(1, True, [('Microsoft Lado - Slovenian (Slovenia)', 'sl-SI', True)])],
    "ms": [(1, True, [('Microsoft Rizwan - Malay (Malaysia)', 'ms-MY', True)])],
    "nb": [(1, True, [('Microsoft Jon - Norwegian (Norway)', 'nb-NO', True)])],
}

ALL_WINDOWS_SETS = {**DOCUMENTED_WINDOWS_VOICE_SETS, **WINDOWS_VOICE_SETS}

_FALLBACK = "en-US"
_GOOGLE_NAMES = frozenset(n for n, _ in GOOGLE_VOICES)
_TAG = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$")


def language_tag(value):
    """First tag of an Accept-Language style value as ``ll-RR`` (case normalised), or ``""``."""
    if not isinstance(value, str):
        return ""
    first = value.split(",")[0].split(";")[0].strip().replace("_", "-")
    if not _TAG.match(first):
        return ""
    lang, *rest = first.split("-")
    return "-".join([lang.lower()] + [p.upper() if (i == 0 and len(p) == 2) else p for i, p in enumerate(rest)])


def _primary(tag):
    return tag.split("-")[0].lower()


def _js(value):
    """``String(value)`` as JavaScript prints it, so the Node and Python keys agree: 8.0 -> "8",
    None -> "undefined"."""
    if value is None:
        return "undefined"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _stable_key(profile):
    voices = (profile.get("speech") or {}).get("voices") or []
    hw = profile.get("hardware") or {}
    disp = profile.get("display") or {}
    names = "\u0001".join(str(v.get("name")) for v in voices)
    return "%s|%s|%s|%sx%s" % (names, _js(hw.get("hardware_concurrency")), _js(hw.get("device_memory_gb")),
                               _js(disp.get("width")), _js(disp.get("height")))


def _pick_weighted(items, key):
    total = sum(w for w, _, _ in items)
    r = int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:16], 16) % total
    for item in items:
        if r < item[0]:
            return item
        r -= item[0]
    return items[-1]


def _to_profile_voices(rows):
    return [{"voice_uri": n, "name": n, "language": lang, "local_service": n not in _GOOGLE_NAMES, "default": d}
            for (n, lang, d) in rows]


def is_chrome_brand(brand):
    """True for the brand the engine treats as branded Google Chrome (``--fingerprint-brand chrome``,
    case-insensitive). Edge, Brave, Opera, an absent brand and the rest do not load Chrome's network voices."""
    return isinstance(brand, str) and brand.strip().lower() == "chrome"


def apply_brand_voices(profile, brand):
    """Brand rule for the network voices, the SDK side of the engine's ``PersonaVoicesForAcceptLanguages``
   . The engine appends the 19 Google network voices after the local ones for a Chrome desktop claim,
    but only when the list holds no network voice at all. So under the Chrome brand a list with none is left to the
    engine (nothing is appended here, which also keeps the engine's built-in 3-name set recognisable), and a list
    with some but not exactly the 19 is made local voices plus exactly the 19, since the engine would leave it as
    it is. Under any other brand every network voice is dropped (Linux then lists nothing). Windows and Linux only;
    the caller skips other platforms."""
    voices = (profile.get("speech") or {}).get("voices") or []
    local = [v for v in voices if v.get("local_service") is not False]

    def with_voices(lst):
        out = dict(profile)
        out["speech"] = {"voices": lst}
        return out

    if not is_chrome_brand(brand):
        return profile if len(local) == len(voices) else with_voices(local)
    network = len(voices) - len(local)
    if network == 0:
        return profile
    if network == len(GOOGLE_VOICES) and all(
            v.get("name") == GOOGLE_VOICES[i][0] for i, v in enumerate(voices[len(local):])):
        return profile
    rows = [(n, lang, not local and i == 0) for i, (n, lang) in enumerate(GOOGLE_VOICES)]
    return with_voices(local + _to_profile_voices(rows))


def cohere_speech(profile, platform, accept_language=None, brand=None):  # noqa: ARG001 - accept_language ignored
    """Rewrite ``profile["speech"]`` for the platform, the persona's own language and the browser brand
    (network voices only under Chrome, see ``apply_brand_voices``). Returns ``(profile, fallback)``."""
    out, fallback = _cohere_speech_by_platform(profile, platform)
    plat = platform.strip().lower() if isinstance(platform, str) else ""
    if plat not in ("linux", "windows", ""):
        return out, fallback
    return apply_brand_voices(out, brand), fallback


def _cohere_speech_by_platform(profile, platform):
    """Rewrite ``profile["speech"]`` for the launch platform and language. Returns
    ``(profile, fallback)``; never modifies the input."""
    plat = platform.strip().lower() if isinstance(platform, str) else ""
    locale = profile.get("locale") or {}
    # Persona language only: the launch language can follow the proxy's exit IP and change per launch.
    tag = language_tag(locale.get("primary_language")) or _FALLBACK

    def with_voices(voices):
        out = dict(profile)
        out["speech"] = {"voices": voices}
        return out

    if plat == "linux":
        return with_voices(_to_profile_voices(LINUX_VOICES)), False
    if plat not in ("windows", ""):
        return profile, False

    low = tag.lower()
    all_sets = [s for lst in ALL_WINDOWS_SETS.values() for s in lst]
    exact = [s for s in all_sets if any(d and lang.lower() == low for _, lang, d in s[2])]
    bare = ALL_WINDOWS_SETS.get(_primary(tag), [])
    has_data = bool(bare)
    if exact:
        pool, want = exact, (lambda lang: lang.lower() == low)
    elif has_data:
        pool, want = bare, (lambda lang: _primary(lang) == _primary(tag))
    else:
        pool = [s for s in WINDOWS_VOICE_SETS.get(_primary(_FALLBACK), []) if any(d and lang == _FALLBACK for _, lang, d in s[2])]
        want = lambda lang: _primary(lang) == _primary(_FALLBACK)  # noqa: E731
    current = next((v for v in ((profile.get("speech") or {}).get("voices") or []) if v.get("default")), None)
    if current is not None and want(current.get("language", "")):
        # Stock Chrome marks the first listed voice as the default (speech_synthesis_impl.cc:
        # ``is_default = (i == 0)``), so a default anywhere else is a tell.
        voices = (profile.get("speech") or {}).get("voices") or []
        at = next(i for i, v in enumerate(voices) if v.get("default"))
        if at == 0:
            return profile, not has_data
        return with_voices([voices[at]] + [v for i, v in enumerate(voices) if i != at]), not has_data
    w, net, local = _pick_weighted(pool, _stable_key(profile))
    rows = list(local) + ([(n, lang, False) for n, lang in GOOGLE_VOICES] if net else [])
    return with_voices(_to_profile_voices(rows)), not has_data


#: The engine's built-in default Windows voice set. The engine recognises it by
#: exactly these three names in this order and then
#: rebuilds the list for the Accept-Language at runtime (``PersonaVoicesForAcceptLanguages``). Any other
#: list is treated as a real capture and passed through unchanged.
BUILTIN_WINDOWS_VOICES = (
    ("Microsoft David - English (United States)", "en-US", True),
    ("Microsoft Zira - English (United States)", "en-US", False),
    ("Microsoft Mark - English (United States)", "en-US", False),
)


def builtin_speech_voices():
    """The built-in set as profile ``speech.voices`` entries."""
    return _to_profile_voices(BUILTIN_WINDOWS_VOICES)


def _default_voice_language(voices):
    if not isinstance(voices, list) or not voices:
        return ""
    d = next((v for v in voices if isinstance(v, dict) and v.get("default") is True), voices[0])
    lang = d.get("language") if isinstance(d, dict) else None
    return lang if isinstance(lang, str) else ""


def speech_values_for_locale(values, locale_tag):
    """Generator rule: of the model's ``speech`` values, those whose DEFAULT voice's primary language
    equals the persona's (en matches en-US and en-GB); an exact tag match is preferred. ``[]`` when
    nothing fits (the caller then uses ``builtin_speech_voices()``). Input order is kept."""
    tag = language_tag(locale_tag) or _FALLBACK

    def lang(v):
        payload = v.get("payload")
        return _default_voice_language(payload.get("voices") if isinstance(payload, dict) else None)

    exact = [v for v in values if lang(v).replace("_", "-").lower() == tag.lower()]
    if exact:
        return exact
    return [v for v in values if lang(v) != "" and _primary(lang(v)) == _primary(tag)]


def builtin_speech_if_contradicting(profile, platform, accept_language=None):
    """Safety net (launch payload only, never saved). A Windows persona whose default voice language
    contradicts the persona's OWN language (``locale.primary_language``, the generator filter's source) gets
    the built-in set. The launch Accept-Language is never consulted (argument accepted and ignored): the
    engine hashes voices into the persona key, so launch-dependent voices would change the key per launch.
    Other platforms and a list that already agrees are returned untouched."""
    plat = platform.strip().lower() if isinstance(platform, str) else ""
    if plat not in ("windows", ""):
        return profile
    own = language_tag((profile.get("locale") or {}).get("primary_language")) or _FALLBACK
    dv = _default_voice_language((profile.get("speech") or {}).get("voices"))
    if not dv or _primary(dv) == _primary(own):
        return profile
    out = dict(profile)
    out["speech"] = {"voices": builtin_speech_voices()}
    return out
