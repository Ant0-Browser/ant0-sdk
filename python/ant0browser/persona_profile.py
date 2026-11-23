"""Validation for the canonical persona-profile-v2 contract."""

import datetime
import math
import re

if __package__:
    from ._errors import Coded, EXPECTED
    from ._webgl_coherence import webgl_limit_violations
else:
    # This file may be loaded by path, outside the package: take the sibling module.
    import importlib.util as _util
    import os as _os

    _spec = _util.spec_from_file_location(
        "ant0_sdk_errors", _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "_errors.py"))
    _errors = _util.module_from_spec(_spec)
    _spec.loader.exec_module(_errors)
    Coded, EXPECTED = _errors.Coded, _errors.EXPECTED
    _gl_spec = _util.spec_from_file_location(
        "ant0_sdk_webgl_coherence",
        _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "_webgl_coherence.py"))
    _gl_module = _util.module_from_spec(_gl_spec)
    _gl_spec.loader.exec_module(_gl_module)
    webgl_limit_violations = _gl_module.webgl_limit_violations


class PersonaProfileValidationError(Coded, ValueError):
    """A persona profile violation with the offending dotted field path."""

    code = "sdk.persona_profile_invalid"
    error_class = EXPECTED

    def __init__(self, path, message):
        self.path = path
        self.message = message
        super().__init__(f"{path}: {message}" if path else message)


def _fail(path, message):
    raise PersonaProfileValidationError(path, message)


def _field(path, name):
    return f"{path}.{name}" if path else name


def _object(value, path, required, optional=()):
    if type(value) is not dict:
        _fail(path, "must be an object")
    allowed = set(required) | set(optional)
    unknown = next((key for key in value if key not in allowed), None)
    if unknown is not None:
        _fail(_field(path, str(unknown)), "unknown field")
    missing = next((key for key in required if key not in value), None)
    if missing is not None:
        _fail(_field(path, missing), "required field is missing")
    return value


def _string(value, path, minimum=1, maximum=512, pattern=None):
    if type(value) is not str:
        _fail(path, "must be a string")
    if len(value) < minimum:
        _fail(path, f"must contain at least {minimum} character(s)")
    if len(value) > maximum:
        _fail(path, f"must contain at most {maximum} character(s)")
    if pattern is not None and re.fullmatch(pattern, value) is None:
        _fail(path, "has an invalid format")


def _number(value, path, minimum=None, maximum=None, exclusive_minimum=False):
    if type(value) not in (int, float) or not math.isfinite(value):
        _fail(path, "must be a finite number")
    if minimum is not None and (value <= minimum if exclusive_minimum else value < minimum):
        operator = "greater than" if exclusive_minimum else "at least"
        _fail(path, f"must be {operator} {minimum}")
    if maximum is not None and value > maximum:
        _fail(path, f"must be at most {maximum}")


def _integer(value, path, minimum=None, maximum=None):
    # JSON Schema treats integral JSON numbers such as 8.0 as integers.
    if not (type(value) is int or (type(value) is float and math.isfinite(value) and value.is_integer())):
        _fail(path, "must be an integer")
    _number(value, path, minimum, maximum)


def _boolean(value, path):
    if type(value) is not bool:
        _fail(path, "must be a boolean")


def _enum(value, path, choices):
    def matches(choice):
        if type(value) is type(choice):
            return value == choice
        # JSON Schema has one numeric domain: 8 and 8.0 are the same enum value.
        return type(value) in (int, float) and type(choice) in (int, float) and value == choice

    if not any(matches(choice) for choice in choices):
        _fail(path, f"must be one of {choices!r}")


def _array(value, path, minimum=0):
    if type(value) is not list:
        _fail(path, "must be an array")
    if len(value) < minimum:
        _fail(path, f"must contain at least {minimum} item(s)")
    return value


def _string_array(value, path, minimum=0):
    values = _array(value, path, minimum)
    seen = set()
    for index, item in enumerate(values):
        item_path = f"{path}.{index}"
        _string(item, item_path)
        if item in seen:
            _fail(item_path, "must be unique")
        seen.add(item)


