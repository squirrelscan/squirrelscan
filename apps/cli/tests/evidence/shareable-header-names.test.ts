// Header names the shareable pass must keep (repo#2301, pub#1967).
//
// The credential-word rule blanks any header-map key containing `key`, `auth`,
// `credential`, ... That also matches headers that hold no secret and that
// audit rules read. Two checks keep it honest:
//   1. every HEADER_KEEP_NAMES entry keeps its value in a real shareable export;
//   2. every header name the audit rules read, collected from the rules package
//      itself (see `ruleHeaderNames`), survives unless it is on the exact
//      SENSITIVE_HEADER_NAMES list.

import {
  SECURITY_HEADER_RULES,
  gradeResponseHeaders,
} from "@squirrelscan/rules/security-headers";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { type EvidenceSource, exportEvidenceBundle } from "@/evidence/bundle";
import {
  HEADER_KEEP_NAMES,
  REDACTED,
  SENSITIVE_HEADER_NAMES,
  ShareableRedactor,
} from "@/evidence/redact";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const KEEP_VALUES: Record<string, string> = {
  "access-control-allow-credentials": "true",
  "public-key-pins":
    'pin-sha256="d6qzRu9zOECb90Uez27xWltNsj0e1Md7GkYYkVoZWmM="; max-age=600',
  "public-key-pins-report-only":
    'pin-sha256="E9CZ9INDbd+2eRQozYqqbQ2yXLVKB9+xcprMF+44U1g="; max-age=600',
  ":authority": "example.test",
};

function sourceWithHeaders(headers: Record<string, string>): EvidenceSource {
  const url = "https://example.test/";
  return {
    crawl: {
      id: "crawl-keep",
      baseUrl: url,
      startedAt: Date.UTC(2026, 0, 1),
      completedAt: Date.UTC(2026, 0, 1, 0, 1),
      status: "analyzed",
      config: { maxPages: 1 },
      stats: { pagesTotal: 1, pagesFetched: 1, pagesFailed: 0 },
    },
    scanner: { name: "squirrel", version: "9.9.9", rulesRevision: "rev" },
    pages: [
      {
        url,
        normalizedUrl: url,
        finalUrl: url,
        depth: 0,
        status: 200,
        contentType: "text/html",
        sizeBytes: 10,
        loadTimeMs: 5,
        fetchedAt: Date.UTC(2026, 0, 1),
        headers,
        requestHeaders: headers,
        html: "<html><body>ok</body></html>",
      },
    ],
    scripts: [],
    failures: [],
    findings: [],
  };
}

describe("header keep-list", () => {
  test("the test values cover every keep-list entry", () => {
    expect(Object.keys(KEEP_VALUES).sort()).toEqual(
      [...HEADER_KEEP_NAMES.keys()].sort()
    );
  });

  for (const name of HEADER_KEEP_NAMES.keys()) {
    test(`${name} keeps its value in a shareable bundle`, () => {
      const value = KEEP_VALUES[name] ?? "";
      const dir = join(mkdtempSync(join(tmpdir(), "evidence-keep-")), "bundle");
      roots.push(dirname(dir));
      exportEvidenceBundle(sourceWithHeaders({ [name]: value }), dir, {
        kind: "shareable",
      });
      const [page] = JSON.parse(readFileSync(join(dir, "pages.json"), "utf-8"));
      expect(page.responseHeaders[name]).toBe(value);
      expect(page.requestHeaders[name]).toBe(value);
    });
  }

  test("letter case and `_` do not defeat the keep-list", () => {
    const out = new ShareableRedactor().json("pages.json", {
      responseHeaders: {
        "Access-Control-Allow-Credentials": "true",
        PUBLIC_KEY_PINS: "max-age=600",
      },
    }) as { responseHeaders: Record<string, string> };
    expect(out.responseHeaders["Access-Control-Allow-Credentials"]).toBe(
      "true"
    );
    expect(out.responseHeaders.PUBLIC_KEY_PINS).toBe("max-age=600");
  });

  test("the keep-list never overrides the exact sensitive list", () => {
    for (const name of HEADER_KEEP_NAMES.keys())
      expect(SENSITIVE_HEADER_NAMES).not.toContain(name);
  });
});

// ── Header names the audit rules read ────────────────────────────────────────────

const RULES_SRC = dirname(
  fileURLToPath(import.meta.resolve("@squirrelscan/rules"))
);

