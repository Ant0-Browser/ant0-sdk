import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRST_RUN_HYGIENE_ARGS,
  defaultStartUrlArgs,
  extensionArgs,
  hasUrlPositional,
  resolveProxy,
  SOCKS_CREDENTIALS_UNSUPPORTED,
  mergeFeatureFlags,
  webBluetoothArgs,
  personaPlatformOf,
  engineSupportsWebrtcIp,
  gateWebrtcIpArgs,
  gateWebrtcArgs,
  isValidWebrtcIp,
  IGNORED_PLAYWRIGHT_DEFAULTS,
  installedPlaywrightDisabledFeatures,
  installedPlaywrightFeatureDefaults,
  parsePlaywrightFeatureDefaults,
  withPlaywrightFeatureDefaults,
  mergeIgnoreDefaultArgs,
  effectiveWebrtcPolicy,
  callerAllowsUdp,
  hasRawProxyServer,
  parsePlaywrightDisabledFeatures,
  playwrightFeatureArgs,
  privacySandboxArgs,
  domStorageBackendArgs,
  quicArgs,
  socks5UdpArgs,
  webrtcDefaultDenyArgs,
} from "../src/launchopts.js";

describe("mergeFeatureFlags", () => {
  it("collapses multiple --enable/--disable-features into one each", () => {
    const out = mergeFeatureFlags([
      "--enable-features=A", "--mute-audio", "--enable-features=B,C",
      "--disable-features=D", "--disable-features=D,E",
    ]);
    expect(out.filter((a) => a.startsWith("--enable-features="))).toEqual(["--enable-features=A,B,C"]);
    expect(out.filter((a) => a.startsWith("--disable-features="))).toEqual(["--disable-features=D,E"]);
    expect(out).toContain("--mute-audio");
  });
});

describe("privacySandboxArgs", () => {
  it("disables the Privacy Sandbox + intrusive APIs", () => {
    expect(privacySandboxArgs()).toEqual([
      "--disable-features=BrowsingTopics,BrowsingTopicsDocumentAPI,Fledge,InterestGroupStorage,PrivateAggregationApi,SharedStorageAPI,FencedFrames",
    ]);
  });
});

describe("domStorageBackendArgs", () => {
  it("disables the SQLite DOM storage backend and its migration", () => {
    expect(domStorageBackendArgs()).toEqual([
      "--disable-features=DomStorageSqlite,DomStorageSqliteMigration,DomStorageSqliteNewDatabases",
    ]);
  });
});

describe("webrtcDefaultDenyArgs", () => {
  it("defaults to disable_non_proxied_udp when no webrtcIp", () => {
    expect(webrtcDefaultDenyArgs([], undefined)).toEqual(["--webrtc-ip-handling-policy=disable_non_proxied_udp"]);
  });
  // Regression: this used to return [] when a webrtcIp was set, on the theory that the engine's
  // srflx fabrication covered WebRTC. It does not. A page using iceTransportPolicy:"relay" forces
  // TURN; TURN prefers UDP; an HTTP/SOCKS proxy carries only TCP — so the UDP left on the host's
  // own path and the TURN server read the real public IP off the packet, with no candidate
  // involved for the fabrication to rewrite. geoip:true sets webrtcIp for you, so the coherent
  // configurations were the exposed ones.
  it("still denies non-proxied UDP when a webrtcIp is set", () => {
    expect(webrtcDefaultDenyArgs([], "1.2.3.4")).toEqual(["--webrtc-ip-handling-policy=disable_non_proxied_udp"]);
  });
  it("is skipped when the caller already set a policy", () => {
    expect(webrtcDefaultDenyArgs(["--webrtc-ip-handling-policy=default"], undefined)).toEqual([]);
  });
  it("is skipped when the caller set a forced policy, even with a webrtcIp", () => {
    expect(webrtcDefaultDenyArgs(["--force-webrtc-ip-handling-policy=default"], "1.2.3.4")).toEqual([]);
  });
});

describe("quicArgs", () => {
  it("disables QUIC behind any proxy (SOCKS or HTTP)", () => {
    expect(quicArgs({ server: "socks5://host:1080" })).toEqual(["--disable-quic"]);
    expect(quicArgs({ server: "http://host:8080" })).toEqual(["--disable-quic"]);
  });
  it("leaves QUIC on when no proxy is set", () => {
    expect(quicArgs(undefined)).toEqual([]);
    expect(quicArgs({})).toEqual([]);
  });
});

describe("extensionArgs", () => {
  it("returns [] for empty input", () => {
    expect(extensionArgs()).toEqual([]);
    expect(extensionArgs([])).toEqual([]);
  });

  it("emits both --load-extension and --disable-extensions-except", () => {
    expect(extensionArgs(["/a", "/b"])).toEqual([
      "--load-extension=/a,/b",
      "--disable-extensions-except=/a,/b",
    ]);
  });
});