def _date_time(value, path):
    if type(value) is not str:
        _fail(path, "must be a string")
    # JSON Schema date-time is RFC 3339 and requires an explicit timezone.
    if re.fullmatch(
        r"\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})", value
    ) is None:
        _fail(path, "must be an RFC 3339 date-time")
    try:
        datetime.datetime.fromisoformat(value[:-1] + "+00:00" if value[-1:].lower() == "z" else value)
    except ValueError:
        _fail(path, "must be an RFC 3339 date-time")


def _validate_metadata(value):
    obj = _object(value, "metadata", ("source", "created_at"), ("generator", "source_references"))
    _enum(obj["source"], "metadata.source", ("synthetic", "captured"))
    _date_time(obj["created_at"], "metadata.created_at")
    if obj["source"] == "synthetic" and "generator" not in obj:
        _fail("metadata.generator", "required for a synthetic profile")
    if "generator" in obj:
        generator = _object(
            obj["generator"], "metadata.generator", ("name", "version", "model_version")
        )
        _string(generator["name"], "metadata.generator.name", maximum=64)
        _string(generator["version"], "metadata.generator.version", maximum=64)
        _string(generator["model_version"], "metadata.generator.model_version", maximum=128)
    if "source_references" in obj:
        for index, reference in enumerate(_array(obj["source_references"], "metadata.source_references")):
            path = f"metadata.source_references.{index}"
            reference = _object(reference, path, ("name", "revision", "sha256"))
            _string(reference["name"], f"{path}.name", maximum=128)
            _string(reference["revision"], f"{path}.revision", maximum=128)
            _string(reference["sha256"], f"{path}.sha256", pattern=r"[0-9a-f]{64}")


def _validate_compatibility(value):
    obj = _object(
        value,
        "compatibility",
        ("os_family", "architecture", "browser_family", "browser_major"),
    )
    for name, expected in (
        ("os_family", "windows"),
        ("architecture", "x86_64"),
        ("browser_family", "chromium"),
    ):
        _enum(obj[name], f"compatibility.{name}", (expected,))
    # Informational: the engine reports its own build's version, so a persona issued for
    # another Chromium major stays valid across engine upgrades.
    major = obj["browser_major"]
    if type(major) is not int or type(major) is bool:
        _fail("compatibility.browser_major", "must be an integer")
    if not 100 <= major <= 999:
        _fail("compatibility.browser_major", "must be between 100 and 999")


def _validate_hardware(value):
    obj = _object(
        value, "hardware", ("hardware_concurrency", "device_memory_gb", "js_heap_size_limit")
    )
    _integer(obj["hardware_concurrency"], "hardware.hardware_concurrency", 1, 256)
    _enum(obj["device_memory_gb"], "hardware.device_memory_gb", (0.25, 0.5, 1, 2, 4, 8, 16, 32))
    _integer(obj["js_heap_size_limit"], "hardware.js_heap_size_limit", 1073741824, 17179869184)


def _validate_display(value):
    fields = (
        "width", "height", "available_width", "available_height", "color_depth", "pixel_depth",
        "device_pixel_ratio", "max_touch_points", "pointer", "hover", "color_gamut",
        "dynamic_range",
    )
    obj = _object(value, "display", fields)
    for name, minimum, maximum in (
        ("width", 320, 16384), ("height", 240, 8640),
        ("available_width", 1, 16384), ("available_height", 1, 8640),
        ("color_depth", 1, 64), ("pixel_depth", 1, 64),
        ("max_touch_points", 0, 32),
    ):
        _integer(obj[name], f"display.{name}", minimum, maximum)
    _number(obj["device_pixel_ratio"], "display.device_pixel_ratio", 0, 8, exclusive_minimum=True)
    _enum(obj["pointer"], "display.pointer", ("none", "coarse", "fine"))
    _enum(obj["hover"], "display.hover", ("none", "hover"))
    _enum(obj["color_gamut"], "display.color_gamut", ("srgb", "p3", "rec2020"))
    _enum(obj["dynamic_range"], "display.dynamic_range", ("standard", "high"))
    if obj["available_width"] > obj["width"]:
        _fail("display.available_width", "must not exceed display.width")
    if obj["available_height"] > obj["height"]:
        _fail("display.available_height", "must not exceed display.height")
    if obj["pixel_depth"] != obj["color_depth"]:
        _fail("display.pixel_depth", "must equal display.color_depth")


