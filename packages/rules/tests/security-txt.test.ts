// security/security-txt — RFC 9116 file at /.well-known/security.txt (#713).

import { describe, expect, test } from "bun:test";

import { PROBE_NOT_ATTEMPTED_ERROR, WELL_KNOWN_PATHS } from "@squirrelscan/core-contracts/storage";

import type { CheckResult, WellKnownProbe, WellKnownProbeData } from "@squirrelscan/core-contracts";

import { securityTxtRule } from "../src/security/security-txt";
import type { ParsedPage, RuleContext } from "../src/types";

const CANONICAL = "/.well-known/security.txt";
const LEGACY = "/security.txt";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2001-01-01T00:00:00.000Z";

function probe(path: string, over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return {
    path,
    url: `https://example.com${path}`,
    status: 404,
    contentType: null,
    bodySize: 0,
    looksHtml: false,
    jsonValid: false,
    jsonKeys: [],
    markdownLike: false,
    excerpt: "",
    oauthRegistrationEndpoint: null,
    oauthClientIdMetadataDocumentSupported: null,
    error: null,
    ...over,
  };
}

const HTML_HOME =
  "<!doctype html><html><head><title>Acme</title></head><body>Welcome</body></html>";

function file(path: string, body: string, over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return probe(path, {
    status: 200,
    contentType: "text/plain; charset=utf-8",
    bodySize: new TextEncoder().encode(body).length,
    excerpt: body,
    ...over,
  });
}

// Every well-known path the crawler sweeps: an unlisted path is a 404.
function sweep(probes: WellKnownProbe[]): WellKnownProbe[] {
  return WELL_KNOWN_PATHS.map((path) => probes.find((p) => p.path === path) ?? probe(path));
}

function run(probes: WellKnownProbe[] | null | undefined, raw = false): CheckResult[] {
  const wk: WellKnownProbeData | null = probes ? { probes: raw ? probes : sweep(probes) } : null;
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      wellKnown: wk,
    },
    options: {},
  };
  return securityTxtRule.run(ctx).checks;
}

const VALID = `Contact: mailto:security@example.com\nExpires: ${FUTURE}\n`;

