// Test-only timing knobs (#1839). End-to-end tests run the real CLI, so they used to wait
// out production floors (the --max-duration margin, the start-URL probe timeouts) in full.
//
// These are not user settings and are not documented. Each is read only when NODE_ENV is
// "test": `bun test` sets that (and a subprocess the test spawns inherits it). The shipped
// binary has NODE_ENV inlined as a build-time constant (see testOnlyMs), so there the knobs
// are inert whatever the environment says, and the production values apply.

/** Replaces the 15 s floor of the --max-duration margin. */
export const TEST_MIN_MARGIN_MS_ENV = "SQUIRREL_TEST_MIN_MARGIN_MS";
/** Replaces the start-URL probe timeouts: the reachability check's per-attempt and total limits and the redirect probe's per-hop limit. */
export const TEST_REACHABILITY_TIMEOUT_MS_ENV =
  "SQUIRREL_TEST_REACHABILITY_TIMEOUT_MS";

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * The value of the test-only knob `name` in ms, or undefined when NODE_ENV is not "test"
 * or the value is not a finite positive integer (decimal digits only, no sign, exponent or
 * whitespace). Read on each call, so a test can set and clear it.
 */
export function testOnlyMs(
  name: string,
  env: Record<string, string | undefined> = process.env
): number | undefined {
  // The literal `process.env.NODE_ENV` is what `bun build` replaces with a constant
  // ("development" unless --production), so in the compiled binary this line always returns
  // and NODE_ENV=test at runtime cannot turn a knob on. `env` alone is not folded: keep both.
  if (process.env.NODE_ENV !== "test" || env.NODE_ENV !== "test")
    return undefined;
  const raw = env[name];
  if (raw === undefined || !POSITIVE_INTEGER.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}
