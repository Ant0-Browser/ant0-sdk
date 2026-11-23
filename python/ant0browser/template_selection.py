"""Pure deterministic selection from validated persona-profile-v2 templates."""

import copy
import hashlib
import re
import struct
from typing import Any, Collection, Dict, Mapping, TypedDict

from ._errors import SdkTypeError, SdkValueError
from .persona_profile import validate_persona_profile


_DOMAIN = b"ant0/persona-template-selection/v1\0"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class PersonaTemplate(TypedDict):
    """A stable template ID and its complete canonical profile."""

    id: str
    profile: Dict[str, Any]


def _key_bytes(value: str, name: str) -> bytes:
    if not isinstance(value, str):
        raise SdkTypeError("sdk.template_invalid", f"{name} must be a string")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise SdkValueError("sdk.template_invalid", f"{name} must contain only Unicode scalar values")
    return value.encode("utf-8")


def _select_persona_template_entry(
    identity_key: str,
    device_key: str,
    templates: Collection[PersonaTemplate],
) -> PersonaTemplate:
    """Select and deep-copy one template using the v1 selection algorithm.

    Every template is validated before selection. Input order therefore cannot affect either the
    selected profile or whether the pool is accepted.
    """
    identity = _key_bytes(identity_key, "identity_key")
    device = _key_bytes(device_key, "device_key")
    ordered = []
    seen = set()
    for template in templates:
        if not isinstance(template, Mapping) or set(template) != {"id", "profile"}:
            raise SdkTypeError("sdk.template_invalid", "each template must contain exactly id and profile")
        template_id = template["id"]
        if not isinstance(template_id, str) or not _SAFE_ID.fullmatch(template_id):
            raise SdkValueError("sdk.template_invalid", f"unsafe template id: {template_id!r}")
        if template_id in seen:
            raise SdkValueError("sdk.template_invalid", f"duplicate template id: {template_id!r}")
        seen.add(template_id)
        validate_persona_profile(template["profile"])
        ordered.append(template)
    if not ordered:
        raise SdkValueError("sdk.template_invalid", "template pool must not be empty")

    ordered.sort(key=lambda template: template["id"])
    digest = hashlib.sha256(
        _DOMAIN
        + struct.pack(">Q", len(identity)) + identity
        + struct.pack(">Q", len(device)) + device
    ).digest()
    selected = ordered[int.from_bytes(digest, "big") % len(ordered)]
    return copy.deepcopy(selected)


def select_persona_template(
    identity_key: str,
    device_key: str,
    templates: Collection[PersonaTemplate],
) -> Dict[str, Any]:
    """Select and deep-copy one complete profile using the v1 selection algorithm."""
    return _select_persona_template_entry(identity_key, device_key, templates)["profile"]


__all__ = ["PersonaTemplate", "select_persona_template"]
