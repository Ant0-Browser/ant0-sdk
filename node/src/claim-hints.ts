/**
 * Hints a caller may send when it asks the cloud to issue an identity (the `hints` field of the
 * profile claim request).
 *
 * The SDK has no request path to the daemon or the cloud for identities (the daemon owns the claim),
 * so these are types only. The daemon passes the same shape through.
 */

/** Browser brand a persona may present. */
export type ClaimBrand = "chrome" | "edge";
/** Vendor of the claiming host's real GPU. */
export type ClaimHostGpuVendor = "intel" | "nvidia" | "amd" | "apple";

/** Locale inputs for the persona, from the profile's proxy. Required when population model V2.2 is requested. */
export interface ClaimLocale {
  /** BCP 47 tag of the OS language, e.g. "en-US". */
  os_language: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** One to eight BCP 47 tags; the cloud moves `os_language` to the front when it is not first. */
  languages?: string[];
}

export interface ClaimHints {
  /** `windows`, `macos` or `linux`. */
  os_family?: string;
  browser_major?: number;
  /** Population model version, `^[a-z0-9][a-z0-9._-]{0,63}$`. Fresh issuance only. */
  model_version?: string;
  brand?: ClaimBrand;
  locale?: ClaimLocale;
  /** Whether the claiming host presents its real GPU (default false). */
  host_gpu?: boolean;
  host_gpu_vendor?: ClaimHostGpuVendor;
  /** The engine's `--ant0-sdk-info` `persona.capabilities`: at most 64 ids matching `^[a-z0-9_.]{1,64}$`, no
   * duplicates. Sent with a model version; the newest model refuses a claim without it. */
  engine_capabilities?: string[];
}
