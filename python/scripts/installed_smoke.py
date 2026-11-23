"""Check an installed SDK, not checkout imports, without engine/account access (see README)."""

import asyncio
import inspect
import sysconfig
from importlib import metadata
from pathlib import Path

import maxminddb
from playwright import async_api as playwright_async, sync_api as playwright_sync

import ant0browser
from ant0browser import async_api


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    installed = Path(ant0browser.__file__).resolve()
    site_packages = Path(sysconfig.get_path("purelib")).resolve()
    check(site_packages in installed.parents, "SDK must resolve from this venv's site-packages")
    distribution = metadata.distribution("ant0-browser")
    check(distribution.version == ant0browser.__version__ == async_api.__version__, "version mismatch")
    check(distribution.metadata["License"] == "BSD-3-Clause", "license metadata mismatch")
    licenses = [file for file in distribution.files or () if str(file).endswith("/licenses/LICENSE")]
    check(len(licenses) == 1, "installed license missing")
    check("BSD 3-Clause License" in distribution.locate_file(licenses[0]).read_text(encoding="utf-8"),
          "license content mismatch")
    requirements = distribution.requires or ()
    check(any(item.startswith("playwright>=") for item in requirements), "Playwright dependency missing")
    check(any(item.startswith("maxminddb>=") for item in requirements), "MaxMind dependency missing")
    check(callable(playwright_sync.sync_playwright), "sync Playwright import failed")
    check(callable(playwright_async.async_playwright), "async Playwright import failed")
    check(callable(maxminddb.open_database), "MaxMind import failed")
    check(inspect.iscoroutinefunction(async_api.launch), "async launch is not a coroutine")
    check(callable(ant0browser.launch_persistent_context) and callable(ant0browser.serve),
          "public sync imports missing")
    check(ant0browser.CHROMIUM_MAJOR == int(ant0browser.CHROMIUM_VERSION.split(".")[0]),
          "Chromium major mismatch")
    check(ant0browser.CHROMIUM_UA_VERSION == f"{ant0browser.CHROMIUM_MAJOR}.0.0.0",
          "Chromium UA version mismatch")
    check(ant0browser.resolve_identity({"mode": "native"}) == ("native", {}), "native identity mismatch")
    # Public shared test vector: not a real device key and never persisted.
    check(ant0browser.identity_filename("account-42", bytes(range(32))) ==
          "5f3899096575bd43b8a0f24f354c057f43fa8d63ec7592cc15c5d7505d508566.json",
          "deterministic identity filename mismatch")
    try:
        ant0browser.validate_persona_profile({})
    except ant0browser.PersonaProfileValidationError:
        pass
    else:
        raise AssertionError("invalid persona must be rejected")

    # Invalid identity fails before binary lookup, ticket discovery or Playwright startup.
    invalid = {"identity": {"mode": "invalid"}, "ephemeral_profile": False, "launch_ticket": False}
    try:
        ant0browser.launch(**invalid)
    except ValueError as error:
        check("identity.mode must be one of" in str(error), "unexpected sync validation error")
    else:
        raise AssertionError("sync launch must reject invalid identity")

    async def check_async():
        try:
            await async_api.launch(**invalid)
        except ValueError as error:
            check("identity.mode must be one of" in str(error), "unexpected async validation error")
        else:
            raise AssertionError("async launch must reject invalid identity")

    asyncio.run(check_async())
    print(f"installed Python SDK smoke passed: {distribution.version} (engine-free)")


if __name__ == "__main__":
    main()
