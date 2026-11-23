// Portions of this file are copied from Playwright (https://github.com/microsoft/playwright),
// Copyright (c) Microsoft Corporation, licensed under the Apache License, Version 2.0.
// The licence text and Playwright's NOTICE are in LICENSE-playwright next to this file.
// This excerpt is a test input only. It is not part of the published packages.
// Excerpt of Playwright 1.65.1 lib/coreBundle.js, minimal lines only. First the WebMCP error message that quotes
// --enable-features=WebMCP (not a switch), then the head of the chromiumSwitches section. Used to test the
// feature-default parse in both SDKs; the elided lines are marked with '// ...'.
    const features = (originalLaunchOptions.args ?? []).filter((arg2) => arg2.startsWith("--enable-features=")).flatMap((arg2) => arg2.substring("--enable-features=".length).split(","));
    if (!features.includes("WebMCP"))
      throw new Error('WebMCP is not enabled. Launch the browser with the "--enable-features=WebMCP" argument.');
// ...
var disabledFeatures, enabledFeatures, chromiumSwitches;
var init_chromiumSwitches = __esm({
  "packages/playwright-core/src/server/chromium/chromiumSwitches.ts"() {
    "use strict";
    disabledFeatures = [
      // See https://github.com/microsoft/playwright/issues/14047
      "AvoidUnnecessaryBeforeUnloadCheckSync",
      "DestroyProfileOnBrowserClose",
      // Keep HTTP navigations and routes on HTTP, including with HTTPS-First balanced mode.
      // See https://github.com/microsoft/playwright/issues/43871
      "HttpsUpgrades",
      "HttpsFirstBalancedModeAutoEnable",
      // Hides the Lens feature in the URL address bar. Its not working in unofficial builds.
      "LensOverlay",
      // See https://github.com/microsoft/playwright/pull/8162
      "MediaRouter",
      // See https://github.com/microsoft/playwright/issues/28023
      "PaintHolding",
      // See https://github.com/microsoft/playwright/issues/32230
      "ThirdPartyStoragePartitioning",
      // Chromium 155 aborts preflighted cross-origin redirects with net::ERR_ABORTED while
      // Fetch interception is enabled. See https://github.com/microsoft/playwright/issues/43242
      "AvoidCorsURLLoaderRestartOnRedirect",
      // Avoids intermittent ERR_NO_BUFFER_SPACE failures on Windows (https://crbug.com/572515601).
      "TcpPortRandomizationWin",
      // Prevents downloading optimization hints on startup.
      "OptimizationHints",
      // Prevents network time queries to clients2.google.com on startup.
      "NetworkTimeServiceQuerying",
      // Prevents AI Mode eligibility requests to www.google.com on startup.
      "AimEnabled",
      // Prevents preconnects to the default search engine (www.google.com) on startup.
      // See https://github.com/microsoft/playwright/issues/42910
      "PreconnectToSearch",
      // Disables forced sign-in in Edge.
      "msForceBrowserSignIn",
      // Disables updating the preferred version in LaunchServices preferences on mac.
      "msEdgeUpdateLaunchServicesPreferredVersion"
    ].filter(Boolean);
    enabledFeatures = () => [
      process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? "" : "CDPScreenshotNewSurface",
      // Prevents /ListAccounts requests to accounts.google.com on startup.
      // See https://github.com/microsoft/playwright/issues/42910 and https://issues.chromium.org/565837024
      "SkipListAccountsWithoutGaiaCookies"
    ].filter(Boolean);
    chromiumSwitches = (options) => [
      // ...
      "--disable-features=" + disabledFeatures.join(","),
      "--enable-features=" + enabledFeatures().join(","),
      // ...
