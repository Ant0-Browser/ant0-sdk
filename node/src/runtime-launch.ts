import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkInstall } from "./download.js";
import { hasLaunchTicketArg, inferEngineVersion, installedEngineVersion, resolveDaemonHome, resolveLaunchTicketArgs, type LaunchTicketOption } from "./launch-ticket.js";
import { executeRuntime, runtimeBinding, RuntimeError, type Binding, type RuntimeOptions } from "./runtime-client.js";
import { SdkTypeError } from "./errors.js";

export interface RuntimeLaunchOptions extends LaunchTicketOption {
  executablePath?: string;
  runtime?: RuntimeOptions;
  args?: readonly string[];
  quiet?: boolean;
}
export const manualBinary = (options: RuntimeLaunchOptions): string | undefined => options.executablePath || process.env.ANT0_BROWSER_BINARY?.trim() || undefined;

/** Private result ownership: consumers must release after their immediate spawn attempt. */
export async function prepareRuntimeLaunch(options: RuntimeLaunchOptions): Promise<{ executable: string; ticketArgs: string[]; engineVersion?: string; release(): void }> {
  const args = options.args ?? [];
  const suppressed = options.launchTicket === false || hasLaunchTicketArg(args);
  const supplied = !suppressed && typeof options.launchTicket === "string";
  if (supplied && (options.launchTicket as string).split(".").length !== 5) throw new SdkTypeError("sdk.launch_ticket_invalid", "launchTicket must be the five-segment value the daemon issues");
  const ticketArgs = supplied ? [`--ant0-launch=${options.launchTicket}`] : [];
  const executable = manualBinary(options);
  if (executable) {
    checkInstall(executable);
    // The release the binary identifies as: the caller's word, else .release.json / path / env.
    // Undefined for a bare binary, which callers treat as an old engine where it matters.
    const engine = options.engineVersion ?? inferEngineVersion(executable);
    // What the `--webrtc-ip` gate may trust: the caller's explicit word (the daemon passes its
    // verified install record) or the release record beside the executable. Not the path or env.
    const trusted = options.engineVersion ?? installedEngineVersion(executable);
    if (suppressed || supplied) return { executable, ticketArgs, engineVersion: trusted, release() {} };
    if (!engine) return { executable, ticketArgs, engineVersion: trusted, release() {} };
    // The caller's explicit bearer remains the published, unqualified manual transport.
    if (process.env.ANT0_TOKEN !== undefined) return { executable, engineVersion: trusted,
      ticketArgs: await resolveLaunchTicketArgs({ ...options, executable, args }), release() {} };
    const binding = await runtimeBinding(options.runtime);
    try {
      let result;
      try { result = await executeRuntime("fetch-ticket", binding, engine); }
      catch (e) {
        if (!(e instanceof RuntimeError) || e.code !== "runtime.absent" || binding.mode !== "v1" || binding.descriptor_path !== null) throw e;
        const home = binding.home ?? resolveDaemonHome();
        // This is only a locator. The native core rereads the protected record and proves the peer.
        let endpoint = binding.endpoint;
        if (!endpoint) {
          let pid: any;
          try { const raw = readFileSync(join(home, "ant0d.pid")); if (raw.length > 16384) throw new Error(); pid = JSON.parse(raw.toString("utf8")); }
          catch { throw new RuntimeError("runtime.not_running"); }
          const normalized = await runtimeBinding({ home, host: pid.host, port: pid.port }, {});
          endpoint = normalized.endpoint;
          if (!endpoint) throw new RuntimeError("runtime.invalid_request");
        }
        const legacy: Binding = { mode: "legacy", home, endpoint };
        result = await executeRuntime("fetch-ticket", legacy, engine);
      }
      return { executable, engineVersion: trusted, ticketArgs: [`--ant0-launch=${result.value.ticket.launch}`], release: result.release };
    } catch (e) {
      if (binding.mode === "v1" && binding.descriptor_path !== null || !(e instanceof RuntimeError) || ["runtime.invalid_request", "runtime.untrusted", "runtime.incompatible", "runtime.invalid_response"].includes(e.code)) throw e;
      if (!options.quiet && process.env.ANT0_BROWSER_NO_WARN === undefined) process.stderr.write(`[ant0-browser] [launch-ticket] ${e.code}; launching without a ticket\n`);
      return { executable, engineVersion: trusted, ticketArgs: [], release() {} };
    }
  }
  if (process.env.ANT0_TOKEN !== undefined) throw new RuntimeError("runtime.invalid_request");
  const binding = await runtimeBinding(options.runtime);
  const engineVersion = options.engineVersion ?? process.env.ANT0_BROWSER_ENGINE_VERSION ?? null;
  const result = await executeRuntime("resolve-direct-engine", binding, engineVersion, !suppressed && !supplied);
  return { executable: result.value.engine.executable, engineVersion: result.value.engine.version,
    ticketArgs: result.value.ticket ? [`--ant0-launch=${result.value.ticket.launch}`] : ticketArgs,
    release: result.release };
}

export async function withRuntimeLaunch<T>(options: RuntimeLaunchOptions,
  spawn: (resolved: { executable: string; ticketArgs: string[]; engineVersion?: string }) => T | Promise<T>): Promise<T> {
  const resolved = await prepareRuntimeLaunch(options);
  try { return await spawn(resolved); } finally { resolved.release(); }
}
