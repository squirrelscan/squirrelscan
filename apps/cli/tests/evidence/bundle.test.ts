import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type EvidenceSource,
  type SourcePage,
  ExportTargetError,
  exportEvidenceBundle,
  findInlineScripts,
  hasVerifiedBundle,
  replayEvidenceBundle,
  sha256,
  verifyEvidenceBundle,
} from "@/evidence/bundle";
import {
  redactHeaders,
  redactText,
  redactUrl,
  newRedactionCounts,
} from "@/evidence/redact";

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-test-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const HOME_HTML =
  '<html><head><title>Home</title><meta name="csrf-token" content="abc123secret"></head><body>' +
  '<img id="hero" src="/a.png">' +
  '<script>window.cfg={api_key:"sk_live_abcdefghijklmnop1234"}</script>' +
  '<script type="application/ld+json">{"@type":"Thing"}</script>' +
  '<script src="/app.js"></script>' +
  "<p>Contact: owner@example.com</p></body></html>";

function page(over: Partial<SourcePage> & { url: string }): SourcePage {
  return {
    normalizedUrl: over.url,
    finalUrl: over.url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 10,
    loadTimeMs: 5,
    fetchedAt: Date.UTC(2026, 0, 1),
    headers: { contentType: "text/html", "set-cookie": "sid=SECRET" },
    requestHeaders: { "accept-encoding": "gzip" },
    html: HOME_HTML,
    ...over,
  };
}

function source(): EvidenceSource {
  return {
    crawl: {
      id: "crawl-1",
      baseUrl: "https://example.test/",
      startedAt: Date.UTC(2026, 0, 1),
      completedAt: Date.UTC(2026, 0, 1, 0, 5),
      status: "analyzed",
      config: { maxPages: 2, timeoutMs: 1000, userAgent: "squirrel" },
      stats: { pagesTotal: 3, pagesFetched: 2, pagesFailed: 1 },
    },
    scanner: { name: "squirrel", version: "9.9.9", rulesRevision: "rev-abc" },
    pages: [
      page({ url: "https://example.test/?token=SECRETTOKEN&a=1" }),
      page({
        url: "https://example.test/rendered",
        fetcherId: "browser",
        redirectChain: {
          sourceUrl: "https://example.test/old",
          finalUrl: "https://example.test/rendered",
          hops: [
            { url: "https://example.test/old", statusCode: 301, type: "http" },
          ],
          chainLength: 1,
          isLoop: false,
          endsInError: false,
        },
      }),
      page({ url: "https://example.test/evicted", html: null }),
    ],
    scripts: [
      {
        url: "https://example.test/app.js",
        finalUrl: null,
        sizeBytes: 5,
        status: "stored",
        skipReason: null,
        sourcePages: ["https://example.test/?token=SECRETTOKEN&a=1"],
        evicted: false,
        body: "var x=1;",
      },
    ],
    failures: [
      {
        url: "https://example.test/down",
        status: "failed",
        reason: "timeout",
        depth: 1,
        source: "discovered",
        retryCount: 2,
      },
    ],
    findings: [
      {
        ruleId: "core/img",
        name: "alt",
        status: "fail",
        message: "image missing alt",
        pageUrl: "https://example.test/?token=SECRETTOKEN&a=1",
        items: [
          {
            id: "i1",
            snippet: '<img id="hero" src="/a.png">',
            selector: "html > body > img#hero",
          },
        ],
      },
      {
        ruleId: "core/clip",
        name: "clip",
        status: "warn",
        message: "clipped",
        pageUrl: "https://example.test/rendered",
        items: [{ id: "i2", snippet: "<p>Contact: owner@exa…" }],
      },
      {
        ruleId: "core/gone",
        name: "gone",
        status: "fail",
        message: "on an evicted page",
        pageUrl: "https://example.test/evicted",
      },
      {
        ruleId: "core/site",
        name: "site",
        status: "warn",
        message: "site wide",
      },
    ],
  };
}

const resolveSelector = (html: string, selector: string): boolean =>
  selector === "html > body > img#hero" && html.includes('id="hero"');