describe("security/security-txt", () => {
  test("declares both locations as discovery probes", () => {
    expect(securityTxtRule.meta.discoveryProbes).toEqual([CANONICAL, LEGACY]);
    expect(WELL_KNOWN_PATHS).toContain(CANONICAL);
    expect(WELL_KNOWN_PATHS).toContain(LEGACY);
  });

  test("data unavailable: not checked, never missing", () => {
    const checks = run(undefined);
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.status).toBe("info");
  });

  test("no security.txt at either path: warns missing", () => {
    const checks = run([probe(CANONICAL), probe(LEGACY)]);
    const missing = checks.find((c) => c.value === "missing");
    expect(missing?.status).toBe("warn");
    expect(missing?.message).toContain(CANONICAL);
  });

  test("catch-all HTML homepage at the canonical path warns, never passes", () => {
    const html = file(CANONICAL, HTML_HOME, {
      contentType: "text/html; charset=utf-8",
      looksHtml: true,
    });
    const checks = run([html, probe(LEGACY)]);
    expect(checks.some((c) => c.status === "pass")).toBe(false);
    const warn = checks.find((c) => c.status === "warn");
    expect(warn?.value).toBe("html");
    expect(warn?.message).toContain("catch-all");
  });

  test("HTML is detected from the body even when looksHtml is unset and the type is wrong", () => {
    const html = file(CANONICAL, `\n  ${HTML_HOME}`, { contentType: "text/plain" });
    const checks = run([html]);
    expect(checks.find((c) => c.value === "html")?.status).toBe("warn");
  });

  test("valid file with Contact and a future Expires passes", () => {
    const checks = run([file(CANONICAL, VALID)]);
    const pass = checks.find((c) => c.status === "pass");
    expect(pass).toBeDefined();
    expect(checks.some((c) => c.status === "warn")).toBe(false);
  });

  test("Expires in the past warns", () => {
    const checks = run([file(CANONICAL, `Contact: mailto:a@example.com\nExpires: ${PAST}\n`)]);
    const warn = checks.find((c) => c.status === "warn");
    expect(warn?.message).toContain("expired");
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("missing Contact warns", () => {
    const checks = run([file(CANONICAL, `Expires: ${FUTURE}\n`)]);
    expect(checks.find((c) => c.status === "warn")?.message).toContain("Contact");
  });

  test("missing Expires warns", () => {
    const checks = run([file(CANONICAL, "Contact: mailto:a@example.com\n")]);
    expect(checks.find((c) => c.status === "warn")?.message).toContain("Expires");
  });

  test("field names are case-insensitive and comment lines are ignored", () => {
    const body = `# a comment\nCONTACT: https://example.com/report\nexpires: ${FUTURE}\n`;
    const checks = run([file(CANONICAL, body)]);
    expect(checks.some((c) => c.status === "warn")).toBe(false);
    expect(checks.some((c) => c.status === "pass")).toBe(true);
  });

  test("file served only at the legacy location is info, and still validated", () => {
    const checks = run([probe(CANONICAL), file(LEGACY, VALID)]);
    const location = checks.find((c) => c.value === "legacy-only");
    expect(location?.status).toBe("info");
    expect(checks.some((c) => c.status === "warn")).toBe(false);
  });

  test("unsigned file adds an info check, not a warning", () => {
    const checks = run([file(CANONICAL, VALID)]);
    const signed = checks.find((c) => c.value === "unsigned");
    expect(signed?.status).toBe("info");
  });

  test("PGP-signed file is not reported as unsigned", () => {
    const body = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${VALID}-----BEGIN PGP SIGNATURE-----\n`;
    const checks = run([file(CANONICAL, body)]);
    expect(checks.some((c) => c.value === "unsigned")).toBe(false);
  });

  test("a body longer than the excerpt does not warn for fields it may have cut off", () => {
    const checks = run([file(CANONICAL, "# padding\n", { bodySize: 10_000 })]);
    expect(checks.some((c) => c.status === "warn")).toBe(false);
  });

  test.each([401, 403, 429, 500, 503])(
    "HTTP %d at the canonical path is not checked, never missing",
    (status) => {
      const checks = run(sweep([probe(CANONICAL, { status })]));
      expect(checks.some((c) => c.status === "warn")).toBe(false);
      const check = checks.find((c) => c.name === "security-txt");
      expect(check?.status).toBe("info");
      expect(check?.message).toContain(`HTTP ${status}`);
    },
  );

  test("410 at the canonical path warns missing, like 404", () => {
    const checks = run(sweep([probe(CANONICAL, { status: 410 })]));
    expect(checks.find((c) => c.name === "security-txt")?.status).toBe("warn");
  });

  test.each(["2027", "Oct 1 2027", "2027-02-30T00:00:00Z", "2027-01-01 00:00:00Z", "2099-01-01"])(
    "Expires %p is not an RFC 3339 date-time and warns",
    (expires) => {
      const checks = run(
        sweep([file(CANONICAL, `Contact: mailto:security@example.com\nExpires: ${expires}\n`)]),
      );
      const check = checks.find((c) => c.name === "security-txt-expires");
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("RFC 3339");
    },
  );

  test("Expires with an offset and fractional seconds is accepted", () => {
    const checks = run(
      sweep([
        file(
          CANONICAL,
          "Contact: mailto:security@example.com\nExpires: 2099-06-30T12:00:00.5+10:00\n",
        ),
      ]),
    );
    expect(checks.find((c) => c.name === "security-txt")?.status).toBe("pass");
  });

  test("more than one Expires field warns", () => {
    const checks = run(
      sweep([
        file(
          CANONICAL,
          `Contact: mailto:security@example.com\nExpires: ${FUTURE}\nExpires: ${FUTURE}\n`,
        ),
      ]),
    );
    expect(checks.find((c) => c.name === "security-txt-expires-duplicate")?.status).toBe("warn");
  });

  test("a long past Expires is capped in the message", () => {
    // Valid RFC 3339: fractional seconds have no length limit.
    const expires = `2001-01-01T00:00:00.${"0".repeat(500)}Z`;
    const checks = run(
      sweep([file(CANONICAL, `Contact: mailto:security@example.com\nExpires: ${expires}\n`)]),
    );
    const check = checks.find((c) => c.name === "security-txt-expires");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("expired on");
    expect(check?.message.length).toBeLessThan(120);
  });

  test("a probe that got no answer is not checked, not missing", () => {
    const refused = probe(CANONICAL, { status: 0, error: "The operation timed out" });
    const checks = run(
      [refused, probe(LEGACY, { status: 0, error: PROBE_NOT_ATTEMPTED_ERROR })],
      true,
    );
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks.some((c) => c.status === "warn")).toBe(false);
  });
});
