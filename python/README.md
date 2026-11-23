<img src="https://ant0.link/icon-192.png" width="64" alt="Ant0 Browser">

# Ant0 Browser SDK for Python

A Playwright-compatible SDK for launching a separately installed Ant0 Browser engine from Python.

[Python SDK guide](https://docs.ant0.link/sdk#python) · [Support](https://ant0.link/contact)

The `ant0-browser` package contains the SDK, not the browser engine, an Ant0 account or licence, or synthetic-identity assets. SDK code is BSD-3-Clause licensed; the engine is installed and licensed separately.

## Before you install

**System requirements, Linux:** glibc 2.39 or newer (Ubuntu 24.04+, Debian 13+). Older distributions are not supported. This applies to the Ant0 application, the engine and the native bindings.

Direct SDK launches require all of the following:

1. Install the Ant0 application and its licensed Ant0 Browser engine.
2. Complete sign-in in the Ant0 application; its local `ant0d` daemon uses that signed-in, licensed state to provide launch tickets.
3. Set `ANT0_BROWSER_BINARY` to the absolute path of that installation's engine executable before starting Python.

The SDK checks that the executable is an Ant0 build; stock Chrome or Chromium is not a substitute. SDK package version `0.2.2` and the installed engine release version are independent.

## Install

```bash
python -m pip install ant0-browser==0.2.2
```

0.2.2 is the current release. A plain `pip install ant0-browser` installs it too.

Package metadata declares Python 3.9 or newer. See the qualification table below for tested environments. Do not run `playwright install`: the SDK uses the separately installed Ant0 engine, not Playwright's stock browser downloads.

## Quick start: synchronous API

Save as `example.py` and run `python example.py`. This native-identity example needs no synthetic assets.

```python
from ant0browser import launch


def main():
    browser = launch(identity={"mode": "native"})
    try:
        page = browser.new_page()
        page.goto("https://example.com")
        print(page.title())
    finally:
        browser.close()


if __name__ == "__main__":
    main()
```

## Quick start: asynchronous API

Save as `example_async.py` and run `python example_async.py`.

```python
import asyncio

from ant0browser.async_api import launch


async def main():
    browser = await launch(identity={"mode": "native"})
    try:
        page = await browser.new_page()
        await page.goto("https://example.com")
        print(await page.title())
    finally:
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
```

`launch()` creates a temporary profile by default and removes it when the browser closes or the process exits. Use `launch_persistent_context()` when you intentionally need a persistent profile.

## API at a glance

| API | Use | Reference |
| --- | --- | --- |
| `ant0browser.launch(**options)` | Launch a synchronous Playwright browser with the selected identity. | [Python SDK](https://docs.ant0.link/sdk#python) |
| `ant0browser.async_api.launch(**options)` | Async equivalent of `launch()`. | [Python SDK](https://docs.ant0.link/sdk#python) |
| `launch_persistent_context(user_data_dir, **options)` | Launch with an explicitly managed persistent profile. | [Python SDK](https://docs.ant0.link/sdk#python) |
| `serve(**options)` | Start the engine and expose a local CDP endpoint with process controls. | [Python SDK](https://docs.ant0.link/sdk#python) |
| `resolve_geo(proxy=None, quiet=False, timeout=8)` | Optional exit-IP geolocation for identity settings. | [Network details](https://docs.ant0.link/sdk#network) |

Omitting `identity` selects native identity. Captured or synthetic identities and explicit overrides are also available; creating a new synthetic identity requires separately authorized local model or template assets. Those assets are not included in the package.

Optional `overrides={"audio_profile": {"sample_rate": ..., "base_latency": ..., "output_latency": ...}}` replaces individual audio fields for one launch (launch-only, never saved into the identity). The default is the real-world distribution of the population model.

Optional `overrides={"network": {"rtt": ..., "downlink": ..., "effective_type": ...}}` sets the persona's base `navigator.connection` link for one launch (launch-only, never saved; engine ant0.7 or later). Newly generated synthetic identities get a speech voice list in the persona's language; saved identities are not rewritten.

## Screen scale and the window

When the SDK knows the persona's device pixel ratio (an explicit `device_pixel_ratio`, `light_stealth`, or a v2 profile's `display.device_pixel_ratio`) it adds `--force-device-scale-factor=<ratio>`, so the page sees the persona's scale on a Linux host too. A Playwright `viewport` alone emulates scale 1, so the SDK adds the matching `device_scale_factor` unless you set your own. A headed window is kept on the real display: its size is clamped to the display divided by the scale. The display is read from `ANT0_DISPLAY_SIZE=WIDTHxHEIGHT` or, on Linux, `xrandr`/`xdpyinfo`; Windows and macOS are not detected, so pass your own window size there (your `--window-size`, `--start-maximized`, `--start-fullscreen` or `--kiosk` always wins). A persona the engine picks by itself, and a native identity, get no flag.

## Playwright calls that do not work on Ant0

These fail or time out (27 of 62 calls tried): `page.set_content` (use `set_content` from this package), `expose_function` and `expose_binding` on a page, context or frame, `page.on('console')`, `page.on('pageerror')`, and a raw CDP session that enables `Runtime` and waits for `consoleAPICalled`. Everything else tried works: navigation, `evaluate`, init scripts, dialogs, waits, locators, frames, `route`, popups, workers, `storage_state`, screenshots, PDF, mouse and plain CDP sessions.

```python
from ant0browser import set_content  # async: from ant0browser.async_api import set_content
set_content(page, "<h1>hi</h1>", wait_until="load")  # load | domcontentloaded | networkidle | commit
```

`canvasBridge` was removed with the engine's canvas bridge. An old value is ignored with a one-time note and never fails a launch.

## Browser switches `launch()` does and does not pass

Playwright adds testing switches to every launch. `launch()` and `launch_persistent_context()` remove the ones a page can observe, so pages see what a normal Chrome window shows: `--hide-scrollbars` (scrollbars are drawn), `--disable-popup-blocking` (`window.open()` without a user gesture is blocked; a popup from a click still opens and `context.on("page")` fires), and the `HttpsUpgrades` and `BoundaryEventDispatchTracksNodeRemoval` feature disables (`http://` upgrades to `https://` when TLS answers and falls back to `http://` when it does not; boundary events after a node under the pointer is removed match Chrome). `HttpsFirstBalancedModeAutoEnable` stays disabled, so a host with no TLS still loads over `http://`. This does not hold when you ignore every Playwright default (`ignore_default_args=True`), when you ignore Playwright's exact `--disable-features=` default, or when the SDK cannot read Playwright's default feature lists (unreadable-defaults fallback); `http://` to a host with no TLS can then fail with `ERR_BLOCKED_BY_CLIENT`. A switch or feature you pass yourself in `args` is kept, and a feature you enable yourself with `--enable-features` (including `HttpsFirstBalancedModeAutoEnable`) is removed from the disabled list.

Known difference from stock Chrome: `launch()` keeps `--disable-back-forward-cache`. With the cache on, Playwright's default `page.go_back()` waits for a load event that never fires on a restored page and times out; `wait_until="commit"` works. `serve()` does not pass it and matches stock.

## Profile storage

localStorage is pinned to the leveldb backend (the SDK always disables `DomStorageSqlite`, `DomStorageSqliteMigration` and `DomStorageSqliteNewDatabases`), so a caller's `--enable-features=DomStorageSqlite` is overridden: disable wins. On `launch()` the Python SDK skips the pin when it cannot read Playwright's default feature lists (old Playwright releases), because its `--disable-features` would then replace Playwright's whole disabled list; `serve()` always pins.

`cache_dir` is accepted on every launch path and ignored; it prints a one-time note. To choose the download cache, use `executable_path(cache_dir=...)`.

## Proxy, network, and privacy

Proxy settings for browser launches are optional and follow Playwright's configuration. SOCKS5 username/password authentication is not supported by the engine; use an HTTP(S) proxy with credentials, an unauthenticated SOCKS5 proxy, or Ant0's local relay. GeoIP exit-IP lookups use an HTTP(S) proxy; SOCKS proxies are not supported for that lookup.

`socks5h://` is accepted and sent as `socks5://`; the engine resolves hostnames at the SOCKS5 proxy in both cases.

| Behavior | Network use |
| --- | --- |
| Launch-ticket handling | When needed, the SDK requests a ticket from the local `ant0d` daemon over loopback. |
| `resolve_geo()` | Only when called. The exit-IP lookup uses the configured proxy; GeoIP data may be fetched directly, and fallback providers may be contacted if the primary lookup is unavailable. |
| Release or optional assets | Only when the corresponding helper is used or an opt-in source is configured. |

See [SDK network details](https://docs.ant0.link/sdk#network) and the [Ant0 Privacy Policy](https://ant0.link/legal/privacy) for more information. `resolve_geo()` is optional; ordinary browser navigation follows the URLs your code opens.

## Runtime and qualification

The package declares Python `>=3.9`. The table below is the qualification of the previous release; this release is being requalified and its results are recorded in the release notes. The declared minimum is not a claim that every minimum-version/platform combination has been tested.

| Platform | Tested runtime |
| --- | --- |
| Linux | Python 3.12 |
| Windows | Python 3.14.8 |

Target engine for this release: `158.0.8127.18-ant0.11`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Engine not found or rejected | Confirm `ANT0_BROWSER_BINARY` points to the executable in an installed Ant0 engine release, not stock Chromium. |
| Launch-ticket rejection (engine exit code 90) | Start Ant0, sign in, and confirm its local daemon can issue a ticket for the installed engine release. The SDK version is not the engine version. |
| Temporary profile or socket path is too long | Set `TMPDIR` (POSIX) or `TEMP`/`TMP` (Windows) to a short, writable local directory before starting Python. |
| SOCKS5 proxy credentials are rejected | Use an HTTP(S) proxy, an unauthenticated SOCKS5 endpoint, or Ant0's local relay. |

### Launch ticket in the environment

The SDK hands the engine its launch ticket twice, with the same value: as `--ant0-launch=<ticket>` in the engine's arguments, and as `ANT0_LAUNCH` in the environment of the engine process only. Engines that predate the environment variable read only the argument; newer ones read the environment first, so the ticket is not needed on the command line. The argument is dropped in a later release. This applies to `launch()`, `launch_persistent_context()` (sync and async) and `serve()`. The SDK never sets `ANT0_LAUNCH` in its own process (`os.environ`); it is added to a copy of the environment that goes to the engine.

If you pass your own ticket, nothing is overwritten and nothing is refused. A ticket in your `env` argument (`ANT0_LAUNCH`) or in your `args` (`--ant0-launch=`) counts as yours: the SDK then neither fetches nor adds another, and copies yours into the place that has none, so both match. If you set both and they differ, both are left as you set them (a newer engine uses the environment one and logs a line). Only those two count. An `ANT0_LAUNCH` that is merely set in your shell or in the SDK's own environment does nothing: it is never read as your ticket, never reaches the engine, and an engine launch that has no ticket of its own carries none. `--ant0-launch <ticket>` (with a space) is not parsed or mirrored: it is an ordinary argument left to the engine, which only reads the `=` form. On Windows the variable name is matched case-insensitively. **Stale tickets:** when the engine exits 90 with `claim_expired` or `claim_stale` and the SDK itself fetched the ticket from the daemon, `launch()`, `launch_persistent_context()` (sync and async) and `serve()` retry the launch once with a ticket fetched right before the respawn. A ticket you provided (the launch-ticket option, `--ant0-launch=` in your args, or `ANT0_LAUNCH` in your explicit env) and every other reason are never retried, and a second failure is raised as usual. Python Playwright sends the environment to its driver process over a pipe, as it does the arguments, so the ticket crosses that pipe in both forms.

The ticket in the environment is a secret like the one in the arguments: it is removed from launch errors, and an `env` property on a wrapped error is dropped. Do not log the engine's environment. An engine that rejects a stale claim reports `claim_stale` (exit code 90), which the SDK treats like `claim_expired`.

### Launch errors and secrets

Errors the SDK raises or re-raises for a failed launch have the launch ticket, the persona file path and the profile directory removed from their message, stack and string properties (the values the SDK itself passed are replaced exactly; the `--ant0-launch` and `--fingerprint-profile-file` switches are also matched by pattern), and carry no `__cause__`. This covers error messages and tracebacks only. A tool that captures local variables when an error happens (Sentry with local variables enabled, `pytest --showlocals`, a debugger, a crash reporter) can still see the raw launch arguments in the SDK's frames. Keep such capture off for code that calls `launch()` or `serve()`, or scrub the `--ant0-launch`, `--fingerprint-profile-file` and `--user-data-dir` values in its hooks. A `--ant0-launch` value shorter than 16 characters is replaced only where it follows its switch or stands as a whole token, not anywhere in a text, so a short word cannot mangle the text around it. Only a malformed value that a user typed is that short; a minted ticket carries a 64-byte signature and is about 86 characters, so it is always replaced everywhere.

### Engine damaged

**Symptom.** `launch()` raises `browser.proof_mismatch` (next action `reinstall_engine`).

**Cause.** The engine's signed proof is present and valid, but an installed file was changed, truncated or removed. `ant0 browsers ls` shows the release as failed and names the file.

**Fix.** Reinstall that release: `ant0 browsers rm <version>`, then `ant0 browsers install --release <version>`.

### Unexpected file in the engine folder

**Symptom.** `launch()` raises `browser.unexpected_file` (next action `reinstall_engine`). The native runtime's own text names the file ("the engine folder has an unexpected file (`<name>`); repair or reinstall the engine"), but the SDK error carries the code and next action only, never the runtime's message.

**Cause.** The engine is installed, but its folder holds an entry that is not on the engine's signed file list (for example a log file written by something that ran inside it). The check is exact on purpose: no file name is accepted.

**Fix.** Reinstall that release (this also removes the extra entry): `ant0 browsers rm <version>`, then `ant0 browsers install --release <version>`. Not `browser.proof_mismatch`: that means a listed file was changed or removed.

### Engine not found

**Symptom.** `launch()` raises `browser.not_installed`, even though `ant0 browsers ls` shows the engine as installed.

**Cause.** The installed engine has no valid install proof (a signed record of its files, kept in `<home>/browsers/<version>/.provenance/`). Without it, the SDK will not use the engine automatically. The error code does not say which part failed; this is by design.

**Fix 1: write the proof for the installed engine.** Update the Ant0 desktop app to 0.3.22 or later, then run:

```bash
ant0 browsers install --release <version> --repair-proof
```

This never reinstalls the engine. It writes the proof only if every installed file matches the signed list.

**Fix 2: reinstall the engine** with the desktop app 0.3.22 or later. New installs write the proof automatically.

**Engines with no published proof** (for example the current stable `ant0.5`) cannot be found automatically. Pass the path to the browser yourself, using `executable_path` or the `ANT0_BROWSER_BINARY` environment variable:

```python
browser = launch(executable_path="/path/to/ant0/chrome")
```

## What `serve()` shares with `launch()`

`serve()` takes the same identity and engine options as `launch()` and applies and validates them with the same helpers: `identity`, `overrides`, `args`, `extensions`, `shader_dialect` (an invalid value raises the same error as `launch()`), `widevine` (seeded into the served profile), `resolve_fonts`, `env`, `quiet`, the launch-ticket and runtime options, and a `proxy` dict's `server` and `bypass`. `chromium_sandbox=False` adds `--no-sandbox`.

What differs:

- `serve()` spawns the engine directly, without Playwright's default switches (for example `--disable-field-trial-config`, `--disable-back-forward-cache`, `--force-color-profile=srgb` and Playwright's feature lists), so some browser defaults differ from `launch()`.
- The sandbox stays on by default in `serve()`; `launch()` (Playwright) turns it off unless `chromium_sandbox=True`.
- Loopback and proxies: `launch()` forces `<-loopback>` into the proxy bypass list, so `http://localhost` goes through the proxy. `serve()` does not, which matches stock Chrome: localhost is direct.
- Playwright-only options (`humanize`, `show_cursor`, `timeout`, `downloads_path`, browser-context options such as `viewport` or `locale`) do not apply to a direct spawn and are ignored; the attached client sets them. Proxy `username`/`password` cannot be applied either.

## Shutdown and cleanup

Ctrl+C / SIGTERM cleanup is the application's job: call `close()` (or use `with serve(...) as srv:`). The SDK installs no signal handlers, so it never changes how your process terminates.

What the exit hook guarantees: on a normal interpreter exit without `close()`, one `atexit` hook stops every running `serve()` browser and removes the temp profile directory `serve()` created. A browser that uses a throwaway temp profile is killed (a graceful Chromium shutdown writes files back into the directory being removed); a browser using a `user_data_dir` you passed in gets SIGTERM so it can shut down gracefully, and that directory is never deleted. The hook is synchronous and bounded: it spends about 1 s per directory and about 3 s in total (waiting for children and retrying removal), then gives up and accepts the leak. A process killed by a signal you did not handle does not run `atexit` hooks, so nothing is cleaned up in that case.

On Windows there is no graceful SIGTERM: stopping a process is a hard terminate.

`close()` sends SIGTERM, waits for the browser to exit (kill only if it has not exited after 10 s), then removes the temp profile directory.

## GeoIP attribution

Optional GeoIP uses the IP2Location LITE database ([ip2location.com](https://lite.ip2location.com)), includes GeoLite2 data created by MaxMind ([maxmind.com](https://www.maxmind.com/)), and includes IP geolocation by DB-IP ([db-ip.com](https://db-ip.com)). The merged `geoip-all-in-one` database is GPL-3.0; its data covers country, coordinates, and timezone.

## More information

- [Python SDK guide and API reference](https://docs.ant0.link/sdk#python)
- [Identity options](https://docs.ant0.link/sdk#identity)
- [Network behavior](https://docs.ant0.link/sdk#network)
- [Support](https://ant0.link/contact)
- [Privacy Policy](https://ant0.link/legal/privacy)
