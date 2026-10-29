// What the start URL's redirect chain means for a run (#1281): same-site is
// silent, another site needs consent, and nothing else is followed.

import type { SeedRedirectResolution } from "@squirrelscan/core-contracts/seed-redirect";

import { describe, expect, test } from "bun:test";

import {
  decideStartRedirect,
  resolveAuditStart,
  startRedirectPrompt,
} from "@/cli/start-redirect";

// Built at runtime so no credential-shaped literal sits in the file (secret scan).
const USERINFO = ["u", "pw"].join(":");

const cross: SeedRedirectResolution = {
  kind: "cross-domain",
  originalUrl: "https://bit.ly/x",
  finalUrl: "https://example.com/pricing",
  chain: [
    { url: "https://bit.ly/x", status: 301 },
    { url: "https://example.com/pricing", status: 200 },
  ],
};
const same: SeedRedirectResolution = {
  kind: "same-site",
  originalUrl: "http://example.com/",
  finalUrl: "https://www.example.com/",
  chain: [
    { url: "http://example.com/", status: 301 },
    { url: "https://www.example.com/", status: 200 },
  ],
};

describe("decideStartRedirect", () => {
  test("no redirect audits the URL as given", () => {
    const decision = decideStartRedirect(
      {
        kind: "none",
        originalUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        chain: [],
      },
      { follow: false, interactive: false }
    );
    expect(decision).toEqual({ action: "audit", url: "https://example.com/" });
  });

  test("a same-site redirect is followed without a prompt or a flag", () => {
    expect(
      decideStartRedirect(same, { follow: false, interactive: false })
    ).toEqual({
      action: "audit",
      url: "https://www.example.com/",
    });
    // And it leaves no redirect record: the report is of the same site.
  });

  test("a cross-domain redirect on a terminal asks", () => {
    expect(
      decideStartRedirect(cross, { follow: false, interactive: true }).action
    ).toBe("ask");
  });

  test("a cross-domain redirect without a terminal or the flag stops with the outcome", () => {
    const decision = decideStartRedirect(cross, {
      follow: false,
      interactive: false,
    });
    expect(decision.action).toBe("stop");
    if (decision.action !== "stop") return;
    expect(decision.outcome.status).toBe("redirected");
    expect(decision.outcome.finalUrl).toBe("https://example.com/pricing");
    expect(decision.outcome.rerunCommand).toBe(
      "squirrel audit https://bit.ly/x --follow-redirect"
    );
  });

  test("--follow-redirect audits the destination and records the chain", () => {
    const decision = decideStartRedirect(cross, {
      follow: true,
      interactive: false,
    });
    expect(decision).toEqual({
      action: "audit",
      url: "https://example.com/pricing",
      record: { originalUrl: "https://bit.ly/x", redirectChain: cross.chain },
    });
  });

  test("a loop, too many hops or a refused hop is never followed, flag or not", () => {
    for (const kind of ["loop", "too-many", "refused"] as const) {
      const decision = decideStartRedirect(
        { ...cross, kind, refusal: "refused address" },
        { follow: true, interactive: true }
      );
      expect(decision.action).toBe("stop");
    }
  });
});

describe("resolveAuditStart", () => {
  const resolve = async () => cross;

  test("-y is not an input: a non-interactive run without the flag stops", async () => {
    // The caller passes the follow consent and whether it can ask, nothing else:
    // `--yes` approves credit spend and is not read here (pinned end to end in
    // audit-start-redirect-e2e.test.ts).
    const result = await resolveAuditStart({
      url: "https://bit.ly/x",
      follow: false,
      interactive: false,
      resolve,
    });
    expect(result.stop?.status).toBe("redirected");
  });

  test("the prompt names the destination, and Y or Enter accepts", async () => {
    const asked: string[] = [];
    for (const answer of ["", "y", "Yes"]) {
      const result = await resolveAuditStart({
        url: "https://bit.ly/x",
        follow: false,
        interactive: true,
        resolve,
        ask: async (question) => {
          asked.push(question);
          return answer;
        },
      });
      expect(result.stop).toBeUndefined();
      expect(result.url).toBe("https://example.com/pricing");
      expect(result.record?.originalUrl).toBe("https://bit.ly/x");
    }
    expect(asked[0]).toBe(
      "bit.ly/x redirects to https://example.com/pricing. Audit example.com instead? [Y/n] "
    );
  });

  test("declining stops with the redirected outcome naming the final URL", async () => {
    const result = await resolveAuditStart({
      url: "https://bit.ly/x",
      follow: false,
      interactive: true,
      resolve,
      ask: async () => "n",
    });
    expect(result.stop?.finalUrl).toBe("https://example.com/pricing");
  });

  test("the prompt copy", () => {
    expect(startRedirectPrompt(cross)).toBe(
      "bit.ly/x redirects to https://example.com/pricing. Audit example.com instead? [Y/n] "
    );
  });

  test("the re-run command uses the URL the user typed, and nothing printed carries a secret", async () => {
    const typed = "https://bit.ly/x?campaign=mine";
    const resolution: SeedRedirectResolution = {
      kind: "cross-domain",
      originalUrl: typed,
      finalUrl: "https://app.example.com/login",
      chain: [
        { url: "https://bit.ly/x", status: 301 },
        { url: "https://app.example.com/login", status: 200 },
      ],
    };
    const result = await resolveAuditStart({
      url: typed,
      follow: false,
      interactive: false,
      resolve: async () => resolution,
    });
    expect(result.stop?.rerunCommand).toBe(
      "squirrel audit 'https://bit.ly/x?campaign=mine' --follow-redirect"
    );
    expect(result.stop?.originalUrl).toBe("https://bit.ly/x");
    const followed = await resolveAuditStart({
      url: typed,
      follow: true,
      interactive: false,
      resolve: async () => resolution,
    });
    expect(followed.record?.originalUrl).toBe("https://bit.ly/x");
    // The destination's own userinfo, query and fragment are not echoed either.
    const prompt = startRedirectPrompt({
      ...resolution,
      finalUrl: `https://${USERINFO}@app.example.com/login?token=SECRET#IGNORE%20PREVIOUS`,
    });
    expect(prompt).not.toMatch(/SECRET|IGNORE|pw/);
    expect(prompt).toContain("https://app.example.com/login");
    expect(
      startRedirectPrompt({
        ...resolution,
        originalUrl: `https://${USERINFO}@bit.ly/x?t=SECRET`,
      })
    ).not.toMatch(/SECRET|pw/);
  });
});
