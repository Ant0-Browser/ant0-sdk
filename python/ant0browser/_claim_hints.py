"""Hints a caller may send when it asks the cloud to issue an identity (the ``hints`` field of the
profile claim request).

The SDK has no request path to the daemon or the cloud for identities (the daemon owns the claim),
so these are types only. The daemon passes the same shape through."""

from typing import List, Literal, TypedDict

ClaimBrand = Literal["chrome", "edge"]
ClaimHostGpuVendor = Literal["intel", "nvidia", "amd", "apple"]


class _ClaimLocaleRequired(TypedDict):
    #: BCP 47 tag of the OS language, e.g. "en-US".
    os_language: str
    #: IANA timezone, e.g. "America/New_York".
    timezone: str


class ClaimLocale(_ClaimLocaleRequired, total=False):
    #: One to eight BCP 47 tags; the cloud moves ``os_language`` to the front when it is not first.
    languages: List[str]


class ClaimHints(TypedDict, total=False):
    os_family: str
    browser_major: int
    #: Population model version, ``^[a-z0-9][a-z0-9._-]{0,63}$``. Fresh issuance only.
    model_version: str
    brand: ClaimBrand
    locale: ClaimLocale
    #: Whether the claiming host presents its real GPU (default False).
    host_gpu: bool
    host_gpu_vendor: ClaimHostGpuVendor
    #: The engine's ``--ant0-sdk-info`` ``persona.capabilities``: at most 64 ids matching
    #: ``^[a-z0-9_.]{1,64}$``, no duplicates. Sent with a model version.
    engine_capabilities: List[str]


__all__ = ["ClaimBrand", "ClaimHostGpuVendor", "ClaimLocale", "ClaimHints"]
