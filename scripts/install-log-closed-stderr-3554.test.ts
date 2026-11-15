// log, info and warn must not abort the installer under `set -e` when stderr is closed (#3554).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../install.sh", import.meta.url).pathname, "utf8");
const lines = text.split("\n");
const defs = lines.filter((l) => /^(log|warn|info)\(\) \{/.test(l)).join("\n");

function run(script: string) {
  const p = Bun.spawnSync(["bash", "-c", script]);
  return { code: p.exitCode, out: p.stdout.toString() };
}

describe("installer log helpers with stderr closed (repo#3554)", () => {
  test("defines log, warn and info", () => {
    expect(defs.split("\n")).toHaveLength(3);
  });

  for (const fn of ["log", "warn", "info"]) {
    test(`${fn} does not abort under set -e`, () => {
      const r = run(`set -euo pipefail\nGREEN= YELLOW= BLUE= NC=\n${defs}\n${fn} hello 2>&-\necho survived`);
      expect(r.out.trim()).toBe("survived");
      expect(r.code).toBe(0);
    });
  }

  test("the step advances before the platform log line", () => {
    const step = text.indexOf('CURRENT_STEP="find_bin_dir"');
    const logLine = text.indexOf('log "Detected platform');
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(logLine);
  });
});