describe("resolveProxy", () => {
  it("passes through when no proxy", () => {
    expect(resolveProxy(undefined)).toEqual({ args: [], proxy: undefined });
  });

  // WHY: the engine has no SOCKS5 username/password auth, and stock Chromium
  // has none, so a credentialed SOCKS proxy cannot work from any layer of the stack. The SDK used
  // to emit a nonexistent --socks5-credentials switch here; the proxy then refused every
  // connection. Refusing to launch, with the fix spelled out, is the only honest behaviour.
  it("throws for a credentialed SOCKS5 proxy, naming the cause and the relay workaround", () => {
    const call = () => resolveProxy({ server: "socks5://h:1080", username: "u", password: "p" });
    expect(call).toThrow(/RFC 1929/);
    expect(call).toThrow(/relay/);
    expect(call).toThrow(/http\(s\)/);
  });

  it("throws for a SOCKS URL with embedded userinfo AND username/password fields", () => {
    expect(() => resolveProxy({ server: "socks5://old:secret@h:1080", username: "u", password: "p" }))
      .toThrow(/RFC 1929/);
  });

  it("throws when only one of username/password is set (socks4 and socks5h included)", () => {
    expect(() => resolveProxy({ server: "socks5h://h:1080", username: "u" })).toThrow(/RFC 1929/);
    expect(() => resolveProxy({ server: "SOCKS4://h:1080", password: "p" })).toThrow(/RFC 1929/);
  });

  it("never emits a --socks5-credentials switch (the engine has no such switch)", () => {
    for (const p of [
      { server: "socks5://h:1080" },
      { server: "http://u:p@h:8080" },
      { server: "http://h:8080", username: "u", password: "p" },
    ]) {
      const r = resolveProxy(p);
      expect(r.args.some((a) => a.startsWith("--socks5-credentials"))).toBe(false);
    }
    expect(SOCKS_CREDENTIALS_UNSUPPORTED).not.toContain("--socks5-credentials");
  });

  it("leaves a SOCKS5 proxy without creds to Playwright", () => {
    const p = { server: "socks5://h:1080" };
    expect(resolveProxy(p)).toEqual({ args: [], proxy: p });
  });

  it("leaves an authed HTTP proxy to Playwright", () => {
    const p = { server: "http://h:8080", username: "u", password: "p" };
    expect(resolveProxy(p)).toEqual({ args: [], proxy: p });
  });
});


// --------------------------------------------------------------------------- web bluetooth
// Web Bluetooth is compiled in but runtime-disabled on Linux only, so a Linux host serving a
// Windows persona exposed navigator.usb/serial/hid but not navigator.bluetooth -- a combination
// no real Windows Chrome produces. The flag restores it; off Linux it must stay a no-op.
describe("webBluetoothArgs", () => {
  it.each(["windows", "macos", "Windows"])("emits the flag for a %s persona on a linux host", (persona) => {
    expect(webBluetoothArgs(persona, "linux")).toEqual(["--enable-features=WebBluetooth"]);
  });

  // Real Linux Chrome has no navigator.bluetooth: the flag on a Linux persona (or on no persona,
  // which presents the real host) would itself be the tell.
  it.each([null, "", "linux", "Linux"])("is absent for persona %j on a linux host", (persona) => {
    expect(webBluetoothArgs(persona as string | undefined, "linux")).toEqual([]);
  });

  it("keeps the old public behaviour when called with no argument", () => {
    expect(webBluetoothArgs(undefined, "linux")).toEqual(["--enable-features=WebBluetooth"]);
  });

  it("is a no-op off a linux host", () => {
    for (const host of ["win32", "darwin"]) expect(webBluetoothArgs("windows", host)).toEqual([]);
  });

  it("defaults the host to process.platform", () => {
    const real = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(webBluetoothArgs("windows")).toEqual(["--enable-features=WebBluetooth"]);
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(webBluetoothArgs("windows")).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }
  });

  it("derives the persona platform from the option, else the profile's os_family", () => {
    expect(personaPlatformOf("Windows", { compatibility: { os_family: "linux" } })).toBe("windows");
    expect(personaPlatformOf(undefined, { compatibility: { os_family: "macos" } })).toBe("macos");
    expect(personaPlatformOf(undefined, undefined)).toBeUndefined();
    expect(personaPlatformOf("", {})).toBeUndefined();
  });

  it("folds into a single --enable-features", () => {
    const merged = mergeFeatureFlags([
      ...webBluetoothArgs("windows", "linux"),
      "--enable-features=SomethingElse",
    ]);
    const enables = merged.filter((a) => a.startsWith("--enable-features="));
    expect(enables).toHaveLength(1);
    expect(enables[0]).toContain("WebBluetooth");
    expect(enables[0]).toContain("SomethingElse");
  });
});

