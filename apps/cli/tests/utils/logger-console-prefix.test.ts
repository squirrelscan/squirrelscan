// Console log lines must use a short, run-relative stamp — not the raw ISO dump
// the file log keeps (#190). Color is stripped so the assertions hold whether or
// not the test runs under a TTY.

import { afterEach, describe, expect, test } from "bun:test";

import {
  configureLogger,
  logger,
  setLogInterceptor,
} from "../../src/utils/logger";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(ANSI, "");
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function capture(fn: () => void): string {
  const lines: string[] = [];
  setLogInterceptor((m) => lines.push(m));
  fn();
  return strip(lines[0] ?? "");
}

afterEach(() => setLogInterceptor(undefined));

describe("console log prefix (#190)", () => {
  test("info uses a run-relative stamp, not an ISO timestamp", () => {
    const line = capture(() => logger.info("hello world"));
    expect(line).toMatch(/^\[\+\d/); // e.g. "[+0.0s] ..."
    expect(line).not.toMatch(ISO);
    expect(line).toContain("hello world");
  });

  test("warn carries a level tag + message, no ISO", () => {
    const line = capture(() => logger.warn("careful now"));
    expect(line).toMatch(/^\[\+/);
    expect(line).toContain("warn");
    expect(line).toContain("careful now");
    expect(line).not.toMatch(ISO);
  });

  test("error carries a level tag + message, no ISO", () => {
    const line = capture(() => logger.error("it broke"));
    expect(line).toContain("error");
    expect(line).toContain("it broke");
    expect(line).not.toMatch(ISO);
  });

  test("debug (with --debug) uses the stamp + tag, no ISO", () => {
    configureLogger({ debug: true });
    try {
      const line = capture(() => logger.debug("trace this"));
      expect(line).toMatch(/^\[\+/);
      expect(line).toContain("debug");
      expect(line).toContain("trace this");
      expect(line).not.toMatch(ISO);
    } finally {
      configureLogger({ debug: false });
    }
  });
});
