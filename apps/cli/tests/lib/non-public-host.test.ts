import { nonPublicHostLabel as sharedNonPublicHostLabel } from "@squirrelscan/utils/non-public-host";
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
