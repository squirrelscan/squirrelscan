// #2112: catch missing bash case returns that flag-parity tests miss.
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { generateCompletion } from "@/self/completion";

function bashCompletion(): string {
  const result = generateCompletion("bash");
  if (!result.ok) throw new Error("Bash completion generation failed");
  return result.data;
}

function bashArms(script: string): Array<{ name: string; body: string }> {
  const marker = '  case "${COMP_WORDS[1]}" in';
  const begin = script.indexOf(marker);
  const end = script.lastIndexOf("\n  esac");
  if (begin === -1 || end <= begin) throw new Error("Main bash completion case was not found");
  const main = script.slice(begin + marker.length, end);
  const arms = [...main.matchAll(/^    ([a-z][a-z0-9-]*|\*)\)\s*$/gm)];
  if (!arms.length) throw new Error("Main bash completion has no case arms");
  return arms.map((arm, index) => ({
    name: arm[1]!,
    body: main.slice(arm.index!, arms[index + 1]?.index ?? main.length),
  }));
}

function missingReturns(script: string): string[] {
  return bashArms(script)
    .filter(({ body }) => {
      const assignment = body.lastIndexOf("COMPREPLY=");
      if (assignment < 0) return false;
      const ret = body.lastIndexOf("return 0");
      const terminator = body.lastIndexOf(";;");
      return !(ret > assignment && ret < terminator);
    })
    .map(({ name }) => name);
}

function runBashCompletion(prefix: string): string[] {
  const command = [
    bashCompletion(),
    "COMP_WORDS=(squirrel audit " + prefix + ")",
    "COMP_CWORD=2",
    "_squirrel_completions",
    "printf '%s\\n' \"${COMPREPLY[@]}\"",
  ].join("\n");
  const result = spawnSync("bash", ["-c", command], { encoding: "utf8", timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split(/\s+/);
}

describe("bash completion returns (#2112)", () => {
  test("all top-level case arms that set COMPREPLY end with return 0", () => {
    expect(missingReturns(bashCompletion())).toEqual([]);
  });

  test("removing the audit flag-list return fails the guard", () => {
    const original = bashCompletion();
    const audit = bashArms(original).find(({ name }) => name === "audit");
    expect(audit).toBeDefined();
    const lastReturn = audit!.body.lastIndexOf("return 0");
    expect(lastReturn).toBeGreaterThan(-1);
    const brokenArm = audit!.body.slice(0, lastReturn) +
      audit!.body.slice(lastReturn).replace("return 0", ":");
    expect(missingReturns(original.replace(audit!.body, brokenArm))).toContain("audit");
  });

  test("bash actually offers audit flags after --", () => {
    const flags = runBashCompletion("--");
    expect(flags).toContain("--max-pages");
    expect(flags).toContain("--urls-file");
    expect(flags).toContain("--wcag-level");
  });

  test("bash completes the --wc prefix to --wcag-level", () => {
    expect(runBashCompletion("--wc")).toEqual(["--wcag-level"]);
  });
});
