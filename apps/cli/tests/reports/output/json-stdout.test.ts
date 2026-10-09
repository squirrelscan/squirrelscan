// `-f json -o <file>` keeps stdout for data: the saved-path status line goes to
// stderr (repo#2216).

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateJsonReport } from "@/reports/output/json";

import { createMinimalReport } from "../fixtures";

describe("generateJsonReport stdout with an output file", () => {
  let outputPath: string;

  beforeEach(() => {
    outputPath = join(tmpdir(), `test-stdout-${Date.now()}.json`);
  });

  afterEach(() => {
    if (existsSync(outputPath)) unlinkSync(outputPath);
  });

  test("the saved-path message is on stderr, not stdout", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      generateJsonReport(createMinimalReport(), outputPath);

      const stdoutLines = log.mock.calls.map((args) => args.join(" "));
      expect(
        stdoutLines.some((line) => line.includes("JSON report saved to"))
      ).toBe(false);

      const stderrLines = error.mock.calls.map((args) => args.join(" "));
      expect(
        stderrLines.some((line) =>
          line.includes(`JSON report saved to: ${outputPath}`)
        )
      ).toBe(true);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
