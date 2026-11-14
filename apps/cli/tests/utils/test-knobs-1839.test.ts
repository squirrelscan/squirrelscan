// #1839: the test-only timing knobs are read only under `bun test` (NODE_ENV "test")
// and only as a finite positive integer; anywhere else they are inert.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TEST_MIN_MARGIN_MS_ENV,
  TEST_REACHABILITY_TIMEOUT_MS_ENV,
  testOnlyMs,
} from "@/utils/test-knobs";

describe("testOnlyMs", () => {
  test("bun test sets NODE_ENV to test (the knobs rely on it)", () => {
    expect(process.env.NODE_ENV).toBe("test");
  });

  for (const name of [
    TEST_MIN_MARGIN_MS_ENV,
    TEST_REACHABILITY_TIMEOUT_MS_ENV,
  ]) {
    test(`${name} is honoured when NODE_ENV is test`, () => {
      expect(testOnlyMs(name, { NODE_ENV: "test", [name]: "1500" })).toBe(1500);
    });

    test.each([undefined, "", "production", "development", "TEST", " test"])(
      `${name} is ignored when NODE_ENV is %p`,
      (nodeEnv) => {
        expect(testOnlyMs(name, { NODE_ENV: nodeEnv, [name]: "1500" })).toBe(
          undefined
        );
      }
    );
  }

  test.each([
    "",
    "0",
    "-5",
    "+5",
    "1.5",
    "1e3",
    "0x10",
    " 100",
    "100 ",
    "abc",
    "Infinity",
    "NaN",
    "012",
    "99999999999999999999",
  ])("%p is not a finite positive integer and is ignored", (value) => {
    expect(
      testOnlyMs(TEST_MIN_MARGIN_MS_ENV, {
        NODE_ENV: "test",
        [TEST_MIN_MARGIN_MS_ENV]: value,
      })
    ).toBe(undefined);
  });

  test("unset is ignored", () => {
    expect(testOnlyMs(TEST_MIN_MARGIN_MS_ENV, { NODE_ENV: "test" })).toBe(
      undefined
    );
  });
});

// The shipped binary: `bun build --compile` (the release flags, Makefile) inlines
// process.env.NODE_ENV as the build environment's value ("development" when unset, as in a
// release build), so NODE_ENV=test at runtime must not turn a knob on there.
describe("in a compiled binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "squirrel-test-knobs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the knobs are inert even with NODE_ENV=test", async () => {
    const entry = join(dir, "entry.ts");
    const knobs = join(import.meta.dir, "../../src/utils/test-knobs.ts");
    writeFileSync(
      entry,
      `import { TEST_MIN_MARGIN_MS_ENV, TEST_REACHABILITY_TIMEOUT_MS_ENV, testOnlyMs } from ${JSON.stringify(knobs)};\n` +
        `console.log(JSON.stringify([testOnlyMs(TEST_MIN_MARGIN_MS_ENV) ?? null, testOnlyMs(TEST_REACHABILITY_TIMEOUT_MS_ENV) ?? null]));\n`
    );
    const outfile = join(dir, "knobs-bin");
    const buildEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== "NODE_ENV") buildEnv[k] = v;
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        entry,
        "--compile",
        "--splitting",
        "--minify",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--outfile",
        outfile,
      ],
      // Built as a release is: not under `bun test`, so without NODE_ENV=test.
      { env: buildEnv, stdout: "pipe", stderr: "pipe" }
    );
    expect(build.exitCode).toBe(0);
    const run = Bun.spawnSync([outfile], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        [TEST_MIN_MARGIN_MS_ENV]: "2000",
        [TEST_REACHABILITY_TIMEOUT_MS_ENV]: "1500",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString().trim())).toEqual([null, null]);
  }, 60_000);

  test("from source under bun test the same knob is honoured (the control)", () => {
    expect(
      testOnlyMs(TEST_MIN_MARGIN_MS_ENV, {
        ...process.env,
        [TEST_MIN_MARGIN_MS_ENV]: "2000",
      })
    ).toBe(2000);
  });
});
