// #1841. The CLI-side preflight that keeps a local/private-network audit from
// handing anything to a hosted service that would have to fetch the address.
//
// The contract under test is deliberately ASYMMETRIC: a false negative here is
// harmless (the API's stricter classifier still refuses, and says so), while a
// false POSITIVE would silently stop a real customer site from publishing. So
// the "still public" cases matter more than the coverage cases.
import { describe, expect, test } from "bun:test";

import {
  cloudRenderSkippedLines,
  LOCAL_HOST_NOT_PUBLISHED_LINE,
  nonPublicHostLabel,
  SERVER_NON_PUBLIC_HOST_LINE,
} from "../../src/lib/non-public-host";

describe("nonPublicHostLabel", () => {
  test.each([
    ["http://localhost:3000", "localhost:3000"],
    ["http://localhost/", "localhost"],
    ["http://app.localhost:8080/x", "app.localhost:8080"],
    ["http://127.0.0.1:4321", "127.0.0.1:4321"],
    ["http://10.0.0.5/", "10.0.0.5"],
    ["http://192.168.1.10:8000/path", "192.168.1.10:8000"],
    ["http://172.16.4.1/", "172.16.4.1"],
    ["http://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ["http://[::1]:5173/", "[::1]:5173"],
    ["http://0.0.0.0:9000", "0.0.0.0:9000"],
    ["http://100.64.0.1/", "100.64.0.1"], // CGNAT
  ])("%s is unreachable from the cloud, labelled %s", (url, label) => {
    expect(nonPublicHostLabel(url)).toBe(label);
  });

  // The WHATWG URL parser canonicalizes these to 127.0.0.1 before the check
  // ever sees them, which is why the syntactic guard catches them at all.
  test.each([
    ["http://2130706433/", "127.0.0.1"],
    ["http://0177.0.0.1/", "127.0.0.1"],
  ])("the %s spelling of loopback is caught too", (url, label) => {
    expect(nonPublicHostLabel(url)).toBe(label);
  });

  test("a schemeless private host is normalized the same way the crawl does", () => {
    expect(nonPublicHostLabel("localhost:3000")).toBe("localhost:3000");
    expect(nonPublicHostLabel("127.0.0.1")).toBe("127.0.0.1");
  });

  test.each([
    ["https://example.com/"],
    ["https://www.squirrelscan.com/docs"],
    ["http://staging.example.com:8080/"],
    ["https://203.0.113.10/"], // a public literal IP
  ])("%s stays publishable", (url) => {
    expect(nonPublicHostLabel(url)).toBeNull();
  });

  // A typo must be reported by the normal URL validation, which says something
  // useful, not by a cloud-reachability warning that does not.
  test.each([[""], ["   "], ["not a url"], ["ftp://example.com/"]])(
    "unusable input %p is not classified here",
    (url) => {
      expect(nonPublicHostLabel(url)).toBeNull();
    }
  );

  // `box.local` is the documented gap: mDNS names look public to a syntactic
  // check and are refused by the API's egress classifier instead. Pinned so the
  // handoff this leaves to SERVER_NON_PUBLIC_HOST_LINE stays deliberate.
  test("an mDNS .local name is NOT caught here — the API refuses it", () => {
    expect(nonPublicHostLabel("http://mac-mini.local:3000/")).toBeNull();
  });
});

describe("the lines the user actually reads", () => {
  test("the render skip names the host and says the audit continues", () => {
    const [why, what] = cloudRenderSkippedLines("localhost:3000");
    expect(why).toBe(
      "No cloud runner can reach a local or private-network address (localhost:3000)."
    );
    expect(what).toContain("still runs locally");
  });

  // House style for public copy: no em-dashes anywhere the user sees.
  test.each([
    LOCAL_HOST_NOT_PUBLISHED_LINE,
    SERVER_NON_PUBLIC_HOST_LINE,
    ...cloudRenderSkippedLines("localhost:3000"),
  ])("%p has no em-dash", (line) => {
    expect(line).not.toContain("—");
  });
});
