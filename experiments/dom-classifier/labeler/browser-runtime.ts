import { existsSync } from "node:fs";
import { createRequire } from "node:module";
// Types only: erased at runtime, so the module is still resolved dynamically by
// resolvePlaywrightModule and the experiment stays untied to one install path.
// Typing launch()'s result is what gives callers a real Page, and with it typed
// evaluate/waitForFunction/waitForResponse callbacks.
import type { Browser, LaunchOptions } from "playwright";

export type PlaywrightRuntime = {
  chromium: {
    launch(options?: LaunchOptions): Promise<Browser>;
  };
};

const require = createRequire(import.meta.url);

/**
 * Resolve Playwright without tying the experiment to one workstation's cache.
 * An operator may point at a bundled runtime when the package is not installed
 * in the current workspace.
 */
export function resolvePlaywrightModule() {
  const configured = process.env.LABELER_PLAYWRIGHT_MODULE?.trim();
  if (configured) {
    try {
      return require.resolve(configured);
    } catch {
      if (existsSync(configured)) return configured;
      throw new Error(`Playwright module does not exist: ${configured}`);
    }
  }
  try {
    return require.resolve("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed; install it or set LABELER_PLAYWRIGHT_MODULE to an installed module path",
    );
  }
}

/**
 * Why a browser suite cannot run here, or null when it can.
 *
 * CI deliberately has no Playwright, so browser suites must skip rather than
 * fail. Resolution is sync and launches nothing, so a suite can decide at
 * registration time. It deliberately does not consult
 * `chromium.executablePath()`: that reports the headed Chromium build while
 * `browserLaunchOptions()` runs headless and Playwright picks the headless
 * shell, so an installed shell would read as missing.
 */
export function browserRuntimeUnavailableReason(): string | null {
  try {
    resolvePlaywrightModule();
  } catch (error) {
    return error instanceof Error ? error.message : "Playwright module could not be resolved";
  }
  const configured =
    process.env.LABELER_BROWSER_EXECUTABLE?.trim() || process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  if (configured && !existsSync(configured)) return `Browser executable does not exist: ${configured}`;
  return null;
}

export function browserLaunchOptions() {
  const executablePath =
    process.env.LABELER_BROWSER_EXECUTABLE?.trim() ||
    process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  if (executablePath && !existsSync(executablePath))
    throw new Error(`Browser executable does not exist: ${executablePath}`);
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

function isPlaywrightRuntime(value: unknown): value is PlaywrightRuntime {
  return Boolean(
    value &&
    typeof value === "object" &&
    "chromium" in value &&
    value.chromium &&
    typeof (value.chromium as { launch?: unknown }).launch === "function",
  );
}

/**
 * Bun exposes Playwright's CJS entry as named exports, while Node's native ESM
 * loader exposes the same package under `default`. Accept both module shapes
 * and fail before capture work begins when neither is a browser runtime.
 */
export function playwrightRuntimeFromModule(moduleValue: unknown): PlaywrightRuntime {
  if (isPlaywrightRuntime(moduleValue)) return moduleValue;
  if (
    moduleValue &&
    typeof moduleValue === "object" &&
    "default" in moduleValue &&
    isPlaywrightRuntime(moduleValue.default)
  )
    return moduleValue.default;
  throw new Error("Playwright module does not expose chromium.launch");
}

export async function loadPlaywright(): Promise<PlaywrightRuntime> {
  return playwrightRuntimeFromModule(await import(resolvePlaywrightModule()));
}
