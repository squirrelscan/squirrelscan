import { nonPublicHostLabel as sharedNonPublicHostLabel } from "@squirrelscan/utils/non-public-host";
// #1841. The CLI-side preflight that keeps a local/private-network audit from
// handing anything to a hosted service that would have to fetch the address.
//
// The contract under test is deliberately ASYMMETRIC: a false negative here is
// harmless (the API's stricter classifier still refuses, and says so), while a
// false POSITIVE would silently stop a real customer site from publishing. So
// the "still public" cases matter more than the coverage cases.
import { describe, expect, test } from "bun:test";

import { privateTargetRuleIds } from "../../src/audit/smart-audits";
import {
  resolvePublishDecision,
  resolveRegisterDecision,
} from "../../src/cli/commands/audit";
import {
  cloudRenderSkippedLines,
  LOCAL_HOST_NOT_PUBLISHED_LINE,
  nonPublicHostLabel,
  SERVER_NON_PUBLIC_HOST_LINE,
} from "../../src/lib/non-public-host";

// The classifier's own cases live with it, in
// packages/utils/tests/non-public-host.test.ts (pub#629 moved it there so the
// rules runner shares it). This only pins that the CLI uses that one.
describe("nonPublicHostLabel", () => {
  test("is the shared classifier, not a CLI copy", () => {
    expect(nonPublicHostLabel).toBe(sharedNonPublicHostLabel);
  });

  test.each([
    ["http://localhost:3000", "localhost:3000"],
    ["http://192.168.1.10:8000/path", "192.168.1.10:8000"],
    ["http://mac-mini.local:3000/", "mac-mini.local:3000"],
  ])("%s is unreachable from the cloud, labelled %s", (url, label) => {
    expect(nonPublicHostLabel(url)).toBe(label);
  });

  test.each([["https://example.com/"], ["https://local.example.com/"]])(
    "%s stays publishable",
    (url) => {
      expect(nonPublicHostLabel(url)).toBeNull();
    }
  );
});

// #1560: NAT64, 6to4, Teredo and the other special-use IPv6 literals (and the IPv4 documentation and reserved ranges) are not public,
// whatever IPv4 they embed, in every caller that decides policy from the start URL: the label the cloud handoff, render charge and
// MCP billing read, the publish and register decisions made from it, and the smart audit's private-target rule list.
describe("special-use literals are non-public in every policy caller (#1560)", () => {
  const FORMS = [
    "http://[64:ff9b::a00:1]/", // NAT64 for 10.0.0.1
    "http://[64:ff9b::7f00:1]/", // NAT64 for loopback
    "http://[64:ff9b::a9fe:a9fe]/", // NAT64 for the metadata address
    "http://[64:ff9b:1::a00:1]/",
    "http://[2002:a00:1::]/", // 6to4 for 10.0.0.1
    "http://[2002:a9fe:a9fe::]/", // 6to4 for the metadata address
    "http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/", // Teredo
    "http://[fec0::1]/",
    "http://[2001:db8::1]/",
    "http://[ff02::1]/",
    "http://203.0.113.10/",
    "http://192.0.2.1:3000/",
  ];
  const SMART_ONLY_GATED = ["security/https", "perf/http2"];

  test.each(FORMS)(
    "%s: labelled, so not handed to the cloud, not billed, not published",
    (url) => {
      const label = nonPublicHostLabel(url);
      expect(label).not.toBeNull();
      expect(
        resolvePublishDecision({
          signedIn: true,
          offline: false,
          explicitPublish: true,
          noPublish: false,
          configPublish: true,
          nonPublicHost: label !== null,
        })
      ).toBe(false);
      expect(
        resolveRegisterDecision({
          signedIn: true,
          offline: false,
          nonPublicHost: label !== null,
        })
      ).toBe(false);
    }
  );

  test.each(FORMS)(
    "%s: the smart audit lists the private-target rules as not applicable",
    (url) => {
      const ids = privateTargetRuleIds(url);
      for (const id of SMART_ONLY_GATED) expect(ids.has(id)).toBe(true);
      expect(ids.size).toBeGreaterThan(5);
    }
  );

  test("a public literal is publishable and a smart audit applies every rule", () => {
    for (const url of [
      "https://93.184.216.34/",
      "https://[2606:4700::1111]/",
    ]) {
      const label = nonPublicHostLabel(url);
      expect(label).toBeNull();
      expect(
        resolvePublishDecision({
          signedIn: true,
          offline: false,
          explicitPublish: false,
          noPublish: false,
          configPublish: true,
          nonPublicHost: false,
        })
      ).toBe(true);
      expect(privateTargetRuleIds(url).size).toBe(0);
    }
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