_GL_PARAMETERS = {
    "MAX_TEXTURE_SIZE", "MAX_CUBE_MAP_TEXTURE_SIZE", "MAX_RENDERBUFFER_SIZE", "MAX_VIEWPORT_DIMS",
    "MAX_VARYING_VECTORS", "MAX_VERTEX_UNIFORM_VECTORS", "MAX_FRAGMENT_UNIFORM_VECTORS",
    "MAX_COMBINED_TEXTURE_IMAGE_UNITS", "MAX_3D_TEXTURE_SIZE", "MAX_ARRAY_TEXTURE_LAYERS",
    "MAX_DRAW_BUFFERS", "MAX_COLOR_ATTACHMENTS", "MAX_SAMPLES", "MAX_VERTEX_UNIFORM_BLOCKS",
    "MAX_FRAGMENT_UNIFORM_BLOCKS", "MAX_COMBINED_UNIFORM_BLOCKS", "MAX_UNIFORM_BUFFER_BINDINGS",
    "MAX_VERTEX_UNIFORM_COMPONENTS", "MAX_FRAGMENT_UNIFORM_COMPONENTS", "MAX_TEXTURE_LOD_BIAS",
    "RED_BITS", "GREEN_BITS", "BLUE_BITS", "ALPHA_BITS", "DEPTH_BITS", "STENCIL_BITS",
    "SUBPIXEL_BITS", "SAMPLE_BUFFERS", "SAMPLES", "MAX_TEXTURE_MAX_ANISOTROPY_EXT",
    "ALIASED_LINE_WIDTH_RANGE", "ALIASED_POINT_SIZE_RANGE",
    "MAX_TEXTURE_IMAGE_UNITS", "MAX_VERTEX_TEXTURE_IMAGE_UNITS", "MAX_VERTEX_ATTRIBS",
    "MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS", "UNIFORM_BUFFER_OFFSET_ALIGNMENT",
    "STENCIL_VALUE_MASK", "STENCIL_WRITEMASK", "STENCIL_BACK_VALUE_MASK", "STENCIL_BACK_WRITEMASK",
}

_WEBGPU_LIMITS = {
    "maxTextureDimension1D", "maxTextureDimension2D", "maxTextureDimension3D",
    "maxTextureArrayLayers", "maxBindGroups", "maxBindGroupsPlusVertexBuffers",
    "maxBindingsPerBindGroup", "maxDynamicUniformBuffersPerPipelineLayout",
    "maxDynamicStorageBuffersPerPipelineLayout", "maxSampledTexturesPerShaderStage",
    "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage",
    "maxStorageTexturesPerShaderStage", "maxUniformBuffersPerShaderStage",
    "maxUniformBufferBindingSize", "maxStorageBufferBindingSize", "minUniformBufferOffsetAlignment",
    "minStorageBufferOffsetAlignment", "maxVertexBuffers", "maxBufferSize", "maxVertexAttributes",
    "maxVertexBufferArrayStride", "maxInterStageShaderVariables", "maxColorAttachments",
    "maxColorAttachmentBytesPerSample", "maxComputeWorkgroupStorageSize",
    "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY",
    "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension",
    "maxStorageBuffersInFragmentStage", "maxStorageTexturesInFragmentStage",
    "maxStorageBuffersInVertexStage", "maxStorageTexturesInVertexStage",
}


