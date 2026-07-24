// soft404-confirm (#1177) — end-of-crawl confirmation re-fetch over pages the
// crawl flagged as soft-404s. Unit-tests candidacy + verdict over an injected
// fetch stub (no network). The crawl/soft-404 RULE variants are covered in
// packages/rules/tests/soft-404.test.ts.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import {
  confirmSoft404Candidates,
  DEFAULT_MAX_CONFIRMATIONS,
  type ConfirmFetch,
  type Soft404ConfirmPage,
} from "../src/soft404-confirm";

// A Next.js error shell served with HTTP 200 (+ noindex) — a real soft-404.
const SHELL_HTML = `<!doctype html>
<html id="__next_error__">
  <head>
    <meta name="robots" content="noindex" />
    <title>Page Not Found | Example</title>
  </head>
  <body><main><h1>Page Not Found</h1><p>The page does not exist.</p></main></body>
</html>`;

// A real content page (no error-shell signals).
const REAL_HTML = `<!doctype html>
<html>
  <head><title>Privacy Policy | Example</title></head>
  <body><main><h1>Privacy Policy</h1><p>${"This policy explains how we handle your data. ".repeat(40)}</p></main></body>
</html>`;

// A DataDome bot-challenge interstitial served at HTTP 200 (tiny body + strong
// marker) — detectWafChallengePage flags this; it is NOT real content.
const WAF_CHALLENGE_HTML = `<!doctype html>
<html><head><title></title></head>
<body><script src="https://ct.captcha-delivery.com/c.js"></script></body></html>`;

const OPTS = { userAgent: "test-agent" };

function shellPage(path: string): Soft404ConfirmPage {
  const url = `https://example.com${path}`;
  return { url, statusCode: 200, parsed: parsePage(SHELL_HTML, url) };
}

// A soft-404 candidate at an arbitrary absolute URL (for cross-host tests).
function shellPageAt(url: string): Soft404ConfirmPage {
  return { url, statusCode: 200, parsed: parsePage(SHELL_HTML, url) };
}

function realPage(path: string): Soft404ConfirmPage {
  const url = `https://example.com${path}`;
  return { url, statusCode: 200, parsed: parsePage(REAL_HTML, url) };
}

// A fetch stub that serves a fixed body/status regardless of URL.
function fixedFetch(status: number, body: string): ConfirmFetch {
  return async () => ({ status, body });
}

