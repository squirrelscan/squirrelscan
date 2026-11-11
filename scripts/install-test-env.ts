// #3896: a test that runs install.sh (or sources its reporting preamble) with telemetry ON expects a failure
// report, and the report goes to `SQUIRREL_ERROR_ENDPOINT`. The tests intercept `curl` with a shim, but a shim
// that fails to intercept (a PATH that does not put it first, a fork's runner, a contributor's machine) would
// otherwise POST a fabricated failure to the production installer endpoint. 500 such reports a week reached
// production from a copy that was not fetched live (INSTALLER-WORKER-7). So every such test points the
// endpoint at an address nothing listens on: port 9 (discard) on loopback, which refuses at once.
export const DEAD_ERROR_ENDPOINT = "http://127.0.0.1:9/error";

const PRODUCTION_ERROR_HOST = /(^|[/.])squirrelscan\.com(\/|:|$)/i;

/**
 * Throws when `env` would let install.sh send a report to a production host: telemetry on (no
 * `NO_TELEMETRY`, no `DO_NOT_TRACK`) and an endpoint that is unset (the production default) or a squirrelscan
 * host. A test that really wants the production default must not run install.sh at all.
 */
export function assertInstallerEnvCannotReachProduction(
  env: Record<string, string | undefined>,
): void {
  const off =
    env.NO_TELEMETRY !== undefined || ["1", "true"].includes((env.DO_NOT_TRACK ?? "").toLowerCase());
  if (off) return;
  const endpoint = env.SQUIRREL_ERROR_ENDPOINT;
  if (!endpoint || PRODUCTION_ERROR_HOST.test(endpoint)) {
    throw new Error(
      "install.sh test env has telemetry on and no non-production SQUIRREL_ERROR_ENDPOINT: a curl shim that " +
        "failed to intercept would report to production (#3896). Set SQUIRREL_ERROR_ENDPOINT: DEAD_ERROR_ENDPOINT.",
    );
  }
}
