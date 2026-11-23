"""WebGL limit coherence of a persona profile, mirroring the engine's strict loader.

ONE table keyed by (os_family, browser_family). Each row lists the relations as data (the sum of
the ``sum`` limits must not exceed the ``max`` limit) and the engine's own value for each limit a
profile leaves out. Evaluation is over the MERGED record: webgl1 first, then webgl2 overwriting key
by key. A relation is evaluated, with absent limits filled from the row's defaults, when at least
one of its limits is present; a relation with none present is skipped. A present limit that is not
a non-negative integer is a violation. A pair without a row has no rule; a new platform or browser
family is a new row. Keep in step with the engine and the Node SDK.
"""

_CHROMIUM_DESKTOP = {
    "relations": (
        (("MAX_VERTEX_UNIFORM_BLOCKS", "MAX_FRAGMENT_UNIFORM_BLOCKS"), "MAX_COMBINED_UNIFORM_BLOCKS"),
        (("MAX_COMBINED_UNIFORM_BLOCKS",), "MAX_UNIFORM_BUFFER_BINDINGS"),
        (("MAX_VERTEX_TEXTURE_IMAGE_UNITS", "MAX_TEXTURE_IMAGE_UNITS"), "MAX_COMBINED_TEXTURE_IMAGE_UNITS"),
    ),
    "defaults": {
        "MAX_VERTEX_UNIFORM_BLOCKS": 12,
        "MAX_FRAGMENT_UNIFORM_BLOCKS": 12,
        "MAX_COMBINED_UNIFORM_BLOCKS": 24,
        "MAX_UNIFORM_BUFFER_BINDINGS": 24,
        "MAX_VERTEX_TEXTURE_IMAGE_UNITS": 16,
        "MAX_TEXTURE_IMAGE_UNITS": 16,
        "MAX_COMBINED_TEXTURE_IMAGE_UNITS": 32,
    },
}

# Rule rows by (os_family, browser_family).
WEBGL_COHERENCE_RULES = {
    ("windows", "chromium"): _CHROMIUM_DESKTOP,
    ("linux", "chromium"): _CHROMIUM_DESKTOP,
    ("macos", "chromium"): _CHROMIUM_DESKTOP,
}


def _is_count(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 0
    return isinstance(value, float) and value.is_integer() and value >= 0


def webgl_limit_violations(os_family, browser_family, webgl1, webgl2):
    """Violations, as readable strings, in the merged record of two parameter dicts.

    Message: ``incoherent WebGL limits: webgl2 A (14) + B (12) exceeds C (24)``; the set label is
    webgl2 when any limit of the relation comes from webgl2, else webgl1. Empty for an unknown pair.
    """
    row = WEBGL_COHERENCE_RULES.get((os_family, browser_family))
    if row is None:
        return []
    webgl1 = webgl1 or {}
    webgl2 = webgl2 or {}

    def find(key):
        if key in webgl2:
            return webgl2[key], "webgl2"
        if key in webgl1:
            return webgl1[key], "webgl1"
        return None

    out = []
    reported = set()
    for sums, maximum in row["relations"]:
        keys = [*sums, maximum]
        if all(find(k) is None for k in keys):
            continue
        usable = True
        label = "webgl1"
        values = []
        for k in keys:
            found = find(k)
            if found is not None:
                value, source = found
                if source == "webgl2":
                    label = "webgl2"
                if not _is_count(value):
                    usable = False
                    if k not in reported:
                        reported.add(k)
                        out.append(f"{k} must be a non-negative integer, got {value!r}")
                    continue
                values.append(int(value))
            elif k in row["defaults"]:
                values.append(row["defaults"][k])
            else:
                usable = False
        if not usable:
            continue
        total = sum(values[:-1])
        if total > values[-1]:
            terms = " + ".join(f"{k} ({v})" for k, v in zip(sums, values))
            out.append(f"incoherent WebGL limits: {label} {terms} exceeds {maximum} ({values[-1]})")
    return out
