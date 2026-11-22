// bun.lock's workspace versions must follow package.json: a release bump that
// skipped the lock left apps/cli a version behind until an unrelated PR picked
// up the hunk (#2247). bun install --frozen-lockfile does not catch it.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeDrift,
  LOCKFILE,
  lockVersionDrift,
  lockWorkspaceVersions,
  stampLockVersion,
} from "./lockfile-versions";

const REPO_ROOT = join(import.meta.dir, "..");

// Shaped like bun's own output: trailing commas, two-space nesting, nested
// objects after the version line.
function lockText(cli: string, utils: string): string {
  return `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
      "devDependencies": {
        "semver": "^7.8.3",
      },
    },
    "apps/cli": {
      "name": "@squirrelscan/cli",
      "version": "${cli}",
      "bin": {
        "squirrelscan": "./build/squirrelscan",
      },
      "dependencies": {
        "@squirrelscan/utils": "workspace:*",
      },
    },
    "docs": {
      "name": "docs",
    },
    "packages/utils": {
      "name": "@squirrelscan/utils",
      "version": "${utils}",
    },
  },
  "packages": {
    "semver": ["semver@7.8.3", "", {}, "sha512-x"],
  },
}
`;
}

async function fixture(
  lock: string,
  versions: Record<string, string | undefined>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lockfile-versions-"));
  await Bun.write(join(root, LOCKFILE), lock);
  for (const [ws, version] of Object.entries(versions)) {
    await Bun.write(
      join(root, ws, "package.json"),
      JSON.stringify({ name: ws, version }) + "\n"
    );
  }
  return root;
}

describe("lockVersionDrift", () => {
  test("an agreeing pair reports no drift", async () => {
    const root = await fixture(lockText("0.0.190", "0.0.1"), {
      "apps/cli": "0.0.190",
      "packages/utils": "0.0.1",
      docs: undefined,
    });
    expect(await lockVersionDrift(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("a disagreeing pair is reported with the package and both versions", async () => {
    const root = await fixture(lockText("0.0.190-beta.1", "0.0.1"), {
      "apps/cli": "0.0.190",
      "packages/utils": "0.0.1",
      docs: undefined,
    });
    const drift = await lockVersionDrift(root);
    expect(drift).toEqual([
      {
        workspace: "apps/cli",
        packageVersion: "0.0.190",
        lockVersion: "0.0.190-beta.1",
      },
    ]);
    expect(drift.map(describeDrift)).toEqual([
      "apps/cli: package.json 0.0.190, bun.lock 0.0.190-beta.1",
    ]);
    await rm(root, { recursive: true, force: true });
  });

  test("a package.json that gains a version the lock lacks is drift", async () => {
    const root = await fixture(lockText("0.0.190", "0.0.1"), {
      "apps/cli": "0.0.190",
      "packages/utils": "0.0.1",
      docs: "1.0.0",
    });
    expect(await lockVersionDrift(root)).toEqual([
      { workspace: "docs", packageVersion: "1.0.0", lockVersion: undefined },
    ]);
    await rm(root, { recursive: true, force: true });
  });

  // The real tree: this is what fails if a release bump skips bun.lock again.
  test("this repo's bun.lock agrees with every workspace package.json", async () => {
    expect((await lockVersionDrift(REPO_ROOT)).map(describeDrift)).toEqual([]);
  });
});

describe("stampLockVersion", () => {
  test("rewrites only the named workspace's version line", () => {
    const before = lockText("0.0.190-beta.1", "0.0.190-beta.1");
    const after = stampLockVersion(before, "apps/cli", "0.0.190");
    expect(lockWorkspaceVersions(after).get("apps/cli")).toBe("0.0.190");
    expect(lockWorkspaceVersions(after).get("packages/utils")).toBe(
      "0.0.190-beta.1"
    );
    const changed = after
      .split("\n")
      .filter((line, i) => line !== before.split("\n")[i]);
    expect(changed).toEqual([`      "version": "0.0.190",`]);
  });

  test("throws for a workspace with no version line instead of writing elsewhere", () => {
    const before = lockText("0.0.190", "0.0.1");
    expect(() => stampLockVersion(before, "docs", "1.0.0")).toThrow("docs");
    expect(() => stampLockVersion(before, "packages/missing", "1.0.0")).toThrow(
      "packages/missing"
    );
  });

  test("a stamped lock reports no drift", async () => {
    const root = await fixture(
      stampLockVersion(lockText("0.0.189", "0.0.1"), "apps/cli", "0.0.190"),
      {
        "apps/cli": "0.0.190",
        "packages/utils": "0.0.1",
        docs: undefined,
      }
    );
    expect(await lockVersionDrift(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