describe("confirmSoft404Candidates", () => {
  test("shell reproduces on re-fetch → confirmed", async () => {
    const pages = [shellPage("/blog/gone")];
    const summary = await confirmSoft404Candidates(pages, OPTS, fixedFetch(200, SHELL_HTML));

    expect(summary).toEqual({
      candidates: 1,
      confirmed: 1,
      intermittent: 0,
      unconfirmed: 0,
      renderedSkipped: 0,
    });
    expect(pages[0]!.parsed.soft404Confirmation).toBe("confirmed");
  });

  test("real content on re-fetch → intermittent (NOT confirmed)", async () => {
    const pages = [shellPage("/privacy")];
    const summary = await confirmSoft404Candidates(pages, OPTS, fixedFetch(200, REAL_HTML));

    expect(summary).toEqual({
      candidates: 1,
      confirmed: 0,
      intermittent: 1,
      unconfirmed: 0,
      renderedSkipped: 0,
    });
    expect(pages[0]!.parsed.soft404Confirmation).toBe("intermittent");
  });

  test("network error (status 0) → unconfirmed, never dropped", async () => {
    const pages = [shellPage("/terms")];
    const errFetch: ConfirmFetch = async () => ({ status: 0, body: "", error: "boom" });
    const summary = await confirmSoft404Candidates(pages, OPTS, errFetch);

    expect(summary.unconfirmed).toBe(1);
    expect(pages[0]!.parsed.soft404Confirmation).toBe("unconfirmed");
  });

  test("WAF/bot-challenge served on re-fetch → unconfirmed, NOT intermittent", async () => {
    const pages = [shellPage("/blog/gone")];
    const summary = await confirmSoft404Candidates(pages, OPTS, fixedFetch(200, WAF_CHALLENGE_HTML));

    // A 200 challenge page is not "real content" — must never read as intermittent.
    expect(summary.intermittent).toBe(0);
    expect(summary.unconfirmed).toBe(1);
    expect(pages[0]!.parsed.soft404Confirmation).toBe("unconfirmed");
  });

  test("the resolved crawl UA reaches the confirmation fetch", async () => {
    const pages = [shellPage("/privacy")];
    const seenUserAgents: string[] = [];
    const capturingFetch: ConfirmFetch = async (_url, userAgent) => {
      seenUserAgents.push(userAgent);
      return { status: 200, body: REAL_HTML };
    };
    await confirmSoft404Candidates(
      pages,
      { userAgent: "SquirrelBot-Resolved/9.9" },
      capturingFetch,
    );

    expect(seenUserAgents).toEqual(["SquirrelBot-Resolved/9.9"]);
  });

  test("non-2xx re-fetch (real 404 now) → unconfirmed (can't re-verify the 2xx claim)", async () => {
    const pages = [shellPage("/gone")];
    const summary = await confirmSoft404Candidates(pages, OPTS, fixedFetch(404, "Not Found"));

    expect(summary.unconfirmed).toBe(1);
    expect(pages[0]!.parsed.soft404Confirmation).toBe("unconfirmed");
  });

  test("a thrown fetch degrades to unconfirmed, not a crash", async () => {
    const pages = [shellPage("/boom")];
    const throwing: ConfirmFetch = async () => {
      throw new Error("network down");
    };
    const summary = await confirmSoft404Candidates(pages, OPTS, throwing);

    expect(summary.unconfirmed).toBe(1);
    expect(pages[0]!.parsed.soft404Confirmation).toBe("unconfirmed");
  });

  test("rendered candidate is NOT fetched → unconfirmed-rendered annotation", async () => {
    const url = "https://example.com/spa";
    const rendered: Soft404ConfirmPage = {
      url,
      statusCode: 200,
      parsed: parsePage(SHELL_HTML, url),
      rendered: true,
    };
    let fetched = false;
    const spyFetch: ConfirmFetch = async () => {
      fetched = true;
      return { status: 200, body: SHELL_HTML };
    };
    const summary = await confirmSoft404Candidates([rendered], OPTS, spyFetch);

    expect(fetched).toBe(false);
    expect(summary.renderedSkipped).toBe(1);
    expect(rendered.parsed.soft404Confirmation).toBe("unconfirmed-rendered");
  });

  test("rendered flag on a non-candidate does not annotate it", async () => {
    const url = "https://example.com/about";
    const page: Soft404ConfirmPage = {
      url,
      statusCode: 200,
      parsed: parsePage(REAL_HTML, url),
      rendered: true,
    };
    const summary = await confirmSoft404Candidates([page], OPTS, fixedFetch(200, SHELL_HTML));

    expect(summary.candidates).toBe(0);
    expect(summary.renderedSkipped).toBe(0);
    expect(page.parsed.soft404Confirmation).toBeUndefined();
  });

  test("non-candidate pages are never fetched or annotated", async () => {
    const pages = [realPage("/about")];
    let fetched = false;
    const spyFetch: ConfirmFetch = async () => {
      fetched = true;
      return { status: 200, body: SHELL_HTML };
    };
    const summary = await confirmSoft404Candidates(pages, OPTS, spyFetch);

    expect(fetched).toBe(false);
    expect(summary.candidates).toBe(0);
    expect(pages[0]!.parsed.soft404Confirmation).toBeUndefined();
  });

  test("candidates beyond the budget degrade to unconfirmed (bounded fetches)", async () => {
    const pages = [shellPage("/a"), shellPage("/b"), shellPage("/c")];
    let fetches = 0;
    const countingFetch: ConfirmFetch = async () => {
      fetches++;
      return { status: 200, body: SHELL_HTML };
    };
    const summary = await confirmSoft404Candidates(
      pages,
      { ...OPTS, maxConfirmations: 2 },
      countingFetch,
    );

    expect(fetches).toBe(2);
    expect(summary).toEqual({
      candidates: 3,
      confirmed: 2,
      intermittent: 0,
      unconfirmed: 1,
      renderedSkipped: 0,
    });
    // The two fetched reproduce; the third (over budget) is unconfirmed.
    const verdicts = pages.map((p) => p.parsed.soft404Confirmation);
    expect(verdicts.filter((v) => v === "confirmed")).toHaveLength(2);
    expect(verdicts.filter((v) => v === "unconfirmed")).toHaveLength(1);
  });

  test("default budget is a sane bound", () => {
    expect(DEFAULT_MAX_CONFIRMATIONS).toBeGreaterThan(0);
  });
});