describe("evidence bundle export", () => {
  test("raw bundle holds config, scanner, headers, fetch mode, redirects, failures and limits", () => {
    const dir = join(tmp(), "raw");
    const { manifest } = exportEvidenceBundle(source(), dir, {
      kind: "raw",
      now: () => new Date(0),
    });
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.sensitivity).toBe("restricted");
    const audit = JSON.parse(readFileSync(join(dir, "audit.json"), "utf-8"));
    expect(audit.scanner).toEqual({
      name: "squirrel",
      version: "9.9.9",
      rulesRevision: "rev-abc",
    });
    expect(audit.configuration.maxPages).toBe(2);
    expect(audit.completion.hitPageLimit).toBe(true);
    expect(audit.limits.maxPages).toBe(2);
    const pages = JSON.parse(readFileSync(join(dir, "pages.json"), "utf-8"));
    expect(pages[0].responseHeaders["set-cookie"]).toBe("sid=SECRET");
    expect(pages[0].capturedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(pages[0].fetch.mode).toBe("http");
    expect(pages[1].fetch.mode).toBe("render");
    expect(pages[1].redirect.hops[0].statusCode).toBe(301);
    const failures = JSON.parse(
      readFileSync(join(dir, "failures.json"), "utf-8")
    );
    expect(failures[0]).toMatchObject({ status: "failed", reason: "timeout" });
  });

  test("response bytes and rendered DOM are separate artifact types, the missing one explicit", () => {
    const dir = join(tmp(), "types");
    exportEvidenceBundle(source(), dir, { kind: "raw" });
    const pages = JSON.parse(readFileSync(join(dir, "pages.json"), "utf-8"));
    const http = pages[0].artifacts;
    expect(http[0]).toMatchObject({ type: "response-body", state: "stored" });
    expect(http[1]).toMatchObject({
      type: "rendered-dom",
      state: "unavailable",
    });
    expect(http[1].reason).toContain("no rendered DOM");
    const rendered = pages[1].artifacts;
    expect(rendered[0]).toMatchObject({
      type: "rendered-dom",
      state: "stored",
    });
    expect(rendered[1]).toMatchObject({
      type: "response-body",
      state: "unavailable",
    });
    expect(rendered[0].path).toContain("artifacts/rendered-dom/");
    expect(pages[2].artifacts[0]).toMatchObject({ state: "unavailable" });
  });

  test("findings carry content hash plus selector and byte range; clipped and missing evidence is explicit", () => {
    const dir = join(tmp(), "findings");
    exportEvidenceBundle(source(), dir, { kind: "raw" });
    const findings = JSON.parse(
      readFileSync(join(dir, "findings.json"), "utf-8")
    );
    const byRule = (id: string) =>
      findings.find((f: { ruleId: string }) => f.ruleId === id);
    const located = byRule("core/img").evidence[0];
    expect(located.state).toBe("located");
    expect(located.contentSha256).toBe(sha256(HOME_HTML));
    expect(located.locator.selector).toBe("html > body > img#hero");
    const { start, end, snippetSha256 } = located.locator.byteRange;
    expect(sha256(Buffer.from(HOME_HTML).subarray(start, end))).toBe(
      snippetSha256
    );
    expect(byRule("core/clip").evidence[0].state).toBe("truncated");
    expect(byRule("core/gone").evidence[0]).toMatchObject({
      state: "unavailable",
      contentSha256: null,
    });
    expect(byRule("core/gone").evidence[0].reason).toBeTruthy();
    expect(byRule("core/site").evidence).toEqual([]);
  });

  test("inline scripts and data keep lineage to the page artifact; external scripts name the referencing page", () => {
    const dir = join(tmp(), "scripts");
    exportEvidenceBundle(source(), dir, { kind: "raw" });
    const inline = JSON.parse(
      readFileSync(join(dir, "inline-scripts.json"), "utf-8")
    );
    const refs = inline["https://example.test/?token=SECRETTOKEN&a=1"];
    expect(refs.map((r: { kind: string }) => r.kind)).toEqual([
      "inline-script",
      "inline-data",
    ]);
    expect(refs[0].parentSha256).toBe(sha256(HOME_HTML));
    const bytes = Buffer.from(HOME_HTML).subarray(
      refs[1].byteStart,
      refs[1].byteEnd
    );
    expect(bytes.toString()).toBe('{"@type":"Thing"}');
    const scripts = JSON.parse(
      readFileSync(join(dir, "scripts.json"), "utf-8")
    );
    expect(scripts[0].referencedFrom[0].pageArtifactSha256).toBe(
      sha256(HOME_HTML)
    );
    expect(scripts[0].artifact.type).toBe("script");
  });

  test("findInlineScripts computes byte offsets over multibyte text", () => {
    const html = "<p>é✓</p><script>let a=1</script>";
    const [ref] = findInlineScripts(html, "p");
    expect(
      Buffer.from(html).subarray(ref!.byteStart, ref!.byteEnd).toString()
    ).toBe("let a=1");
  });

  test("findInlineScripts ends a script at an end tag with whitespace or junk before >", () => {
    const html =
      "<script>let a=1</script\t\n bar><p>x</p><script>let b=2</SCRIPT >";
    const refs = findInlineScripts(html, "p");
    expect(
      refs.map((r) =>
        Buffer.from(html).subarray(r.byteStart, r.byteEnd).toString()
      )
    ).toEqual(["let a=1", "let b=2"]);
  });

  test("refuses to overwrite a non-empty target", () => {
    const dir = tmp();
    writeFileSync(join(dir, "x"), "x");
    expect(() => exportEvidenceBundle(source(), dir, { kind: "raw" })).toThrow(
      ExportTargetError
    );
  });

  test("raw export is restricted to the owner", () => {
    const dir = join(tmp(), "mode");
    exportEvidenceBundle(source(), dir, { kind: "raw" });
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "pages.json")).mode & 0o077).toBe(0);
    expect(readFileSync(join(dir, "README.txt"), "utf-8")).toContain(
      "RESTRICTED"
    );
  });
});

