"""Optional HLSL shader dialect for a Windows persona on a non-Windows host.

``WEBGL_debug_shaders.getTranslatedShaderSource()`` returns whatever ANGLE's active backend
produced. A Windows persona advertises a Direct3D11 renderer, but on a Linux host the Vulkan
backend answers with a SPIR-V dump, so the renderer string and the dialect beside it contradict
each other. ``shader_dialect="hlsl"`` makes the engine re-translate the shader to HLSL for that
query alone -- rendering is untouched, and the result is byte-identical to what the Windows build
reports.

OFF unless asked for. The re-translation is a different code path from the one that rendered, so a
shader the Vulkan backend accepts but the HLSL translator rejects falls back to the honest SPIR-V
for that shader. It is for callers who actually hit this check, not a default.

Delivered as an environment variable because the code lives in the GPU process, which does not
receive the fingerprint switches.

Requires an engine built with the option; older binaries ignore the variable.
"""

import os
from ._errors import SdkValueError

ENV_VAR = "ANT0_BROWSER_SHADER_DIALECT"
_VALID = ("hlsl",)


def apply_shader_dialect(value, pw_kwargs):
    """Merge ``ANT0_BROWSER_SHADER_DIALECT`` into ``pw_kwargs['env']``.

    No-op when ``value`` is falsy, so the default launch env is left untouched. Playwright replaces
    the child env when ``env`` is set, so ``os.environ`` is the base when nothing has built the env
    yet.

    Call this AFTER ``apply_font_env``: that one rebuilds the dict from ``os.environ`` and would
    drop this variable if it ran second.
    """
    if not value:
        return
    dialect = str(value).strip().lower()
    if dialect not in _VALID:
        raise SdkValueError("sdk.shader_dialect_invalid", 
            "shader_dialect must be one of %s (got %r)" % (", ".join(_VALID), value))
    merged = dict(pw_kwargs.get("env") or os.environ)
    merged[ENV_VAR] = dialect
    pw_kwargs["env"] = merged
