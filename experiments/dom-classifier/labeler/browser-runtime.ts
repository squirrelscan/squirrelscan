import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export type PlaywrightRuntime = {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<any>;
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

export function browserLaunchOptions() {
  const executablePath =
    process.env.LABELER_BROWSER_EXECUTABLE?.trim() ||
    process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  if (executablePath && !existsSync(executablePath))
    throw new Error(`Browser executable does not exist: ${executablePath}`);
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

export async function loadPlaywright(): Promise<PlaywrightRuntime> {
  return (await import(resolvePlaywrightModule())) as PlaywrightRuntime;
}