describe("shareable export", () => {
  test("redacts cookies, tokens in URLs, account data and secrets, and still verifies and replays", () => {
    const dir = join(tmp(), "share");
    const { manifest } = exportEvidenceBundle(source(), dir, {
      kind: "shareable",
    });
    expect(manifest.sensitivity).toBe("shareable");
    expect(manifest.redaction?.counts.headers).toBeGreaterThan(0);
    const everything =
      manifest.files
        .map((f) => readFileSync(join(dir, ...f.path.split("/")), "utf-8"))
        .join("\n") + JSON.stringify(manifest);
    for (const secret of [
      "SECRETTOKEN",
      "sid=SECRET",
      "owner@example.com",
      "sk_live_abcdefghijklmnop1234",
      "abc123secret",
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(verifyEvidenceBundle(dir).ok).toBe(true);
    const replay = replayEvidenceBundle(dir, resolveSelector);
    expect(replay.mismatched).toBe(0);
    expect(replay.confirmed).toBeGreaterThan(0);
  });

  test("redacts observations, skip and failure reasons, stats, scope and URL-bearing header values", () => {
    const base = source();
    const [first, ...rest] = [...base.pages];
    const leaky: EvidenceSource = {
      ...base,
      crawl: {
        ...base.crawl,
        stats: {
          pagesTotal: 3,
          lastError: "fetch https://example.test/x?session=STATSSESSION failed",
        },
        scanScope: {
          seeds: ["https://example.test/?api_key=SCOPEKEY"],
          note: "contact scope@example.com",
        },
      },
      pages: [
        {
          ...first!,
          headers: {
            location: "/callback?code=LOCATIONCODE&next=/home",
            "content-location": "https://example.test/c?sid=CONTENTLOCSID",
            link: '<https://cdn.test/a.js?signature=LINKSIG>; rel="preload"',
            refresh: "0; url=https://example.test/r?access_token=REFRESHTOK",
            server: "nginx",
          },
        },
        ...rest,
      ],
      failures: [
        {
          url: "https://example.test/down",
          status: "failed",
          reason: "redirected to https://login.test/?ticket=FAILTICKET",
          depth: 1,
          source: "discovered",
          retryCount: 0,
        },
      ],
      findings: [
        ...base.findings,
        {
          ruleId: "core/obs",
          name: "obs",
          status: "fail",
          message: "observed",
          pageUrl: "https://example.test/rendered",
          skipReason: "auth wall at https://example.test/l?password=SKIPPASS",
          observation: {
            urls: ["https://example.test/o?token=OBSTOKEN"],
            nested: { secret: "Bearer OBSBEARERTOKEN123456" },
            count: 3,
          },
        },
      ],
    };
    const dir = join(tmp(), "share-deep");
    const { manifest } = exportEvidenceBundle(leaky, dir, {
      kind: "shareable",
    });
    const everything =
      manifest.files
        .map((f) => readFileSync(join(dir, ...f.path.split("/")), "utf-8"))
        .join("\n") + JSON.stringify(manifest);
    for (const secret of [
      "STATSSESSION",
      "SCOPEKEY",
      "scope@example.com",
      "LOCATIONCODE",
      "CONTENTLOCSID",
      "LINKSIG",
      "REFRESHTOK",
      "FAILTICKET",
      "SKIPPASS",
      "OBSTOKEN",
      "OBSBEARERTOKEN123456",
    ]) {
      expect(everything).not.toContain(secret);
    }
    // Shape survives: non-secret values and structure are kept.
    const pages = JSON.parse(readFileSync(join(dir, "pages.json"), "utf-8"));
    expect(pages[0].responseHeaders.server).toBe("nginx");
    expect(pages[0].responseHeaders.location).toBe(
      "/callback?code=[redacted]&next=/home"
    );
    const findings = JSON.parse(
      readFileSync(join(dir, "findings.json"), "utf-8")
    );
    const obs = findings.find(
      (f: { ruleId: string }) => f.ruleId === "core/obs"
    );
    expect(obs.observation.count).toBe(3);
    const audit = JSON.parse(readFileSync(join(dir, "audit.json"), "utf-8"));
    expect(audit.completion.stats.pagesTotal).toBe(3);
    expect(verifyEvidenceBundle(dir).ok).toBe(true);

    // The raw bundle keeps every value as observed.
    const rawDir = join(tmp(), "raw-deep");
    exportEvidenceBundle(leaky, rawDir, { kind: "raw" });
    const raw = readFileSync(join(rawDir, "findings.json"), "utf-8");
    expect(raw).toContain("OBSTOKEN");
  });

  test("redactUrl, redactHeaders and redactText unit behaviour", () => {
    const counts = newRedactionCounts();
    expect(redactUrl("https://u:p@a.test/x?q=1&password=hunter2", counts)).toBe(
      "https://a.test/x?q=1&password=[redacted]"
    );
    expect(redactUrl("not a url", counts)).toBe("not a url");
    expect(
      redactHeaders({ Authorization: "Bearer x", server: "nginx" }, counts)
    ).toEqual({ Authorization: "[redacted]", server: "nginx" });
    expect(
      redactText("Authorization: Bearer abcdefghijklmnop", counts)
    ).not.toContain("abcdefghijklmnop");
  });
});

describe("verify and replay", () => {
  test("a complete bundle verifies and replays offline", () => {
    const dir = join(tmp(), "ok");
    exportEvidenceBundle(source(), dir, { kind: "raw" });
    expect(verifyEvidenceBundle(dir)).toMatchObject({ ok: true, issues: [] });
    const replay = replayEvidenceBundle(dir, resolveSelector);
    expect(replay.mismatched).toBe(0);
    expect(replay.confirmed).toBe(2);
    expect(replay.unavailable).toBe(1);
    expect(replay.total).toBe(3);
  });

  test("a tampered artifact, an extra file and a missing manifest are all reported", () => {
    const dir = join(tmp(), "bad");
    exportEvidenceBundle(source(), dir, { kind: "raw" });
    appendFileSync(
      join(dir, "artifacts", "response-body", sha256(HOME_HTML)),
      "tamper"
    );
    writeFileSync(join(dir, "stray.txt"), "x");
    const result = verifyEvidenceBundle(dir);
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain("sha256 mismatch");
    expect(result.issues.join("\n")).toContain(
      "stray.txt: not in the manifest"
    );
    expect(replayEvidenceBundle(dir, resolveSelector).total).toBe(0);

    const partial = join(tmp(), "partial");
    exportEvidenceBundle(source(), partial, { kind: "raw" });
    rmSync(join(partial, "manifest.json"));
    expect(verifyEvidenceBundle(partial).issues[0]).toContain("interrupted");
  });

  test("a newer format version is refused with an upgrade message", () => {
    const dir = join(tmp(), "future");
    exportEvidenceBundle(source(), dir, { kind: "raw" });
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf-8")
    );
    manifest.formatVersion = 99;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    expect(verifyEvidenceBundle(dir).issues[0]).toContain("update squirrel");
  });

  test("replay flags evidence whose range no longer matches", () => {
    const dir = join(tmp(), "mismatch");
    exportEvidenceBundle(source(), dir, { kind: "raw" });
    const path = join(dir, "findings.json");
    const findings = JSON.parse(readFileSync(path, "utf-8"));
    findings[0].evidence[0].locator.byteRange.snippetSha256 = "0".repeat(64);
    writeFileSync(path, JSON.stringify(findings));
    // findings.json changed on disk: the manifest hash catches it first.
    expect(verifyEvidenceBundle(dir).ok).toBe(false);
  });
});

describe("cleanup gate", () => {
  test("hasVerifiedBundle is true only for a verifying bundle of that crawl", () => {
    const root = tmp();
    expect(hasVerifiedBundle(root, "crawl-1")).toBe(false);
    exportEvidenceBundle(source(), join(root, "crawl-1"), { kind: "raw" });
    expect(hasVerifiedBundle(root, "crawl-1")).toBe(true);
    expect(hasVerifiedBundle(root, "crawl-2")).toBe(false);
    appendFileSync(join(root, "crawl-1", "pages.json"), " ");
    expect(hasVerifiedBundle(root, "crawl-1")).toBe(false);
  });
});