// Engines through 158.0.8127.18-ant0.2 turn non-proxied UDP back on when --webrtc-ip is set, so a
// page's own TURN server reads the host's real public address (133 packets measured, 0 without).
describe("engineSupportsWebrtcIp / gateWebrtcIpArgs", () => {
  const IP = "--webrtc-ip=203.0.113.7";
  const DENY = "--webrtc-ip-handling-policy=disable_non_proxied_udp";
  let writes: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  beforeEach(() => {
    writes = [];
    (process.stderr as { write: unknown }).write = (c: string) => { writes.push(String(c)); return true; };
  });
  afterEach(() => { (process.stderr as { write: unknown }).write = realWrite; delete process.env.ANT0_BROWSER_NO_WARN; });

  it.each([
    ["158.0.8127.18-ant0.3", true],
    ["158.0.8127.18-ant0.10", true], // numeric, not lexicographic
    ["158.0.8127.18-ant0.2", false],
    ["158.0.8127.18-ant0.1", false],
    ["154.0.8037.57-ant0.2", false],
    ["154.0.8037.57-ant0.9", false],
    ["158.0.8127.19-ant0.1", true],
    ["159.0.1.1-ant0.1", true],
    ["158.0.8127.9-ant0.9", false], // 9 < 18 numerically
    [undefined, false], [null, false], ["", false], ["158.0.8127.18", false], ["garbage", false],
    ["158.0.8127.18-ant0.3-rc1", false], [3, false],
  ])("version %j -> %s", (v, ok) => {
    expect(engineSupportsWebrtcIp(v)).toBe(ok);
  });

  it("omits the flag for an old engine and never prints the address", () => {
    expect(gateWebrtcIpArgs(["--a", IP, DENY], "158.0.8127.18-ant0.2")).toEqual(["--a", DENY]);
    const err = writes.join("");
    expect(err).toContain("webrtc-ip");
    expect(err).not.toContain("203.0.113.7");
  });

  it("emits the flag for ant0.3 and later", () => {
    const args = ["--a", IP, DENY];
    expect(gateWebrtcIpArgs(args, "158.0.8127.18-ant0.3")).toEqual(args);
    expect(gateWebrtcIpArgs(args, "158.0.8127.18-ant0.4")).toEqual(args);
  });

  it("omits the flag for an unknown or unparseable version", () => {
    expect(gateWebrtcIpArgs([IP, DENY], undefined)).toEqual([DENY]);
    expect(gateWebrtcIpArgs([IP, DENY], "nonsense")).toEqual([DENY]);
  });

  it("drops a raw caller --webrtc-ip on an old engine", () => {
    expect(gateWebrtcIpArgs(["--webrtc-ip=1.2.3.4", DENY], "154.0.8037.57-ant0.2")).toEqual([DENY]);
  });

  it("is silent when quiet, when NO_WARN is set, and when nothing was dropped", () => {
    gateWebrtcIpArgs([IP], undefined, true);
    process.env.ANT0_BROWSER_NO_WARN = "1";
    gateWebrtcIpArgs([IP], undefined);
    delete process.env.ANT0_BROWSER_NO_WARN;
    gateWebrtcIpArgs([DENY], undefined);
    expect(writes).toEqual([]);
  });

  it.each([
    "--webrtc-ip-handling-policy=default",
    "--force-webrtc-ip-handling-policy=default_public_interface_only",
    "--webrtc-ip-handling-policy=default_public_and_private_interfaces",
  ])("keeps the flag when the caller's own policy allows UDP (%s)", (policy) => {
    const args = [IP, policy];
    expect(gateWebrtcIpArgs(args, "158.0.8127.18-ant0.2")).toEqual(args);
  });

  it("still drops it when the caller's policy is the safe one", () => {
    expect(gateWebrtcIpArgs([IP, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"], "158.0.8127.18-ant0.2"))
      .not.toContain(IP);
  });

  it.each([
    ["203.0.113.7", true], ["2001:db8::1", true], ["::1", true],
    ["", false], ["not-an-ip", false], ["203.0.113.7:80", false], ["[2001:db8::1]", false], ["fe80::1%eth0", false],
    ["999.1.1.1", false], ["1.2.3", false], [" 1.2.3.4", false], ["1.2.3.4/24", false], [undefined, false],
  ])("isValidWebrtcIp(%j) -> %s", (v, ok) => expect(isValidWebrtcIp(v)).toBe(ok));

  it("drops an invalid value on every engine with a warning that does not repeat it", () => {
    for (const engine of ["158.0.8127.18-ant0.3", "158.0.8127.18-ant0.2", undefined]) {
      writes = [];
      expect(gateWebrtcIpArgs(["--webrtc-ip=secret-host.example", DENY], engine)).toEqual([DENY]);
      expect(writes.join("")).toContain("not an IP address");
      expect(writes.join("")).not.toContain("secret-host");
    }
  });

  it("drops an invalid value even when the caller's policy allows UDP", () => {
    expect(gateWebrtcIpArgs(["--webrtc-ip=nope", "--webrtc-ip-handling-policy=default"], "158.0.8127.18-ant0.2"))
      .toEqual(["--webrtc-ip-handling-policy=default"]);
  });

  describe("--webrtc-no-local-dns", () => {
    const SW = "--webrtc-no-local-dns";
    const NEW = "158.0.8127.18-ant0.3";
    it("is added on ant0.3 and later when there is a proxy", () => {
      expect(gateWebrtcArgs([DENY], NEW, true, true)).toEqual([DENY, SW]);
      expect(gateWebrtcArgs([DENY], "158.0.8127.18-ant0.11", true, true)).toContain(SW);
    });
    it("is absent without a proxy, on an old or unknown engine", () => {
      expect(gateWebrtcArgs([DENY], NEW, true, false)).not.toContain(SW);
      expect(gateWebrtcArgs([DENY], "158.0.8127.18-ant0.2", true, true)).not.toContain(SW);
      expect(gateWebrtcArgs([DENY], undefined, true, true)).not.toContain(SW);
    });
    it("is absent in UDP relay mode (the engine ignores it there)", () => {
      expect(gateWebrtcArgs([DENY, "--webrtc-udp-relay=127.0.0.1:5555"], NEW, true, true)).not.toContain(SW);
      expect(gateWebrtcArgs([DENY, "--webrtc-udp-relay=127.0.0.1:5555"], NEW, true, true))
        .toContain("--webrtc-udp-relay=127.0.0.1:5555");
    });
    it("is absent when the caller's own policy allows UDP, and is not repeated", () => {
      expect(gateWebrtcArgs(["--webrtc-ip-handling-policy=default"], NEW, true, true)).not.toContain(SW);
      expect(gateWebrtcArgs([DENY, SW], NEW, true, true).filter((a) => a === SW)).toHaveLength(1);
    });
    it("also gates --webrtc-ip in the same call", () => {
      expect(gateWebrtcArgs([IP, DENY], "158.0.8127.18-ant0.2", true, true)).toEqual([DENY]);
      expect(gateWebrtcArgs([IP, DENY], NEW, true, true)).toEqual([IP, DENY, SW]);
    });
  });

  describe("playwrightFeatureArgs (ThirdPartyStoragePartitioning)", () => {
    const SRC = `disabledFeatures = [\n // See x\n "AvoidX",\n "ThirdPartyStoragePartitioning",\n // y\n "Translate"\n ].filter(Boolean);`;
    it("parses Playwright's list out of its source, minus ThirdPartyStoragePartitioning", () => {
      expect(parsePlaywrightDisabledFeatures(SRC)).toEqual(["AvoidX", "Translate"]);
    });
    it("refuses a layout it does not understand instead of guessing", () => {
      expect(parsePlaywrightDisabledFeatures("disabledFeatures = [ cond ? \"A\" : \"B\", \"ThirdPartyStoragePartitioning\" ]")).toBeUndefined();
      expect(parsePlaywrightDisabledFeatures("disabledFeatures = [ \"A\" ]")).toBeUndefined(); // nothing to remove
      expect(parsePlaywrightDisabledFeatures("nothing here")).toBeUndefined();
    });
    it("derives the list from the Playwright actually installed", () => {
      const live = installedPlaywrightDisabledFeatures();
      expect(live).toBeDefined();
      expect(live).toContain("Translate");
      expect(live).not.toContain("ThirdPartyStoragePartitioning");
    });
    it("emits the derived list, and nothing when it cannot be derived", () => {
      expect(playwrightFeatureArgs([], ["--enable-automation"], ["AvoidX", "Translate"])).toEqual(["--disable-features=AvoidX,Translate,HttpsFirstBalancedModeAutoEnable"]);
      expect(playwrightFeatureArgs([], undefined, null)).toEqual([]);
      const [arg] = playwrightFeatureArgs([], ["--enable-automation"]);
      expect(arg).toMatch(/^--disable-features=/);
      expect(arg).not.toContain("ThirdPartyStoragePartitioning");
    });
    it("stays out of the way when every Playwright default is ignored", () => {
      expect(playwrightFeatureArgs([], true, ["A", "B"])).toEqual([]);
    });
    it("only an exact copy of Playwright's default argument counts as ignoring it; a bare entry does not", () => {
      const d = { disabledFull: ["A", "ThirdPartyStoragePartitioning", "B"], disabled: ["A", "B"], enabled: ["Cdp"] };
      expect(playwrightFeatureArgs([], ["--disable-features=A,ThirdPartyStoragePartitioning,B"], d)).toEqual([]);
      expect(playwrightFeatureArgs([], ["--disable-features"], d)).toEqual(["--disable-features=A,B,HttpsFirstBalancedModeAutoEnable", "--enable-features=Cdp"]);
      expect(playwrightFeatureArgs([], ["--disable-features=X"], d)).toEqual(["--disable-features=A,B,HttpsFirstBalancedModeAutoEnable", "--enable-features=Cdp"]);
    });
    it("merges with the SDK's and the caller's lists instead of replacing them", () => {
      const d = { disabledFull: ["A", "ThirdPartyStoragePartitioning"], disabled: ["A"], enabled: ["Cdp"] };
      const merged = withPlaywrightFeatureDefaults(["--disable-features=BrowsingTopics", "--enable-features=WebBluetooth", "--x"], undefined, true);
      const dis = merged.filter((a) => a.startsWith("--disable-features="));
      const en = merged.filter((a) => a.startsWith("--enable-features="));
      expect(dis).toHaveLength(1);
      expect(dis[0]).toContain("BrowsingTopics");
      expect(dis[0]).not.toContain("ThirdPartyStoragePartitioning");
      expect(en).toHaveLength(1);
      expect(en[0]).toContain("WebBluetooth");
      expect(en[0]).toContain("CDPScreenshotNewSurface");
      expect(d.enabled).toEqual(["Cdp"]);
    });
    it("a caller's ignoreDefaultArgs adds to the SDK defaults", () => {
      const sdk = [...IGNORED_PLAYWRIGHT_DEFAULTS, "--hide-scrollbars", "--disable-popup-blocking"];
      expect(mergeIgnoreDefaultArgs(["--mute-audio"])).toEqual([...sdk, "--mute-audio"]);
      expect(mergeIgnoreDefaultArgs(undefined)).toEqual(sdk);
      expect(mergeIgnoreDefaultArgs(true)).toBe(true);
    });

    it("drops Playwright's --enable-unsafe-swiftshader on a win32 host only", () => {
      const base = mergeIgnoreDefaultArgs(undefined, undefined, "linux") as string[];
      expect(base).not.toContain("--enable-unsafe-swiftshader");
      expect(mergeIgnoreDefaultArgs(undefined, undefined, "darwin")).toEqual(base);
      const win = mergeIgnoreDefaultArgs(["--mute-audio"], undefined, "win32") as string[];
      expect(win.filter((a) => a === "--enable-unsafe-swiftshader")).toHaveLength(1);
      expect(win).toContain("--mute-audio");
      expect(mergeIgnoreDefaultArgs(["--enable-unsafe-swiftshader"], undefined, "win32")).toEqual(
        (mergeIgnoreDefaultArgs(undefined, undefined, "win32") as string[]).concat([]));
      expect(mergeIgnoreDefaultArgs(true, undefined, "win32")).toBe(true);
    });
    it("defaults the swiftshader host to process.platform", () => {
      const real = process.platform;
      try {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        expect(mergeIgnoreDefaultArgs(undefined)).toContain("--enable-unsafe-swiftshader");
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        expect(mergeIgnoreDefaultArgs(undefined)).not.toContain("--enable-unsafe-swiftshader");
      } finally {
        Object.defineProperty(process, "platform", { value: real, configurable: true });
      }
    });

    // launch() stops passing four Playwright testing switches that a page can observe.
    const DROPPED = ["HttpsUpgrades", "BoundaryEventDispatchTracksNodeRemoval", "MediaRouter"];
    const HFM = "HttpsFirstBalancedModeAutoEnable";
    const defaults = (...disabled: string[]) =>
      ({ disabledFull: [...disabled, "ThirdPartyStoragePartitioning"], disabled, enabled: ["Cdp"] });
    const names = (args: string[]) => (args.find((a) => a.startsWith("--disable-features=")) ?? "").slice("--disable-features=".length).split(",");

    it("ignores --hide-scrollbars and --disable-popup-blocking exactly once", () => {
      for (const caller of [undefined, [], ["--mute-audio"], ["--hide-scrollbars", "--disable-popup-blocking", "--mute-audio"]]) {
        const got = mergeIgnoreDefaultArgs(caller) as string[];
        expect(got.filter((a) => a === "--hide-scrollbars")).toHaveLength(1);
        expect(got.filter((a) => a === "--disable-popup-blocking")).toHaveLength(1);
        expect(new Set(got).size).toBe(got.length);
      }
      expect(mergeIgnoreDefaultArgs(true)).toBe(true);
    });
    it("does not ignore a plain switch the caller passes in args (Playwright would filter their copy too)", () => {
      expect(mergeIgnoreDefaultArgs(undefined, ["--hide-scrollbars"])).toEqual([...IGNORED_PLAYWRIGHT_DEFAULTS, "--disable-popup-blocking"]);
      expect(mergeIgnoreDefaultArgs(["--mute-audio"], ["-disable-popup-blocking", "--x"]))
        .toEqual([...IGNORED_PLAYWRIGHT_DEFAULTS, "--hide-scrollbars", "--mute-audio"]);
      expect(mergeIgnoreDefaultArgs(undefined, ["--hide-scrollbars", "--disable-popup-blocking"])).toEqual([...IGNORED_PLAYWRIGHT_DEFAULTS]);
      expect(mergeIgnoreDefaultArgs(true, ["--hide-scrollbars"])).toBe(true);
    });
    it("no longer disables HttpsUpgrades or BoundaryEventDispatchTracksNodeRemoval, and disables HFM once", () => {
      const out = playwrightFeatureArgs([], undefined, defaults("A", ...DROPPED, "B"));
      expect(names(out)).toEqual(["A", "B", HFM]);
    });
    it("keeps HFM once whether Playwright lists it or not", () => {
      for (const d of [defaults("A", "HttpsUpgrades"), defaults("A", HFM, "HttpsUpgrades")]) {
        const merged = mergeFeatureFlags([...playwrightFeatureArgs(["--x"], undefined, d), "--x"]);
        expect(merged.filter((a) => a.startsWith("--disable-features="))).toHaveLength(1);
        expect(names(merged).filter((n) => n === HFM)).toHaveLength(1);
      }
    });
    it("honours a caller who disables the dropped features, or enables HFM", () => {
      const own = ["--disable-features=HttpsUpgrades,BoundaryEventDispatchTracksNodeRemoval,MediaRouter"];
      const merged = mergeFeatureFlags([...playwrightFeatureArgs(own, undefined, defaults("A", ...DROPPED)), ...own]);
      const n = names(merged);
      for (const f of [...DROPPED, HFM]) expect(n.filter((x) => x === f)).toHaveLength(1);
      const en = ["--enable-features=" + HFM];
      const out = playwrightFeatureArgs(en, undefined, defaults("A", ...DROPPED));
      expect(out[0]).not.toContain(HFM);
      expect(mergeFeatureFlags([...out, ...en]).filter((a) => a.includes(HFM))).toEqual([`--enable-features=Cdp,${HFM}`]);
    });
    it("a caller who enables a managed feature gets it only in --enable-features (defaults with and without HFM)", () => {
      for (const d of [defaults("A", HFM, ...DROPPED), defaults("A", ...DROPPED)]) {
        for (const feat of [HFM, ...DROPPED]) {
          const own = ["--enable-features=" + feat];
          const merged = mergeFeatureFlags([...playwrightFeatureArgs(own, undefined, d), ...own]);
          const en = merged.filter((a) => a.startsWith("--enable-features="));
          expect(en).toHaveLength(1);
          expect(en[0].split("=")[1].split(",")).toContain(feat);
          for (const x of merged.filter((a) => a.startsWith("--disable-features="))) expect(x.split("=")[1].split(",")).not.toContain(feat);
        }
        expect(names(mergeFeatureFlags(playwrightFeatureArgs([], undefined, d))).filter((n) => n === HFM)).toHaveLength(1);
      }
    });
    it("leaves the feature lists untouched when Playwright's defaults cannot be read", () => {
      for (const own of [[], ["--x"], ["--disable-features=HttpsUpgrades"], ["--enable-features=Foo", "--disable-features=Foo"]]) {
        expect(playwrightFeatureArgs(own, undefined, null, true)).toEqual([]);
        expect(withPlaywrightFeatureDefaults([...own], undefined, true, null)).toEqual(mergeFeatureFlags([...own]));
      }
      expect(mergeIgnoreDefaultArgs(undefined)).toContain("--hide-scrollbars");
    });
    const OLD = 'disabledFeatures = ["ThirdPartyStoragePartitioning", "T"];\nchromiumSwitches = [\n  "--disable-features=" + disabledFeatures.join(","),\n  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? "" : "--enable-features=CDPScreenshotNewSurface",\n  "--x",\n];';
    const NEW = 'disabledFeatures = [\n "ThirdPartyStoragePartitioning",\n "T"\n].filter(Boolean);\nenabledFeatures = () => [\n  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? "" : "CDPScreenshotNewSurface",\n  // why\n  "SkipListAccountsWithoutGaiaCookies"\n].filter(Boolean);\nchromiumSwitches = (o) => [\n  "--disable-features=" + disabledFeatures.join(","),\n  "--enable-features=" + enabledFeatures().join(","),\n];';
    const DECOY = 'throw new Error(\'WebMCP is not enabled. Launch the browser with the "--enable-features=WebMCP" argument.\');\n';
    it("reads Playwright's default --enable-features from the older layout", () => {
      expect(parsePlaywrightFeatureDefaults(OLD, {})?.enabled).toEqual(["CDPScreenshotNewSurface"]);
      expect(parsePlaywrightFeatureDefaults(OLD, { PLAYWRIGHT_LEGACY_SCREENSHOT: "1" })?.enabled).toEqual([]);
    });
    it("reads Playwright's default --enable-features from the current layout", () => {
      const d = parsePlaywrightFeatureDefaults(NEW, {});
      expect(d?.enabled).toEqual(["CDPScreenshotNewSurface", "SkipListAccountsWithoutGaiaCookies"]);
      expect(d?.disabled).toEqual(["T"]);
      expect(parsePlaywrightFeatureDefaults(NEW, { PLAYWRIGHT_LEGACY_SCREENSHOT: "1" })?.enabled).toEqual(["SkipListAccountsWithoutGaiaCookies"]);
    });
    it("ignores an --enable-features string that is not the default switch", () => {
      for (const layout of [OLD, NEW]) {
        const real = parsePlaywrightFeatureDefaults(layout, {})?.enabled;
        expect(parsePlaywrightFeatureDefaults(DECOY + layout, {})?.enabled).toEqual(real);
        expect(parsePlaywrightFeatureDefaults(layout + "\n" + DECOY, {})?.enabled).toEqual(real);
        expect(real).not.toContain("WebMCP");
      }
    });
    it("returns undefined when the enabled list is not recognisable", () => {
      expect(parsePlaywrightFeatureDefaults(NEW.replace('"SkipListAccountsWithoutGaiaCookies"', 'cond() ? "X" : "Y"'), {})).toBeUndefined();
      expect(parsePlaywrightFeatureDefaults(NEW.replace('"--enable-features=" + enabledFeatures().join(",")', '"--other"'), {})).toBeUndefined();
      // only a decoy string and no enabled list at all: nothing is read from it and the layout is unknown
      expect(parsePlaywrightFeatureDefaults('disabledFeatures = ["ThirdPartyStoragePartitioning"];\n' + DECOY, {})).toBeUndefined();
      // no --enable-features= string and no enabledFeatures identifier: an old Playwright with none
      expect(parsePlaywrightFeatureDefaults('disabledFeatures = ["ThirdPartyStoragePartitioning"];', {})?.enabled).toEqual([]);
      // the enabledFeatures identifier alone (no switch string to anchor on) is not guessed at
      expect(parsePlaywrightFeatureDefaults('disabledFeatures = ["ThirdPartyStoragePartitioning"];\nenabledFeatures = ["A"];', {})).toBeUndefined();
    });
    const REAL = ["CDPScreenshotNewSurface", "SkipListAccountsWithoutGaiaCookies"];
    const enabledOf = (src: string) => parsePlaywrightFeatureDefaults(src, {})?.enabled;
    it("layout variants give the right list or undefined", () => {
      // a "]" inside a comment in the array
      expect(enabledOf(NEW.replace("// why", "// why [x] ]"))).toEqual(REAL);
      expect(enabledOf(NEW.replace("// why", "/* why ] */"))).toEqual(REAL);
      // the enable entry is not directly after the disable entry
      const far = OLD.replace("  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT", '  "--other",\n  process.env.PLAYWRIGHT_LEGACY_SCREENSHOT');
      expect(far).not.toBe(OLD);
      expect(enabledOf(far)).toBeUndefined();
      // an inline array in the switch
      expect(enabledOf('disabledFeatures = ["ThirdPartyStoragePartitioning"];\nx = ["--enable-features=" + ["A"].join(",")];')).toBeUndefined();
      // a renamed variable still resolves through the switch that is emitted
      const renamed = NEW.replaceAll("enabledFeatures", "enabledFeatureList");
      expect(enabledOf(renamed)).toEqual(REAL);
      // an unrelated earlier enabledFeatures array is not the one emitted
      expect(enabledOf('enabledFeatures = ["Unrelated"];\n' + renamed)).toEqual(REAL);
      // ... and two assignments to the emitted name are ambiguous
      expect(enabledOf('enabledFeatures = ["Unrelated"];\n' + NEW)).toBeUndefined();
      // a computed array tail is not a plain list
      expect(enabledOf(NEW.replace(".filter(Boolean);\nchromiumSwitches", ".concat(extra);\nchromiumSwitches"))).toBeUndefined();
    });
    const excerpt = () => readFileSync(fileURLToPath(new URL("../../fixtures/playwright-1.65.1-chromium-switches.js", import.meta.url)), "utf8");
    it("reads the checked-in playwright 1.65.1 excerpt", () => {
      const d = parsePlaywrightFeatureDefaults(excerpt(), {});
      expect(d?.enabled).toEqual(REAL);
      expect(d?.disabledFull).toContain("ThirdPartyStoragePartitioning");
      expect(d?.disabled).not.toContain("ThirdPartyStoragePartitioning");
      expect([...(d?.enabled ?? []), ...(d?.disabled ?? [])]).not.toContain("WebMCP");
    });
    const finalEnable = (defaults: ReturnType<typeof parsePlaywrightFeatureDefaults> | "installed" | null) => {
      const own = webBluetoothArgs("windows", "linux");
      expect(own).toEqual(["--enable-features=WebBluetooth"]);
      const merged = defaults === "installed"
        ? withPlaywrightFeatureDefaults([...own, "--x"], undefined, true)
        : mergeFeatureFlags([...playwrightFeatureArgs(own, undefined, defaults ?? null, true), ...own, "--x"]);
      const enables = merged.filter((a) => a.startsWith("--enable-features="));
      expect(enables).toHaveLength(1);
      return enables[0].split("=")[1].split(",");
    };
    it("the SDK's own --enable-features never contain WebMCP", () => {
      let got = finalEnable("installed");
      expect(got).toContain("WebBluetooth");
      expect(got).not.toContain("WebMCP");
      expect(got).not.toContain("DeclarativeWebMCP");
      for (const src of [OLD, NEW, DECOY + OLD, DECOY + NEW, excerpt()]) {
        const defaults = parsePlaywrightFeatureDefaults(src, {});
        expect(defaults).toBeDefined();
        got = finalEnable(defaults);
        expect(got).toContain("WebBluetooth");
        expect(got).not.toContain("WebMCP");
        expect(got).not.toContain("DeclarativeWebMCP");
        for (const f of defaults!.enabled) expect(got).toContain(f);
      }
      expect(finalEnable(null)).toEqual(["WebBluetooth"]); // the fallback reads nothing and adds nothing
    });
    it("the fallback warning names what gets replaced, once", async () => {
      vi.resetModules();
      const fresh = await import("../src/launchopts.js");
      const writes: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      const savedQuiet = process.env.ANT0_BROWSER_NO_WARN;
      delete process.env.ANT0_BROWSER_NO_WARN;
      (process.stderr as any).write = (c: any) => { writes.push(String(c)); return true; };
      try {
        fresh.playwrightFeatureArgs([], undefined, null);
        fresh.playwrightFeatureArgs([], undefined, null);
      } finally {
        process.stderr.write = orig;
        if (savedQuiet !== undefined) process.env.ANT0_BROWSER_NO_WARN = savedQuiet;
      }
      const w = writes.filter((x) => x.includes("[features]"));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("ThirdPartyStoragePartitioning");
      expect(w[0]).not.toContain("stays disabled");
      expect(w[0]).toContain("With neither switch, Playwright's lists stay in effect");
      expect(w[0]).toContain("replaces Playwright's whole disabled list");
      expect(w[0]).toContain("no longer disabled");
      expect(w[0]).toContain("CDPScreenshotNewSurface");
    });
    it("matches the real defaults of the installed playwright-core", () => {
      const dir = dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
      const text = readFileSync(join(dir, "lib/coreBundle.js"), "utf8");
      // A different method from the parse: run Playwright's own definitions and take what it emits.
      const start = text.indexOf("disabledFeatures = [");
      const end = text.indexOf("\n  }\n});", start);
      const fn = new Function(`let disabledFeatures, enabledFeatures, chromiumSwitches;\n${text.slice(start, end)}\nreturn chromiumSwitches({});`);
      const args = fn() as string[];
      const realEnabled = args.find((a) => a.startsWith("--enable-features="))!.split("=")[1].split(",");
      const realDisabled = args.find((a) => a.startsWith("--disable-features="))!.split("=")[1].split(",");
      const got = installedPlaywrightFeatureDefaults();
      expect(got?.enabled).toEqual(realEnabled);
      expect(got?.disabledFull).toEqual(realDisabled);
      expect(got?.enabled).not.toContain("WebMCP");
    });
  });

  it("removes ipc flooding protection from Playwright's defaults", () => {
    expect(IGNORED_PLAYWRIGHT_DEFAULTS).toContain("--disable-ipc-flooding-protection");
    expect(IGNORED_PLAYWRIGHT_DEFAULTS).toContain("--enable-automation");
  });
});

describe("socks5UdpArgs", () => {
  const socks5 = { server: "socks5://gw.example.com:1080", username: "u", password: "p" };

  it("emits the switch for a socks5 proxy when opted in", () => {
    expect(socks5UdpArgs(true, socks5)).toEqual(["--socks5-udp"]);
  });

  it("is off unless explicitly opted in", () => {
    for (const v of [undefined, false]) expect(socks5UdpArgs(v, socks5)).toEqual([]);
  });

  // UDP ASSOCIATE is a SOCKS5 command. Emitting the switch for a transport that cannot carry a
  // datagram would be accepted and silently do nothing -- the failure mode this guards against.
  it("stays silent for schemes that cannot relay UDP", () => {
    for (const server of ["http://p:8080", "https://p:8443", "socks4://p:1080"]) {
      expect(socks5UdpArgs(true, { server })).toEqual([]);
    }
  });

  it("stays silent with no proxy at all", () => {
    expect(socks5UdpArgs(true, undefined)).toEqual([]);
    expect(socks5UdpArgs(true, { server: "" })).toEqual([]);
  });

  it("accepts socks5h and is case-insensitive", () => {
    expect(socks5UdpArgs(true, { server: "socks5h://p:1080" })).toEqual(["--socks5-udp"]);
    expect(socks5UdpArgs(true, { server: "SOCKS5://p:1080" })).toEqual(["--socks5-udp"]);
  });

  // Verified against the proxy's own log: the association is established with the deny policy in
  // force, so the two are additive and enabling UDP does not mean weakening the leak default.
  it("composes with the webrtc deny default rather than replacing it", () => {
    const args = [...socks5UdpArgs(true, socks5)];
    const withDefault = [...args, ...webrtcDefaultDenyArgs(args, undefined)];
    expect(withDefault).toContain("--socks5-udp");
    expect(withDefault).toContain("--webrtc-ip-handling-policy=disable_non_proxied_udp");
  });
});

describe("resolveProxy: userinfo inside a SOCKS URL", () => {
  it("counts as credentials and throws (Chromium would drop it silently)", async () => {
    const { resolveProxy } = await import("../src/launchopts.js");
    expect(() => resolveProxy({ server: "socks5://u:p@h:1080" })).toThrow(/RFC 1929/);
    expect(() => resolveProxy({ server: "socks5h://u@h:1080" })).toThrow(/relay/);
    expect(resolveProxy({ server: "http://u:p@h:3128" })).toEqual({
      args: [],
      proxy: { server: "http://u:p@h:3128" },
    });
  });
});

// Direct launches (serve/launchPlan) get the first-run hygiene Playwright adds for launch(); without
// it the engine opens chrome://ungoogled-first-run in the first tab.
describe("first-run hygiene for direct launches", () => {
  it("is exactly the three plain UI switches, never a base::Feature toggle", () => {
    expect([...FIRST_RUN_HYGIENE_ARGS]).toEqual([
      "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen",
    ]);
    expect(FIRST_RUN_HYGIENE_ARGS.some((a) => a.includes("features="))).toBe(false);
  });

  it("hasUrlPositional: a non-switch argument is a URL; everything after `--` is positional", () => {
    expect(hasUrlPositional([])).toBe(false);
    expect(hasUrlPositional(["--no-sandbox", "--window-size=1,2"])).toBe(false);
    expect(hasUrlPositional(["--no-sandbox", "https://example.com/"])).toBe(true);
    expect(hasUrlPositional(["about:blank"])).toBe(true);
    expect(hasUrlPositional(["--"])).toBe(false);
    expect(hasUrlPositional(["--", "--looks-like-a-switch"])).toBe(true);
  });

  it("defaultStartUrlArgs: about:blank only when the caller supplied no URL", () => {
    expect(defaultStartUrlArgs(["--no-sandbox"])).toEqual(["about:blank"]);
    expect(defaultStartUrlArgs(["--no-sandbox", "https://example.com/"])).toEqual([]);
    expect(defaultStartUrlArgs(["about:blank"])).toEqual([]);
  });
});

describe("switch spelling and the policy in force", () => {
  const IP = "--webrtc-ip=203.0.113.7";
  it.each(["-webrtc-ip=203.0.113.7", "/webrtc-ip=203.0.113.7", "--WebRTC-IP=203.0.113.7", "--webrtc-ip"])(
    "drops %s on an old engine", (arg) => {
      expect(gateWebrtcIpArgs([arg, "--x"], "158.0.8127.18-ant0.2", true)).toEqual(["--x"]);
    });
  it("drops an empty, bare or non-IP value on ant0.3 in any spelling, keeps a valid one", () => {
    const NEW = "158.0.8127.18-ant0.3";
    expect(gateWebrtcIpArgs(["--webrtc-ip", "-webrtc-ip=", "/WEBRTC-IP=nope", IP], NEW, true)).toEqual([IP]);
  });
  it("does not touch anything after a bare --", () => {
    expect(gateWebrtcIpArgs(["--", IP], "158.0.8127.18-ant0.2", true)).toEqual(["--", IP]);
  });
  it("the policy in force: last wins, force wins, empty and bare set nothing", () => {
    expect(effectiveWebrtcPolicy(["--webrtc-ip-handling-policy=default", "--webrtc-ip-handling-policy=disable_non_proxied_udp"])).toBe("disable_non_proxied_udp");
    expect(effectiveWebrtcPolicy(["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=default"])).toBe("disable_non_proxied_udp");
    expect(effectiveWebrtcPolicy(["--webrtc-ip-handling-policy=", "--webrtc-ip-handling-policy", "-FORCE-webrtc-ip-handling-policy="])).toBeUndefined();
    expect(callerAllowsUdp(["-webrtc-ip-handling-policy=default"])).toBe(true);
    expect(callerAllowsUdp(["--webrtc-ip-handling-policy=default", "--webrtc-ip-handling-policy=disable_non_proxied_udp"])).toBe(false);
    expect(callerAllowsUdp(["--webrtc-ip-handling-policy="])).toBe(false);
  });
  it("sees a raw --proxy-server in any spelling, but not direct:// or --no-proxy-server", () => {
    expect(hasRawProxyServer(["-proxy-server=http://h:1"])).toBe(true);
    expect(hasRawProxyServer(["--proxy-server=direct://"])).toBe(false);
    expect(hasRawProxyServer(["--proxy-server=http://h:1", "--no-proxy-server"])).toBe(false);
    expect(hasRawProxyServer([])).toBe(false);
  });
  it("gateWebrtcArgs adds the no-local-dns switch for a raw proxy, once, in any spelling", () => {
    const NEW = "158.0.8127.18-ant0.3";
    expect(gateWebrtcArgs(["--proxy-server=http://h:1"], NEW, true, false)).toContain("--webrtc-no-local-dns");
    expect(gateWebrtcArgs(["--proxy-server=http://h:1", "-WEBRTC-NO-LOCAL-DNS"], NEW, true, false)).toEqual(["--proxy-server=http://h:1", "-WEBRTC-NO-LOCAL-DNS"]);
  });
});
