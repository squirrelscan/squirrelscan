// release.yml must refuse to run from any ref but main (#1822): installs verify each
// binary's attestation against release.yml@refs/heads/main (#169), so a release
// dispatched from a branch or tag would publish binaries every install rejects.
// These tests run the guard step's own script, so they fail if the check is
// loosened, and they pin the guard as the first step of the job every other job
// waits on, so nothing builds before it.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; uses?: string; run?: string };
type Job = { needs?: string | string[]; steps?: Step[] };

const root = join(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const roots = Object.entries(workflow.jobs).filter(([, job]) => job.needs === undefined);

function guardScript(): string {
  const [, job] = roots[0]!;
  const first = job.steps?.[0];
  if (!first?.run) throw new Error("the first job's first step has no run script");
  return first.run;
}

function runGuard(ref: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bash", "-c", guardScript()], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_REF: ref },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

test("exactly one job starts the release, and every other job waits on it", () => {
  expect(roots.map(([name]) => name)).toEqual(["version"]);
});

test("the guard is the first step of that job, before checkout", () => {
  const [, job] = roots[0]!;
  expect(job.steps?.[0]?.uses).toBeUndefined();
  expect(job.steps?.[0]?.name).toBe("Refuse to release from a ref other than main");
});

test("the guard passes on refs/heads/main", () => {
  expect(runGuard("refs/heads/main").code).toBe(0);
});

test.each([
  "refs/heads/feature",
  "refs/heads/main-backport",
  "refs/heads/release/main",
  "refs/tags/v0.0.190",
  "refs/pull/1/merge",
  "",
])("the guard fails on %p", (ref) => {
  const { code, out } = runGuard(ref);
  expect(code).not.toBe(0);
  expect(out).toContain("::error::release.yml must be dispatched from main");
});