def _validate_webgl_version(value, path):
    obj = _object(value, path, ("parameters", "extensions"))
    parameters = obj["parameters"]
    if type(parameters) is not dict:
        _fail(f"{path}.parameters", "must be an object")
    if not parameters:
        _fail(f"{path}.parameters", "must contain at least one property")
    for name, parameter in parameters.items():
        parameter_path = f"{path}.parameters.{name}"
        if name not in _GL_PARAMETERS:
            _fail(parameter_path, "unknown WebGL parameter")
        if type(parameter) is list:
            if len(parameter) != 2:
                _fail(parameter_path, "array value must contain exactly two numbers")
            for index, item in enumerate(parameter):
                _number(item, f"{parameter_path}.{index}")
        else:
            _number(parameter, parameter_path)
    _string_array(obj["extensions"], f"{path}.extensions")


def _gpu_families(text):
    text = text.lower()
    families = (
        ("intel", r"\bintel\b|\bgen[- ]?\d|(?:0x)?8086\b"),
        ("nvidia", r"\bnvidia\b|\bgeforce\b|\bquadro\b|\b[rg]tx\s*\d|(?:0x)?10de\b"),
        ("amd", r"\bamd\b|advanced micro devices|\bati\b|\bradeon\b|\brdna\b|(?:0x)?1002\b"),
        ("qualcomm", r"\bqualcomm\b|\badreno\b|(?:0x)?17cb\b"),
        ("software", r"swiftshader|\bwarp\b|software adapter"),
    )
    return {family for family, pattern in families if re.search(pattern, text)}


def _validate_graphics(value):
    graphics = _object(value, "graphics", ("webgl", "webgpu"))
    webgl = _object(
        graphics["webgl"], "graphics.webgl",
        ("unmasked_vendor", "unmasked_renderer", "webgl1", "webgl2"),
    )
    _string(webgl["unmasked_vendor"], "graphics.webgl.unmasked_vendor")
    _string(webgl["unmasked_renderer"], "graphics.webgl.unmasked_renderer")
    _validate_webgl_version(webgl["webgl1"], "graphics.webgl.webgl1")
    _validate_webgl_version(webgl["webgl2"], "graphics.webgl.webgl2")

    webgpu = _object(
        graphics["webgpu"], "graphics.webgpu",
        ("vendor", "architecture", "is_fallback_adapter", "features", "limits"),
        ("device", "description"),
    )
    _string(webgpu["vendor"], "graphics.webgpu.vendor")
    _string(webgpu["architecture"], "graphics.webgpu.architecture")
    for name, maximum in (("device", 256), ("description", 512)):
        if name in webgpu:
            _string(webgpu[name], f"graphics.webgpu.{name}", minimum=0, maximum=maximum)
    _boolean(webgpu["is_fallback_adapter"], "graphics.webgpu.is_fallback_adapter")
    _string_array(webgpu["features"], "graphics.webgpu.features")
    limits = webgpu["limits"]
    if type(limits) is not dict:
        _fail("graphics.webgpu.limits", "must be an object")
    if not limits:
        _fail("graphics.webgpu.limits", "must contain at least one property")
    for name, limit in limits.items():
        path = f"graphics.webgpu.limits.{name}"
        if name not in _WEBGPU_LIMITS:
            _fail(path, "unknown WebGPU limit")
        _integer(limit, path, 0, 9007199254740991)

    gl_families = _gpu_families(f"{webgl['unmasked_vendor']} {webgl['unmasked_renderer']}")
    gpu_text = " ".join(str(webgpu.get(name, "")) for name in ("vendor", "architecture", "device", "description"))
    gpu_families = _gpu_families(gpu_text)
    if gl_families and gpu_families and (len(gl_families) != 1 or gpu_families != gl_families):
        _fail("graphics.webgpu.vendor", "must identify one GPU family matching graphics.webgl")


def _validate_audio(value):
    obj = _object(value, "audio", ("sample_rate", "base_latency", "output_latency"))
    _number(obj["sample_rate"], "audio.sample_rate", 8000, 384000)
    _number(obj["base_latency"], "audio.base_latency", 0, 10)
    _number(obj["output_latency"], "audio.output_latency", 0, 10)


