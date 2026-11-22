// #2087: security/csp says whether an enforced policy would contain a hijacked
// third-party script: connect-src, 'strict-dynamic', 'unsafe-eval' and reporting.
// Every new check speaks only for a page that loads a third-party <script src>.

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CollectedSiteSignals } from "../src/collected-signals";
import type { CheckResult, RuleContext } from "../src/types";

import { cspRule } from "../src/security/csp";

const URL_ = "https://www.example.com/";
const VENDOR = `<script src="https://cdn.vendor-example.com/p.js"></script>`;
const FIRST_PARTY = `<script src="/app.js"></script><script src="https://static.example.com/lib.js"></script>`;

const NEW_CHECKS = [
  "csp-connect-unrestricted",
  "csp-strict-dynamic-third-party",
  "csp-no-reporting",
];

/** A tight policy apart from the knob under test: connects limited, reports collected. */
const TIGHT =
  "default-src 'self'; script-src 'self' https://cdn.vendor-example.com; connect-src 'self' https://api.example.com; object-src 'none'; frame-ancestors 'none'; report-uri /csp";

function run(
  policy: string,
  body: string,
  opts: { header?: string; collected?: string[]; url?: string } = {}
): CheckResult[] {
  const url = opts.url ?? URL_;
  const html = `<!doctype html><html><head><title>t</title>${body}</head><body></body></html>`;
  const collectedSignals = opts.collected
    ? ({
        pages: [{ url, scriptSrcs: opts.collected }],
      } as unknown as CollectedSiteSignals)
    : undefined;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    site: {
      baseUrl: url,
      pages: [
        {
          url,
          statusCode: 200,
          headers: { [opts.header ?? "content-security-policy"]: policy },
          // The streaming path has no live document; the collected signal stands in.
          parsed: opts.collected ? { document: null } : parsePage(html, url),
        },
      ],
    },
    ...(collectedSignals ? { collectedSignals } : {}),
    options: {},
  } as unknown as RuleContext;
  const result = cspRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks;
}

const names = (checks: CheckResult[]) => checks.map((c) => c.name);
const find = (checks: CheckResult[], name: string) =>
  checks.find((c) => c.name === name);

describe("csp-connect-unrestricted (#2087)", () => {
  test("no connect-src and no default-src: script can send data anywhere", () => {
    const check = find(
      run(
        "script-src 'self' https://cdn.vendor-example.com; report-uri /r",
        VENDOR
      ),
      "csp-connect-unrestricted"
    );
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe("Script on the page can send data to any host");
    expect(check?.details?.thirdPartyHosts).toEqual(["cdn.vendor-example.com"]);
    expect(check?.details?.directive).toBeUndefined();
  });

  test.each([
    [
      "connect-src *",
      "default-src 'self'; connect-src *; report-uri /r",
      "connect-src",
    ],
    [
      "connect-src https:",
      "default-src 'self'; connect-src 'self' https:; report-uri /r",
      "connect-src",
    ],
    [
      "connect-src wss:",
      "default-src 'self'; connect-src 'self' WSS:; report-uri /r",
      "connect-src",
    ],
    [
      "connect-src https://*",
      "default-src 'self'; connect-src https://*; report-uri /r",
      "connect-src",
    ],
    [
      "inherited default-src *",
      "default-src *; script-src 'self'; report-uri /r",
      "default-src",
    ],
    [
      "inherited default-src https:",
      "default-src https:; report-uri /r",
      "default-src",
    ],
  ])("%s fires and names the directive", (_n, policy, directive) => {
    const check = find(run(policy, VENDOR), "csp-connect-unrestricted");
    expect(check?.status).toBe("warn");
    expect(check?.details?.directive).toBe(directive);
  });

  test.each([
    ["connect-src host list", TIGHT],
    ["default-src 'self' inherited", "default-src 'self'; report-uri /r"],
    ["connect-src 'none'", "default-src *; connect-src 'none'; report-uri /r"],
    ["empty connect-src", "default-src *; connect-src; report-uri /r"],
    [
      "subdomain wildcard host",
      "default-src 'self'; connect-src https://*.example.com; report-uri /r",
    ],
    [
      "data: and blob: are not network hosts",
      "default-src 'self'; connect-src 'self' data: blob:; report-uri /r",
    ],
    // Two enforced policies intersect: the second one restricts connections.
    [
      "second comma-joined policy restricts",
      "default-src *; report-uri /r, connect-src 'self'",
    ],
  ])("%s does not fire", (_n, policy) => {
    expect(names(run(policy, VENDOR))).not.toContain(
      "csp-connect-unrestricted"
    );
  });
});

describe("csp-strict-dynamic-third-party (#2087)", () => {
  const SD =
    "script-src 'nonce-r4nd0m' 'strict-dynamic' https: 'unsafe-inline'; connect-src 'self'; report-uri /r";

  test("'strict-dynamic' with a third-party script is info", () => {
    const check = find(run(SD, VENDOR), "csp-strict-dynamic-third-party");
    expect(check?.status).toBe("info");
    expect(check?.value).toContain("cdn.vendor-example.com");
  });

  test("read from script-src-elem when set", () => {
    expect(
      names(
        run(
          "script-src 'self'; script-src-elem 'nonce-a' 'strict-dynamic'; connect-src 'self'; report-uri /r",
          VENDOR
        )
      )
    ).toContain("csp-strict-dynamic-third-party");
  });

  test("no 'strict-dynamic' does not fire", () => {
    expect(names(run(TIGHT, VENDOR))).not.toContain(
      "csp-strict-dynamic-third-party"
    );
  });

  test("a second policy with a host list still constrains inserted scripts", () => {
    expect(
      names(
        run(`${SD}, script-src 'self' https://cdn.vendor-example.com`, VENDOR)
      )
    ).not.toContain("csp-strict-dynamic-third-party");
  });
});

