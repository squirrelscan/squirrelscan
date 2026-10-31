// #1408: scripts the crawl never gave tech detection a body for are counted in `truncated`: one it dropped
// for its size (over the fetch cap) and the first-party scripts the audit's script limit left unread.

import { describe, expect, test } from "bun:test";

import {
  buildTechInputs,
  DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
  detectReportTechnologiesMulti,
  LOCAL_TECH_DETECT_OPTIONS,
  techInputTruncation,
} from "../src/technologies";
import { SCRIPT_TOO_LARGE_ERROR } from "../src/script-fetcher";

const HOME = "https://example.com/";
const ABOUT = "https://example.com/about";

function inputs(
  scripts: Array<{ url: string; content?: string | null; error?: string | null; sourcePages?: string[] }>,
  gaps?: { scriptsNotRead?: number },
  limits = DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
) {
  return buildTechInputs(
    [
      { url: HOME, headers: {}, html: "<!doctype html><div id=root></div>" },
      { url: ABOUT, headers: {}, html: "<!doctype html><p>about</p>" },
    ],
    scripts,
    limits,
    gaps,
  );
}

const tooLarge = (url: string, sourcePages?: string[]) => ({ url, content: null, error: SCRIPT_TOO_LARGE_ERROR, sourcePages });

describe("a script the crawl dropped for its size", () => {
  test("is counted as script-too-large", () => {
    const section = techInputTruncation(inputs([tooLarge("https://example.com/big.js")]));
    expect(section).toEqual({ reasons: ["script-too-large"], scripts: 1 });
  });

  test("is counted once however many pages reference it, and each oversize script once", () => {
    const section = techInputTruncation(
      inputs([
        tooLarge("https://example.com/big.js", [HOME, ABOUT]),
        tooLarge("https://example.com/huge.js", [ABOUT]),
      ]),
    );
    expect(section).toEqual({ reasons: ["script-too-large"], scripts: 2 });
  });

  test("a script that has a body, or failed for another reason, is not counted", () => {
    const section = techInputTruncation(
      inputs([
        { url: "https://example.com/ok.js", content: "var a=1;" },
        { url: "https://example.com/gone.js", content: null, error: "HTTP 404" },
        { url: "https://example.com/other.js", content: null, error: "not javascript" },
      ]),
    );
    expect(section).toBeUndefined();
  });

  test("bundle_bytes = 0 turns bundle reading off, so nothing is cut", () => {
    const off = { ...DEFAULT_LOCAL_TECH_BUNDLE_LIMITS, bundleBytes: 0 };
    expect(techInputTruncation(inputs([tooLarge("https://example.com/big.js")], { scriptsNotRead: 4 }, off))).toBeUndefined();
  });
});

describe("scripts the audit's script limit left unread", () => {
  test("script-limit with the count, once, on the home page input", () => {
    const built = inputs([{ url: "https://example.com/a.js", content: "var a=1;" }], { scriptsNotRead: 3 });
    expect(built[0]!.truncation).toEqual({ reasons: ["script-limit"], scripts: 3 });
    expect(built[1]?.truncation).toBeUndefined();
    expect(techInputTruncation(built)).toEqual({ reasons: ["script-limit"], scripts: 3 });
  });

  test("zero or absent adds nothing", () => {
    expect(techInputTruncation(inputs([], { scriptsNotRead: 0 }))).toBeUndefined();
    expect(techInputTruncation(inputs([], {}))).toBeUndefined();
    expect(techInputTruncation(inputs([]))).toBeUndefined();
  });

  test("adds up with a script dropped for its size", () => {
    const section = techInputTruncation(inputs([tooLarge("https://example.com/big.js")], { scriptsNotRead: 2 }));
    expect(section?.scripts).toBe(3);
    expect([...(section?.reasons ?? [])].sort()).toEqual(["script-limit", "script-too-large"]);
  });
});

describe("the report section", () => {
  test("carries the reasons with nothing detected", () => {
    const section = detectReportTechnologiesMulti(
      inputs([tooLarge("https://example.com/big.js")], { scriptsNotRead: 1 }),
      undefined,
      LOCAL_TECH_DETECT_OPTIONS,
    );
    expect(section.items).toEqual([]);
    expect(section.truncated?.scripts).toBe(2);
  });
});
