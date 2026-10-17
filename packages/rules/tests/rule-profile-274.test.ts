// pub#274: the runner built the per-rule profile line (three filters over the
// checks and a nine-key payload) on every rule invocation, and the logger threw
// it away unless SQUIRREL_RULE_PROFILE was set. It is built only when profiling
// now, and profiling still prints the same line for page and site rules.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

async function run(
  profile: boolean,
): Promise<{ stdout: string; profiles: Record<string, unknown>[] }> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SQUIRREL_RULE_PROFILE;
  if (profile) env.SQUIRREL_RULE_PROFILE = "1";
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/rule-profile-child.ts")],
    {
      stdout: "pipe",
      stderr: "pipe",
      env,
    },
  );
  const killer = setTimeout(() => child.kill(), 15_000);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  clearTimeout(killer);
  const profiles = stderr
    .split("\n")
    .filter((line) => line.startsWith("[rule-profile] "))
    .map((line) => JSON.parse(line.slice("[rule-profile] ".length)) as Record<string, unknown>);
  return { stdout, profiles };
}

const FIELDS = ["checks", "durationMs", "durationUs", "failed", "passed", "ruleId", "warned"];

describe("per-rule profile lines (pub#274)", () => {
  test("SQUIRREL_RULE_PROFILE=1 prints one line per rule, page and site, with the same fields", async () => {
    const { stdout, profiles } = await run(true);
    // The payload's three filters ran over the probe rule's checks.
    expect(stdout).toBe("filters=3\n");
    const page = profiles.find((p) => p.ruleId === "core/meta-title");
    const site = profiles.find((p) => p.ruleId === "core/title-unique");
    expect(Object.keys(page ?? {}).sort()).toEqual([...FIELDS, "pageUrl"].sort());
    expect(page?.pageUrl).toBe("https://example.com/");
    expect(Object.keys(site ?? {}).sort()).toEqual([...FIELDS, "scope"].sort());
    expect(site?.scope).toBe("site");
    expect(typeof page?.durationUs).toBe("number");
  }, 30_000);

  test("without it, the payload is not built and no line is printed", async () => {
    const { stdout, profiles } = await run(false);
    // Before the fix the three filters ran here too, for a line nobody printed.
    expect(stdout).toBe("filters=0\n");
    expect(profiles).toEqual([]);
  }, 30_000);
});