describe("csp-no-reporting (#2087)", () => {
  test("enforced policy without report-to or report-uri is info", () => {
    const check = find(
      run(
        "default-src 'self'; script-src 'self' https://cdn.vendor-example.com",
        VENDOR
      ),
      "csp-no-reporting"
    );
    expect(check?.status).toBe("info");
    expect(check?.message).toBe("CSP violations are not being collected");
  });

  test.each([
    ["report-uri", "default-src 'self'; report-uri https://r.example.com/csp"],
    ["report-to", "default-src 'self'; report-to csp-endpoint"],
    ["Report-To in mixed case", "default-src 'self'; Report-To csp"],
  ])("%s does not fire", (_n, policy) => {
    expect(names(run(policy, VENDOR))).not.toContain("csp-no-reporting");
  });
});

describe("csp-unsafe-scripts 'unsafe-eval' context (#2087)", () => {
  const EVAL =
    "default-src 'self'; script-src 'self' 'unsafe-eval' https://cdn.vendor-example.com; report-uri /r";

  test("with a third-party script the finding names the vendor", () => {
    const check = find(run(EVAL, VENDOR), "csp-unsafe-scripts");
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe("CSP allows 'unsafe-eval'");
    expect(check?.value).toContain("compromised third-party script");
    expect(check?.value).toContain("cdn.vendor-example.com");
    expect(check?.details?.thirdPartyHosts).toEqual(["cdn.vendor-example.com"]);
  });

  test("without a third-party script the finding is unchanged", () => {
    const check = find(run(EVAL, FIRST_PARTY), "csp-unsafe-scripts");
    expect(check?.message).toBe("CSP allows 'unsafe-eval'");
    expect(check?.value).toBe("Weakens XSS protection significantly");
    expect(check?.expected).toBe(
      "Use nonces or hashes instead of unsafe-inline"
    );
    expect(check?.details?.thirdPartyHosts).toBeUndefined();
  });

  test("'unsafe-inline' alone gets no eval context", () => {
    const check = find(
      run("script-src 'self' 'unsafe-inline'; report-uri /r", VENDOR),
      "csp-unsafe-scripts"
    );
    expect(check?.value).toBe("Weakens XSS protection significantly");
  });
});

describe("no third-party script, no new findings (#2087)", () => {
  // The loosest enforced policy: every new check would fire with a vendor script.
  const LOOSE = "script-src 'nonce-a' 'strict-dynamic'";

  test("the loose policy fires all three with a vendor script", () => {
    expect(names(run(LOOSE, VENDOR))).toEqual(
      expect.arrayContaining(NEW_CHECKS)
    );
  });

  test.each([
    ["first-party and same-site subdomain scripts", FIRST_PARTY],
    ["no scripts", ""],
    ["a vendor script inside <noscript>", `<noscript>${VENDOR}</noscript>`],
    ["a non-http script src", `<script src="data:text/javascript,1"></script>`],
  ])("%s", (_n, body) => {
    const got = names(run(LOOSE, body));
    for (const name of NEW_CHECKS) expect(got).not.toContain(name);
  });

  test("a report-only policy gets none (csp-report-only covers it)", () => {
    const got = names(
      run(LOOSE, VENDOR, { header: "content-security-policy-report-only" })
    );
    expect(got).toContain("csp-report-only");
    for (const name of NEW_CHECKS) expect(got).not.toContain(name);
  });
});

describe("streaming path reads the collected script srcs (#2087)", () => {
  const LOOSE = "script-src 'nonce-a' 'strict-dynamic'";

  test("a collected vendor src fires the checks", () => {
    const got = names(
      run(LOOSE, "", { collected: ["https://cdn.vendor-example.com/p.js"] })
    );
    expect(got).toEqual(expect.arrayContaining(NEW_CHECKS));
  });

  test("collected first-party srcs fire none", () => {
    const got = names(
      run(LOOSE, "", {
        collected: ["/app.js", "https://static.example.com/x.js"],
      })
    );
    for (const name of NEW_CHECKS) expect(got).not.toContain(name);
  });
});

describe("which scripts count as third-party (#2087)", () => {
  const LOOSE = "script-src 'nonce-a' 'strict-dynamic'";
  const fires = (url: string, src: string) =>
    names(run(LOOSE, `<script src="${src}"></script>`, { url })).includes(
      "csp-connect-unrestricted"
    );

  test.each([
    [
      "a sibling of a deep subdomain",
      "https://a.b.example.com/",
      "https://cdn.example.com/x.js",
    ],
    [
      "the apex from www",
      "https://www.example.com/",
      "https://example.com/x.js",
    ],
    [
      "a sibling under co.uk",
      "https://www.example.co.uk/",
      "https://static.example.co.uk/x.js",
    ],
    ["a relative src", "https://www.example.com/a/", "x.js"],
  ])("%s is first party", (_n, url, src) => {
    expect(fires(url, src)).toBe(false);
  });

  test.each([
    [
      "another .com",
      "https://www.example.com/",
      "https://cdn.optimizely-example.com/x.js",
    ],
    [
      "another domain under co.uk",
      "https://www.example.co.uk/",
      "https://cdn.vendor.co.uk/x.js",
    ],
    [
      "a protocol-relative vendor src",
      "https://example.com/",
      "//cdn.vendor-example.net/x.js",
    ],
  ])("%s is third party", (_n, url, src) => {
    expect(fires(url, src)).toBe(true);
  });
});