def _validate_network(value):
    obj = _object(value, "network", (), ("rtt_ms", "downlink_mbps", "effective_type"))
    if "rtt_ms" in obj:
        _number(obj["rtt_ms"], "network.rtt_ms", 0, 3000, exclusive_minimum=True)
    if "downlink_mbps" in obj:
        _number(obj["downlink_mbps"], "network.downlink_mbps", 0, 1000, exclusive_minimum=True)
    if "effective_type" in obj:
        _enum(obj["effective_type"], "network.effective_type", ("slow-2g", "2g", "3g", "4g"))


def _validate_speech(value):
    obj = _object(value, "speech", ("voices",))
    voices = _array(obj["voices"], "speech.voices", 1)
    defaults = 0
    for index, voice in enumerate(voices):
        path = f"speech.voices.{index}"
        voice = _object(voice, path, ("voice_uri", "name", "language", "local_service", "default"))
        for name in ("voice_uri", "name", "language"):
            _string(voice[name], f"{path}.{name}")
        _boolean(voice["local_service"], f"{path}.local_service")
        _boolean(voice["default"], f"{path}.default")
        defaults += int(voice["default"])
    if defaults > 1:
        _fail("speech.voices", "must contain at most one default voice")


def _validate_media(value):
    media = _object(value, "media", ("codecs", "devices"))
    codec_names = ("h264", "vp8", "vp9", "av1", "hevc")
    codecs = _object(media["codecs"], "media.codecs", codec_names)
    for codec_name in codec_names:
        path = f"media.codecs.{codec_name}"
        codec = _object(codecs[codec_name], path, ("supported", "smooth", "power_efficient"))
        for name in ("supported", "smooth", "power_efficient"):
            _boolean(codec[name], f"{path}.{name}")
    for index, device in enumerate(_array(media["devices"], "media.devices", 1)):
        path = f"media.devices.{index}"
        device = _object(device, path, ("kind", "label", "device_id", "group_id"))
        _enum(device["kind"], f"{path}.kind", ("audioinput", "audiooutput", "videoinput"))
        _string(device["label"], f"{path}.label", minimum=0, maximum=256)
        _string(device["device_id"], f"{path}.device_id")
        _string(device["group_id"], f"{path}.group_id")


def validate_persona_profile(profile):
    """Validate and return a persona-profile-v2 mapping.

    Raises :class:`PersonaProfileValidationError` at the first invalid dotted field path.
    The input is not copied or mutated, so it can flow directly into a later encoder.
    """
    sections = (
        "schema_version", "metadata", "compatibility", "hardware", "display", "locale",
        "graphics", "audio", "fonts", "speech", "media",
    )
    obj = _object(profile, "", sections, ("network",))
    if "network" in obj:
        _validate_network(obj["network"])
    _enum(obj["schema_version"], "schema_version", (2,))
    _validate_metadata(obj["metadata"])
    _validate_compatibility(obj["compatibility"])
    _validate_hardware(obj["hardware"])
    _validate_display(obj["display"])

    locale = _object(obj["locale"], "locale", ("primary_language", "languages", "timezone"))
    _string(locale["primary_language"], "locale.primary_language")
    _string_array(locale["languages"], "locale.languages", 1)
    _string(locale["timezone"], "locale.timezone")
    if locale["languages"][0] != locale["primary_language"]:
        _fail("locale.languages", "first language must equal locale.primary_language")

    _validate_graphics(obj["graphics"])
    # Limits no driver produces: rejected like the engine's strict loader does, so the profile
    # cannot launch silently with no persona.
    _gl = obj["graphics"]["webgl"]
    _violations = webgl_limit_violations(
        obj["compatibility"]["os_family"], obj["compatibility"]["browser_family"],
        _gl["webgl1"]["parameters"], _gl["webgl2"]["parameters"],
    )
    if _violations:
        _fail("graphics.webgl.parameters", _violations[0])
    _validate_audio(obj["audio"])
    fonts = _object(obj["fonts"], "fonts", ("families",))
    _string_array(fonts["families"], "fonts.families", 1)
    _validate_speech(obj["speech"])
    _validate_media(obj["media"])
    return profile


__all__ = ["PersonaProfileValidationError", "validate_persona_profile"]