/**
 * Static: every rules source file, every literal header name in a header read:
 *   `headers["x"]`, `headers?.["x"]`, `headers.get("x")` and a call to a
 *   `*Header*(...)` helper with the name as a literal argument
 *   (`headerValue(h, "x")`), in any file; and in a file that reads a header
 *   map by a non-literal key or iterates its keys, a key comparison
 *   (`name.toLowerCase() === "x"`, meta-refresh) or a `{ key: "x", label: ... }`
 *   table (version-disclosure).
 * Drift guard: a file that reads a header map by a non-literal key or iterates
 * its keys must yield at least one name here, so a new read shape fails the
 * test instead of slipping past it.
 */
const LITERAL_READS: readonly RegExp[] = [
  /headers\??\.?\[\s*["'`]([^"'`]+)["'`]\s*\]/gi,
  /headers\??\.get\(\s*["'`]([^"'`]+)["'`]/gi,
  /\b\w*header\w*\([^()"'`]*,\s*["'`]([^"'`]+)["'`]/gi,
];
const DYNAMIC_FILE_READS: readonly RegExp[] = [
  /\b(?:name|key)\.toLowerCase\(\)\s*===\s*["'`]([^"'`]+)["'`]/g,
  /\{\s*key:\s*["'`]([^"'`]+)["'`],\s*label:/g,
];
const DYNAMIC_READ =
  /headers\??\.?\[\s*[A-Za-z_]|\b(?:entries|keys|values)\(\s*[\w.?]*headers\b/i;
const HEADER_NAME = /^:?[a-z0-9][a-z0-9-]*$/;

async function staticRuleHeaderNames(): Promise<{
  names: Set<string>;
  dynamicFilesWithoutNames: string[];
}> {
  const names = new Set<string>();
  const dynamicFilesWithoutNames: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan(RULES_SRC)) {
    if (file.endsWith(".test.ts")) continue;
    const src = await Bun.file(join(RULES_SRC, file)).text();
    const found = new Set<string>();
    const dynamic = DYNAMIC_READ.test(src);
    for (const re of dynamic
      ? [...LITERAL_READS, ...DYNAMIC_FILE_READS]
      : LITERAL_READS)
      for (const m of src.matchAll(re)) {
        const name = (m[1] ?? "").toLowerCase();
        if (HEADER_NAME.test(name)) found.add(name);
      }
    if (dynamic && found.size === 0)
      dynamicFilesWithoutNames.push(relative(RULES_SRC, join(RULES_SRC, file)));
    for (const n of found) names.add(n);
  }
  return { names, dynamicFilesWithoutNames };
}

/**
 * Dynamic: run each security header rule (the importable SECURITY_HEADER_RULES)
 * on a header record that records every name read, once with every header
 * absent and once with every header present, so both branches are walked.
 */
function dynamicRuleHeaderNames(): Set<string> {
  const names = new Set<string>();
  for (const present of [false, true]) {
    const headers = new Proxy({} as Record<string, string>, {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        names.add(prop.toLowerCase());
        return present ? "max-age=1" : undefined;
      },
      has(_t, prop) {
        if (typeof prop === "string") names.add(prop.toLowerCase());
        return present;
      },
    });
    for (const rule of SECURITY_HEADER_RULES)
      gradeResponseHeaders(rule, "https://example.test/", headers);
  }
  return names;
}

describe("header names the audit rules read", () => {
  test("survive the credential-word rule unless on the exact sensitive list", async () => {
    const { names, dynamicFilesWithoutNames } = await staticRuleHeaderNames();
    expect(dynamicFilesWithoutNames).toEqual([]);
    const dynamic = dynamicRuleHeaderNames();
    for (const n of dynamic) names.add(n);

    // The collectors work: names known to be read by the rules are found.
    for (const anchor of [
      "content-security-policy",
      "strict-transport-security",
      "x-frame-options",
      "set-cookie",
      "server",
      "x-powered-by",
      "refresh",
    ])
      expect(names).toContain(anchor);
    expect(dynamic).toContain("strict-transport-security");

    const sensitive = new Set(SENSITIVE_HEADER_NAMES);
    const headerMap: Record<string, string> = {};
    for (const n of names) headerMap[n] = "v";
    const out = new ShareableRedactor().json("pages.json", {
      responseHeaders: headerMap,
    }) as { responseHeaders: Record<string, string> };
    const wronglyRedacted = [...names].filter(
      (n) => !sensitive.has(n) && out.responseHeaders[n] === REDACTED
    );
    expect(wronglyRedacted).toEqual([]);
  });
});
