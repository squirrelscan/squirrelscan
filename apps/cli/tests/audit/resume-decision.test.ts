// One resume decision for audit and crawl (#1658).
//
// The characterization half pins the decision the old inline logic made: `oldShouldResume` below
// is a copy of the predicate both controllers carried, and every combination of status, flags,
// config and lease must agree with it. The reason half pins what the old code never said out loud.

import type {
  CrawlMetadata,
  CrawlStatus,
  CrawlerConfigSnapshot,
} from "@squirrelscan/core-contracts";
import type { CrawlLeaseClaim } from "@squirrelscan/crawler";

import { describe, expect, test } from "bun:test";

import {
  decideResume,
  formatResumeRefusal,
  isDirtyConfig,
  resumeOutcome,
  type ResumeDecision,
} from "@/audit/resume-decision";

const baseConfig = {
  include: [],
  exclude: [],
  allowedDomains: [],
  allowQueryParams: [],
  dropQueryPrefixes: [],
} as unknown as CrawlerConfigSnapshot;
const changedConfig = {
  ...baseConfig,
  exclude: ["/private"],
} as CrawlerConfigSnapshot;

function crawl(
  status: CrawlStatus,
  extra: Partial<CrawlMetadata> = {}
): CrawlMetadata {
  return {
    id: "crawl-1",
    baseUrl: "https://example.com",
    startedAt: 1,
    status,
    config: baseConfig,
    stats: {},
    ...extra,
  } as unknown as CrawlMetadata;
}

const ACQUIRED: CrawlLeaseClaim = { acquired: true };
const HELD: CrawlLeaseClaim = {
  acquired: false,
  ownerPid: 4242,
  ownerHost: "worker-a",
};
const UNKNOWN: CrawlLeaseClaim = { acquired: false };

// The predicate both controllers inlined before #1658, with its lease claim taken only when the
// other gates passed.
function oldShouldResume(
  existing: CrawlMetadata | null,
  refresh: boolean,
  config: Partial<CrawlerConfigSnapshot>,
  claim: CrawlLeaseClaim
): boolean {
  const candidate =
    !!existing &&
    !refresh &&
    (existing.status === "running" ||
      existing.status === "paused" ||
      existing.status === "stopped") &&
    !isDirtyConfig(existing.config, config);
  return candidate && claim.acquired === true;
}

const STATUSES: CrawlStatus[] = [
  "running",
  "paused",
  "crawled",
  "analyzed",
  "completed",
  "stopped",
  "failed",
];

describe("decideResume keeps the old yes/no decision", () => {
  test("every status x refresh x config x lease combination agrees with the old predicate", () => {
    for (const existing of [null, ...STATUSES.map((s) => crawl(s))]) {
      for (const refresh of [false, true]) {
        for (const config of [baseConfig, changedConfig]) {
          for (const claim of [ACQUIRED, HELD, UNKNOWN]) {
            const decision = decideResume({
              existingCrawl: existing,
              crawlerConfig: config,
              refresh,
              claim: () => claim,
            });
            expect(
              decision.resume,
              `${existing?.status} refresh=${refresh} dirty=${config === changedConfig} ${JSON.stringify(claim)}`
            ).toBe(oldShouldResume(existing, refresh, config, claim));
          }
        }
      }
    }
  });

  test("the lease is claimed only when every other gate passed", () => {
    let claims = 0;
    const claim = () => {
      claims++;
      return ACQUIRED;
    };
    decideResume({
      existingCrawl: null,
      crawlerConfig: baseConfig,
      refresh: false,
      claim,
    });
    decideResume({
      existingCrawl: crawl("analyzed"),
      crawlerConfig: baseConfig,
      refresh: false,
      claim,
    });
    decideResume({
      existingCrawl: crawl("running"),
      crawlerConfig: changedConfig,
      refresh: false,
      claim,
    });
    decideResume({
      existingCrawl: crawl("running"),
      crawlerConfig: baseConfig,
      refresh: true,
      claim,
    });
    expect(claims).toBe(0);
    decideResume({
      existingCrawl: crawl("running"),
      crawlerConfig: baseConfig,
      refresh: false,
      claim,
    });
    expect(claims).toBe(1);
  });
});

