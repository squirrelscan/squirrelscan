// security/leaked-secrets: a secret that sits in the URL a finding names is masked there too (#2270), so the report
// does not print in plain text the secret it warns about. Values are built from parts: no secret-shaped literal is
// committed.

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../../src/types";

import { buildCollectedPageSignal } from "../../src/collected-signals";
import {
  leakedSecretsRule,
  redactSecretsInUrl,
} from "../../src/security/leaked-secrets";

const BASE = "https://shop.example.test";
// A Stripe live key in a query string, a GitLab token in a path segment, and a third secret inside the script body.
const QUERY_KEY = `${["sk", "live"].join("_")}_${"aB3dE5gH7jK9mN1pQ3rS5tU7"}`;
const PATH_TOKEN = `${"glpat"}-${"aB3dE5gH7jK9mN1pQ3rS"}`;
const BODY_KEY = `${["sk", "live"].join("_")}_${"Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2"}`;

const signal = (url: string, html: string) =>
  buildCollectedPageSignal({
    url,
    parsed: parsePage(html, url),
    rendered: false,
  });

async function run(
  pageUrl: string,
  scripts: { url: string; content: string | null; status?: number }[]
) {
  const ctx = {
    site: {
      baseUrl: BASE,
      pages: [],
      scripts: scripts.map((s) => ({
        url: s.url,
        content: s.content,
        sourcePages: [pageUrl],
        status: s.status ?? 200,
        error: s.content === null ? "HTTP 500" : null,
        contentType: "application/javascript",
        sizeBytes: s.content?.length ?? 0,
      })),
    },
    collectedSignals: {
      pages: [
        signal(
          pageUrl,
          `<html><body>${scripts.map((s) => `<script src="${s.url}"></script>`).join("")}</body></html>`
        ),
      ],
    },
    options: {},
  } as unknown as RuleContext;
  return (await leakedSecretsRule.run(ctx)).checks;
}

describe("leaked-secrets redacts secrets in the URLs it names (#2270)", () => {
  test("a script URL with a detected key in its query string is shown masked", async () => {
    const script = `${BASE}/config.js?key=${QUERY_KEY}&v=2`;
    const checks = await run(`${BASE}/`, [
      { url: script, content: `window.cfg={key:"${BODY_KEY}"};` },
    ]);
    const text = JSON.stringify(checks);
    expect(text).not.toContain(QUERY_KEY);
    expect(text).not.toContain(BODY_KEY);
    const crit = checks.find((c) => c.name === "leaked-secrets-critical")!;
    expect(crit.items).toHaveLength(1);
    expect(crit.items![0]!.label).toBe(
      `Found in external-script (${BASE}/config.js?key=sk_liv…5tU7&v=2)`
    );
  });

  test("a URL with a detected token in a path segment is shown masked, in the label and the occurrences", async () => {
    const script = `${BASE}/api/${PATH_TOKEN}/data.js`;
    const page = `${BASE}/account/${PATH_TOKEN}`;
    const checks = await run(page, [
      { url: script, content: `window.cfg={key:"${BODY_KEY}"};` },
    ]);
    const text = JSON.stringify(checks);
    expect(text).not.toContain(PATH_TOKEN);
    const item = checks.find((c) => c.name === "leaked-secrets-critical")!
      .items![0]!;
    expect(item.label).toBe(
      `Found in external-script (${BASE}/api/glpat-…Q3rS/data.js)`
    );
    expect(item.sourcePages).toEqual([`${BASE}/account/glpat-…Q3rS`]);
  });

  test("a script that could not be read is listed with the secret in its URL masked", async () => {
    const checks = await run(`${BASE}/`, [
      { url: `${BASE}/boot.js?key=${QUERY_KEY}`, content: null, status: 500 },
    ]);
    expect(JSON.stringify(checks)).not.toContain(QUERY_KEY);
    const unfetched = checks.find((c) => c.name === "leaked-secrets-unfetched");
    expect(unfetched?.items?.[0]?.id).toBe(`${BASE}/boot.js?key=sk_liv…5tU7`);
  });

  test("a URL with no secret in it is shown unchanged", async () => {
    const script = `${BASE}/static/js/main.4f3a2b1c.js?v=1.2.3&utm_source=newsletter&utm_campaign=spring_sale_2026`;
    const page = `${BASE}/products/crunchy-peanut-butter?variant=41234567890123`;
    const checks = await run(page, [
      { url: script, content: `window.cfg={key:"${BODY_KEY}"};` },
    ]);
    const item = checks.find((c) => c.name === "leaked-secrets-critical")!
      .items![0]!;
    expect(item.label).toBe(`Found in external-script (${script})`);
    expect(item.sourcePages).toEqual([page]);
    for (const url of [
      script,
      page,
      `${BASE}/a%20b/c.js#section-2`,
      `${BASE}/search?q=hello+world&page=3`,
    ])
      expect(redactSecretsInUrl(url)).toBe(url);
  });

  test("a percent-encoded secret and a generic key in a query or fragment are masked", () => {
    const generic = "Zq8vN3xLp2Rt7Wk9Yb4Hc6Md";
    expect(
      redactSecretsInUrl(`${BASE}/x.js?k=${encodeURIComponent(QUERY_KEY)}`)
    ).toBe(`${BASE}/x.js?k=sk_liv…5tU7`);
    expect(redactSecretsInUrl(`${BASE}/x.js?api_key=${generic}`)).toBe(
      `${BASE}/x.js?api_key=Zq8vN3…c6Md`
    );
    expect(
      redactSecretsInUrl(`${BASE}/cb#access_token=${generic}&token_type=bearer`)
    ).toBe(`${BASE}/cb#access_token=Zq8vN3…c6Md&token_type=bearer`);
  });
});

describe("the password of a login in a URL (#2270)", () => {
  test("is masked where it sits, and nowhere else in the URL", () => {
    expect(redactSecretsInUrl("https://admin:ab@ab.example.test/ab.js")).toBe(
      "https://admin:a…@ab.example.test/ab.js"
    );
    expect(
      redactSecretsInUrl(
        "https://deploy:Tr0ub4dorPassw0rd@cdn.example.test/x.js"
      )
    ).toBe("https://deploy:Tr0ub4…w0rd@cdn.example.test/x.js");
  });
});
