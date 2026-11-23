// Check the installed SDK and public declarations without engine/account access (see README).
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import {
  CHROMIUM_MAJOR, CHROMIUM_UA_VERSION, CHROMIUM_VERSION,
  identityFilename, launch, launchPersistentContext, launchPlan,
  prepareIdentityOptions, resolveIdentity, serve, validatePersonaProfileV2,
  type Identity, type LaunchOptions, type LaunchPlan, type PersistentContextOptions,
  type PersonaProfileV2, type ServeOptions,
} from "ant0-browser";

async function main(): Promise<void> {
  const installedRoot = realpathSync(resolve("node_modules/ant0-browser"));
  const entry = realpathSync(fileURLToPath(import.meta.resolve("ant0-browser")));
  assert.ok(entry.startsWith(installedRoot + sep), "SDK must resolve from this consumer's install");
  const metadata = JSON.parse(readFileSync(resolve(installedRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, "ant0-browser");
  assert.equal(metadata.license, "BSD-3-Clause");
  assert.ok(readFileSync(resolve(installedRoot, "LICENSE"), "utf8").includes("BSD 3-Clause License"));

  assert.equal(CHROMIUM_MAJOR, Number(CHROMIUM_VERSION.split(".")[0]));
  assert.equal(CHROMIUM_UA_VERSION, `${CHROMIUM_MAJOR}.0.0.0`);
  const identity: Identity = { mode: "native" };
  assert.deepEqual(resolveIdentity(identity), { mode: "native" });
  assert.deepEqual(prepareIdentityOptions({ identity, overrides: { timezone: "UTC" } }), {
    identityMode: "native", options: { timezone: "UTC" },
  });
  // Public shared test vector: not a real device key and never persisted.
  assert.equal(identityFilename("account-42", Uint8Array.from({ length: 32 }, (_, i) => i)),
    "5f3899096575bd43b8a0f24f354c057f43fa8d63ec7592cc15c5d7505d508566.json");
  const invalidProfile = validatePersonaProfileV2({});
  assert.equal(invalidProfile.valid, false);
  assert.ok(invalidProfile.errors.length > 0);

  const launchOptions: LaunchOptions = { identity, launchTicket: false, ephemeralProfile: false };
  const persistentOptions: PersistentContextOptions = { identity, launchTicket: false, viewport: null };
  const serveOptions: ServeOptions = { ...launchOptions, host: "127.0.0.1", port: 9222 };
  const planFunction: (options?: ServeOptions) => Promise<LaunchPlan> = launchPlan;
  const validateFunction: (profile: PersonaProfileV2) => unknown = validatePersonaProfileV2;
  void persistentOptions;
  void serveOptions;
  void planFunction;
  void validateFunction;
  assert.equal(typeof launch, "function");
  assert.equal(typeof launchPersistentContext, "function");
  assert.equal(typeof serve, "function");
  // Invalid identity fails before binary lookup, ticket discovery or Playwright startup.
  await assert.rejects(launch({ ...launchOptions, identity: { mode: "invalid" } as unknown as Identity }),
    /identity\.mode must be one of/);
  console.log(`installed Node SDK smoke passed: ${metadata.version} (engine-free)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