describe("confirmSoft404Candidates — config toggle", () => {
  test("enabled:false does NO network; candidates annotated unconfirmed (not dropped)", async () => {
    const pages = [shellPage("/a"), shellPage("/b")];
    let fetched = false;
    const spyFetch: ConfirmFetch = async () => {
      fetched = true;
      return { status: 200, body: SHELL_HTML };
    };
    const summary = await confirmSoft404Candidates(pages, { ...OPTS, enabled: false }, spyFetch);

    expect(fetched).toBe(false);
    expect(summary).toEqual({
      candidates: 2,
      confirmed: 0,
      intermittent: 0,
      unconfirmed: 2,
      renderedSkipped: 0,
    });
    expect(pages.map((p) => p.parsed.soft404Confirmation)).toEqual(["unconfirmed", "unconfirmed"]);
  });

  test("enabled:true (default) re-fetches and confirms", async () => {
    const pages = [shellPage("/a")];
    const summary = await confirmSoft404Candidates(
      pages,
      { ...OPTS, enabled: true },
      fixedFetch(200, SHELL_HTML),
    );
    expect(summary.confirmed).toBe(1);
    expect(pages[0]!.parsed.soft404Confirmation).toBe("confirmed");
  });
});

describe("confirmSoft404Candidates — politeness", () => {
  test("same-host confirms are sequential and honor perHostDelayMs", async () => {
    const pages = [shellPage("/a"), shellPage("/b"), shellPage("/c")];
    const order: string[] = [];
    const slept: number[] = [];
    const seqFetch: ConfirmFetch = async (url) => {
      order.push(`fetch:${new URL(url).pathname}`);
      return { status: 200, body: SHELL_HTML };
    };
    await confirmSoft404Candidates(
      pages,
      { ...OPTS, perHostDelayMs: 500, sleep: async (ms) => void slept.push(ms) },
      seqFetch,
    );

    // 3 same-host candidates → 2 inter-request delays, all 500ms.
    expect(slept).toEqual([500, 500]);
    // Sequential ordering preserved (same host never overlaps).
    expect(order).toEqual(["fetch:/a", "fetch:/b", "fetch:/c"]);
  });

  test("wall-budget exhaustion → remaining candidates unconfirmed, no further fetch", async () => {
    const pages = [shellPage("/a"), shellPage("/b"), shellPage("/c")];
    let fetches = 0;
    const countingFetch: ConfirmFetch = async () => {
      fetches++;
      return { status: 200, body: SHELL_HTML };
    };
    // Clock reads in order: start=0, first check=0 (under budget → fetch), then
    // 5000 (over the 1000ms budget → remaining skipped).
    const times = [0, 0, 5000, 5000];
    let idx = 0;
    const now = () => times[Math.min(idx++, times.length - 1)]!;
    const summary = await confirmSoft404Candidates(
      pages,
      { ...OPTS, wallBudgetMs: 1000, now },
      countingFetch,
    );

    // Only the first candidate is fetched; the rest are over-budget → unconfirmed.
    expect(fetches).toBe(1);
    expect(summary.unconfirmed).toBe(2);
    expect(summary.confirmed).toBe(1);
  });

  test("cross-host candidates run in parallel (per-host delay does not serialize them)", async () => {
    const pages = [shellPage("/a"), shellPageAt("https://other.test/b")];
    const slept: number[] = [];
    await confirmSoft404Candidates(
      pages,
      { ...OPTS, perHostDelayMs: 500, sleep: async (ms) => void slept.push(ms) },
      fixedFetch(200, SHELL_HTML),
    );
    // Two different hosts, one candidate each → no intra-host delay incurred.
    expect(slept).toEqual([]);
  });
});
