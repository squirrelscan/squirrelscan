// What cloud rendering did on an audit (#1664): the report's `render` block and the console line.

import { describe, expect, test } from "bun:test";

import {
  buildReportRender,
  createRenderTally,
  isRenderedFetcher,
  renderFallbackLine,
  renderModeOf,
} from "../../src/audit/render-summary";

describe("renderModeOf", () => {
  const table: Array<[string | undefined, string]> = [
    [undefined, "http"],
    ["fetch", "http"],
    ["custom", "http"],
    ["hybrid-http-first", "auto"],
    ["cloud-render", "all"],
    ["browser", "all"],
  ];
  for (const [id, mode] of table) {
    test(`${id ?? "no fetcher"} is ${mode}`, () => {
      expect(renderModeOf(id)).toBe(mode as never);
    });
  }
});

describe("the page tally", () => {
  test("a browser render and the container's browser are rendered; everything else is plain", () => {
    expect(isRenderedFetcher("cloud-render")).toBe(true);
    expect(isRenderedFetcher("browser")).toBe(true);
    expect(isRenderedFetcher("fetch")).toBe(false);
    expect(isRenderedFetcher(undefined)).toBe(false);
  });

  test("counts each page once by the fetcher it reported", () => {
    const tally = createRenderTally();
    for (const id of [
      "cloud-render",
      "cloud-render",
      "fetch",
      undefined,
      "browser",
    ])
      tally.note(id);
    expect(tally.counts()).toEqual({ rendered: 3, plain: 2 });
  });

  test("starts at zero", () => {
    expect(createRenderTally().counts()).toEqual({ rendered: 0, plain: 0 });
  });
});

describe("buildReportRender", () => {
  const base = {
    requested: true,
    fetcherId: "cloud-render",
    rendered: 40,
    plain: 0,
  };

  test("rendering ran to the end: mode, counts, no reason", () => {
    expect(buildReportRender(base)).toEqual({
      requested: true,
      mode: "all",
      pagesRendered: 40,
      pagesFetchedPlain: 0,
    });
  });

  test("a fallback carries its reason and the split", () => {
    expect(
      buildReportRender({
        ...base,
        rendered: 12,
        plain: 28,
        fallbackReason: "out of credits",
      })
    ).toEqual({
      requested: true,
      mode: "all",
      fallbackReason: "out of credits",
      pagesRendered: 12,
      pagesFetchedPlain: 28,
    });
  });

  test("render asked for but the cloud was unavailable: mode http with the reason", () => {
    expect(
      buildReportRender({
        requested: true,
        fetcherId: undefined,
        rendered: 0,
        plain: 9,
        fallbackReason: "not logged in",
      })
    ).toEqual({
      requested: true,
      mode: "http",
      fallbackReason: "not logged in",
      pagesRendered: 0,
      pagesFetchedPlain: 9,
    });
  });

  test("render not asked for: plain HTTP and no reason, even if one was passed", () => {
    expect(
      buildReportRender({
        requested: false,
        fetcherId: undefined,
        rendered: 0,
        plain: 5,
        fallbackReason: "x",
      })
    ).toEqual({
      requested: false,
      mode: "http",
      pagesRendered: 0,
      pagesFetchedPlain: 5,
    });
  });

  test("the quick level's HTTP-first mode is `auto`", () => {
    expect(
      buildReportRender({
        ...base,
        fetcherId: "hybrid-http-first",
        rendered: 2,
        plain: 23,
      }).mode
    ).toBe("auto");
  });

  test("counts are whole and non-negative; a blank reason is none; a long one is cut", () => {
    const r = buildReportRender({
      ...base,
      rendered: -3,
      plain: 7.9,
      fallbackReason: "   ",
    });
    expect(r.pagesRendered).toBe(0);
    expect(r.pagesFetchedPlain).toBe(7);
    expect("fallbackReason" in r).toBe(false);
    expect(
      buildReportRender({ ...base, fallbackReason: "x".repeat(500) })
        .fallbackReason
    ).toHaveLength(200);
  });
});

describe("renderFallbackLine", () => {
  test("says the reason and how the pages split", () => {
    expect(
      renderFallbackLine({
        requested: true,
        mode: "all",
        fallbackReason: "out of credits",
        pagesRendered: 12,
        pagesFetchedPlain: 28,
      })
    ).toBe(
      "Cloud rendering fell back to plain HTTP (out of credits): 12 of 40 pages were rendered, the rest fetched as plain HTML."
    );
  });

  test("a fallback before any page was fetched says so", () => {
    expect(
      renderFallbackLine({
        requested: true,
        mode: "http",
        fallbackReason: "not logged in",
        pagesRendered: 0,
        pagesFetchedPlain: 0,
      })
    ).toContain("no pages were fetched");
  });

  test("no fallback, no line (and no report, no line)", () => {
    expect(
      renderFallbackLine({
        requested: true,
        mode: "all",
        pagesRendered: 3,
        pagesFetchedPlain: 0,
      })
    ).toBeNull();
    expect(renderFallbackLine(undefined)).toBeNull();
  });
});