describe("decideResume names why it did not resume", () => {
  const decide = (
    existing: CrawlMetadata | null,
    over: {
      refresh?: boolean;
      config?: CrawlerConfigSnapshot;
      claim?: CrawlLeaseClaim;
    } = {}
  ) =>
    decideResume({
      existingCrawl: existing,
      crawlerConfig: over.config ?? baseConfig,
      refresh: over.refresh ?? false,
      claim: () => over.claim ?? ACQUIRED,
    });

  const table: Array<[string, ResumeDecision, string]> = [
    ["no prior crawl", decide(null), "no-prior-crawl"],
    ["finished: crawled", decide(crawl("crawled")), "crawl-finished"],
    ["finished: analyzed", decide(crawl("analyzed")), "crawl-finished"],
    ["finished: completed", decide(crawl("completed")), "crawl-finished"],
    ["failed", decide(crawl("failed")), "crawl-failed"],
    [
      "dirty config",
      decide(crawl("running"), { config: changedConfig }),
      "config-changed",
    ],
    [
      "lease held by a live process",
      decide(crawl("paused"), { claim: HELD }),
      "lease-held",
    ],
    [
      "lease cannot be established",
      decide(crawl("paused"), { claim: UNKNOWN }),
      "lease-unavailable",
    ],
    [
      "store reclaimed",
      decide(crawl("running", { retiredAt: 5 }), {}),
      "reclaimed",
    ],
    [
      "refresh",
      decide(crawl("running"), { refresh: true }),
      "refresh-requested",
    ],
  ];

  for (const [name, decision, reason] of table) {
    test(`${name} -> ${reason}`, () => {
      expect(decision.resume).toBe(false);
      if (!decision.resume) {
        expect(decision.reason).toBe(reason as typeof decision.reason);
        expect(decision.message.length).toBeGreaterThan(0);
        expect(formatResumeRefusal(decision)).toContain(`(${reason})`);
        expect(formatResumeRefusal(decision)).toContain("starting a new crawl");
      }
    });
  }

  test("a running crawl whose data was reclaimed is refused as reclaimed (the one intended change from the old predicate)", () => {
    for (const status of ["running", "paused", "stopped"] as const) {
      const d = decide(crawl(status, { retiredAt: 5 }));
      expect(d.resume).toBe(false);
      expect(!d.resume && d.reason).toBe("reclaimed");
    }
  });

  test("running, paused and stopped crawls resume", () => {
    for (const status of ["running", "paused", "stopped"] as const) {
      expect(decide(crawl(status))).toEqual({ resume: true });
    }
  });

  test("the lease message names the live owner", () => {
    const d = decide(crawl("running"), { claim: HELD });
    expect(!d.resume && d.message).toBe(
      "crawl crawl-1 is active in pid 4242 on worker-a"
    );
    const u = decide(crawl("running"), { claim: UNKNOWN });
    expect(!u.resume && u.message).toBe(
      "ownership of crawl crawl-1 could not be established"
    );
  });

  test("a finished crawl names its status", () => {
    const d = decide(crawl("analyzed"));
    expect(!d.resume && d.message).toContain("(analyzed)");
  });

  test("the report outcome carries requested, resumed and the reason", () => {
    expect(resumeOutcome({ resume: true })).toEqual({
      requested: true,
      resumed: true,
    });
    const refused = decide(crawl("analyzed"));
    expect(resumeOutcome(refused)).toEqual({
      requested: true,
      resumed: false,
      reason: "crawl-finished",
      message: !refused.resume ? refused.message : "",
    });
  });
});

describe("isDirtyConfig", () => {
  test("only scope fields count", () => {
    expect(isDirtyConfig(baseConfig, baseConfig)).toBe(false);
    expect(isDirtyConfig(baseConfig, changedConfig)).toBe(true);
    expect(
      isDirtyConfig(baseConfig, {
        ...baseConfig,
        maxPages: 5,
      } as Partial<CrawlerConfigSnapshot>)
    ).toBe(false);
  });
});

describe("a targeted run and --resume (#1777)", () => {
  const targeted = (urls: string[]) =>
    ({ ...baseConfig, targetUrls: urls }) as CrawlerConfigSnapshot;
  const decide = (stored: CrawlerConfigSnapshot, now: CrawlerConfigSnapshot) =>
    decideResume({
      existingCrawl: crawl("paused", { config: stored }),
      crawlerConfig: now,
      refresh: false,
      claim: () => ACQUIRED,
    });

  test("a normal crawl is not resumed by a targeted run", () => {
    const d = decide(baseConfig, targeted(["https://example.com/pricing"]));
    expect(d).toMatchObject({ resume: false, reason: "config-changed" });
  });

  test("a targeted crawl is not resumed by a normal run", () => {
    const d = decide(targeted(["https://example.com/pricing"]), baseConfig);
    expect(d).toMatchObject({ resume: false, reason: "config-changed" });
  });

  test("a targeted crawl is not resumed under a different list", () => {
    const d = decide(
      targeted(["https://example.com/pricing"]),
      targeted(["https://example.com/pricing", "https://example.com/about"])
    );
    expect(d).toMatchObject({ resume: false, reason: "config-changed" });
  });

  test("the same list resumes", () => {
    const list = ["https://example.com/pricing"];
    expect(decide(targeted(list), targeted([...list]))).toEqual({
      resume: true,
    });
  });
});
