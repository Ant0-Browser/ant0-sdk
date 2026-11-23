# Changelog

Ant0 Browser SDK releases (npm `ant0-browser`, PyPI `ant0-browser`). Node and Python ship the same version.

## Unreleased

- Speech voices follow the browser brand, in both SDKs. The 19 Google network voices are listed only under the Chrome brand; under Edge or no brand they are dropped (a Linux persona then lists no voices). Under Chrome a list that already holds some network voices becomes the local voices plus exactly the 19, and a list with none is left for the engine (ant0.14) to extend, so nothing is doubled. Android and macOS are untouched.

## 0.2.2 (2026-11-23)

- The SDK no longer downloads or uses a Windows font pack. `resolveFontPack` and `resolve_font_pack` are deprecated and return nothing. Windows profiles on Linux use the bundled look-alike fonts.

## 0.2.1 (2026-11-22)

### Behaviour change

**A platform override that contradicts the persona's OS now raises `sdk.identity_platform_mismatch`; before 0.2.1 it was accepted silently.** The error is raised before any browser starts, so a run can no longer present a mixed identity.

- Personas in the older format are Windows-only, so `platform: "linux"` on one is now an error. Drop the override, or use a persona of the OS you want.
- A matching platform, no override, or a persona that names no OS still passes.

### Fixes

- `launch()` keeps MediaRouter enabled. Playwright's default `--disable-features` list turned it off, which made every `launch()` page look automated. `serve()` and the launch plan never passed it. A `--disable-features` you pass yourself is still honoured.
- `serve()` fails with `PersonaFileRejectedError` when the engine reports that the profile remains inactive (an invalid persona). Previously it returned a running browser on host values with no persona. The engine is stopped before the error is raised.
- Playwright's `--enable-unsafe-swiftshader` default is dropped on Windows hosts, where it forced WebGL onto SwiftShader instead of the D3D11 path a real Windows Chrome uses. Linux hosts are unchanged on purpose, because headless Linux servers often need SwiftShader for WebGL.
- The local persona generator now follows the same Windows coherence rules as the cloud. It only draws graphics rows whose WebGL renderer carries ANGLE's 8-digit device id (ids are never made up), and it normalises display rows to a bottom taskbar of 48 px. The generator version is now 1.1.0, so locally generated personas differ from those of 0.2.0.

## 0.2.0 (2026-11-20)

- Native runtime consumer: with no explicit binary or `ANT0_BROWSER_BINARY`, the SDK finds the default engine installed by the Ant0 app.
