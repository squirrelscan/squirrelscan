// The one way a CLI test keeps the real ~/.squirrel out of reach (#626).
//
// Every squirrel path derives from `os.homedir()`, and Bun reads that once at
// process start: `process.env.HOME = tmp` inside a test moves nothing. A test
// that runs an audit or a publish with only HOME set reads and writes the
// developer's real store, and on a machine with thousands of project databases
// it times out walking them. This spies the paths module's getters onto a
// scratch directory for the whole file, and removes the directory afterwards.
//
// Call it once, at the top level of a test file. `tests/squirrel-home-guard.test.ts`
// fails any test file that publishes or touches project data without it.
//
// No `mock.module`: bun's module mocks are process-wide and outlive the file.
// Spies are restored in `afterAll`, and the process-wide content store and link
// cache, opened under the scratch dir by whatever ran, are closed before it goes.
import { afterAll, beforeAll, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

import type { SquirrelPaths } from "@/self/paths";

import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import * as pathsModule from "@/self/paths";

export interface ScratchSquirrelHome {
  /** The scratch dir itself, for a test's own files (configs, reports). */
  readonly dir: string;
  /** Where every redirected path lives right now. */
  readonly root: string;
  /**
   * Point every path at a fresh `name` directory under the scratch dir, for a
   * test that needs a store of its own. Closes the open stores first, so the
   * next audit opens them at the new location.
   */
  use(name: string): string;
}

/** A getter a test may point somewhere else than `<root>/<default>`. */
export type ScratchPathOverrides = {
  getContentStorePath?: (root: string) => string;
};

export function isolateSquirrelHome(
  prefix: string,
  overrides: ScratchPathOverrides = {}
): ScratchSquirrelHome {
  const scratch = mkdtempSync(join(tmpdir(), `${prefix}-`));
  let root = join(scratch, "home");
  mkdirSync(root, { recursive: true });

  const paths = (): SquirrelPaths => ({
    data: root,
    config: root,
    bin: join(root, "bin"),
    releases: join(root, "releases"),
    projects: join(root, "projects"),
    cache: join(root, "cache"),
    logs: join(root, "logs"),
  });
  const redirect = {
    getSquirrelPaths: paths,
    getSettingsPath: () => join(root, "settings.json"),
    getProjectsPath: () => paths().projects,
    getLinkCachePath: () => join(root, "link-cache.db"),
    getContentStorePath: () =>
      overrides.getContentStorePath?.(root) ?? join(root, "content-store.db"),
    getCachePath: () => paths().cache,
    getLogsPath: () => paths().logs,
    getUpdateLockPath: () => join(root, "update.lock"),
  } as const;

  const restores: (() => void)[] = [];
  beforeAll(() => {
    // A store some earlier file left open would keep pointing at its location.
    closeGlobalContentStore();
    closeGlobalLinkCache();
    for (const [name, impl] of Object.entries(redirect)) {
      const spy = spyOn(
        pathsModule,
        name as keyof typeof redirect
      ).mockImplementation(impl as never);
      restores.push(() => spy.mockRestore());
    }
    // The point of the helper, checked where it can still fail loudly.
    const realSquirrel = resolve(userInfo().homedir, ".squirrel");
    for (const path of [
      pathsModule.getProjectsPath(),
      pathsModule.getSettingsPath(),
      pathsModule.getContentStorePath(),
    ]) {
      if (resolve(path).startsWith(realSquirrel + sep)) {
        throw new Error(`scratch squirrel home leaked a real path: ${path}`);
      }
    }
  });

  afterAll(() => {
    closeGlobalContentStore();
    closeGlobalLinkCache();
    for (const restore of restores.splice(0)) restore();
    rmSync(scratch, { recursive: true, force: true });
  });

  return {
    dir: scratch,
    get root() {
      return root;
    },
    use(name: string) {
      closeGlobalContentStore();
      closeGlobalLinkCache();
      root = join(scratch, name);
      mkdirSync(root, { recursive: true });
      return root;
    },
  };
}
