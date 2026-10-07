import { describe, expect, test } from "bun:test";
import {
  changesReviewWorkflow,
  classifyPrSize,
  isGeneratedPath,
  positiveIntOr,
} from "./claude-review-size";
import {
  decideVerdict,
  extractDenials,
  FAIL_REASONS,
  extractLastAssistantText,
  extractStats,
  renderPartialComment,
  reviewCommentExists,
  sanitizeForLog,
} from "./claude-review-postmortem";

const limits = { maxFiles: 3, maxLines: 100 };

describe("claude-review size guard", () => {
  test("lockfiles and build output do not count toward the diff budget", () => {
    expect(isGeneratedPath("bun.lock")).toBe(true);
    expect(isGeneratedPath("apps/web/bun.lockb")).toBe(true);
    expect(isGeneratedPath("apps/web/dist/index.js")).toBe(true);
    expect(isGeneratedPath("assets/mascot.svg")).toBe(true);
    expect(isGeneratedPath("apps/api/src/index.ts")).toBe(false);
    // "dist" must be a path segment, not a substring of a real source dir.
    expect(isGeneratedPath("apps/web/src/distance.ts")).toBe(false);
  });

  test("drizzle's meta bookkeeping is generated, but the migration SQL is not", () => {
    // A two-column migration writes an 8000-line whole-schema snapshot; counting
    // it skipped the review of the 1300 lines that actually needed one (#1782).
    expect(isGeneratedPath("apps/api/drizzle/pg-migrations/meta/0063_snapshot.json")).toBe(true);
    expect(isGeneratedPath("apps/api/drizzle/pg-migrations/meta/_journal.json")).toBe(true);
    // apps/status keeps `meta/` directly under `drizzle/`, with no out-dir.
    expect(isGeneratedPath("apps/status/drizzle/meta/0000_snapshot.json")).toBe(true);
    // The SQL is the artefact a human must actually read before merge.
    expect(isGeneratedPath("apps/api/drizzle/pg-migrations/0063_eager_wendell_rand.sql")).toBe(
      false,
    );
    expect(isGeneratedPath("apps/api/src/db/schema.ts")).toBe(false);
  });

  test("a huge lockfile bump is still a small review", () => {
    const verdict = classifyPrSize(
      [
        { filename: "bun.lock", additions: 4000, deletions: 3000 },
        { filename: "package.json", additions: 2, deletions: 1 },
      ],
      limits,
    );
    expect(verdict.tooLarge).toBe(false);
    expect(verdict.reviewedFiles).toBe(1);
    expect(verdict.reviewedLines).toBe(3);
    expect(verdict.generatedFiles).toBe(1);
  });

  test("too many reviewable files trips the guard", () => {
    const files = Array.from({ length: 4 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const verdict = classifyPrSize(files, limits);
    expect(verdict.tooLarge).toBe(true);
    expect(verdict.reason).toContain("4 changed files");
  });

  test("too many reviewable lines trips the guard", () => {
    const verdict = classifyPrSize(
      [{ filename: "src/big.ts", additions: 90, deletions: 20 }],
      limits,
    );
    expect(verdict.tooLarge).toBe(true);
    expect(verdict.reason).toContain("110 changed lines");
  });

  test("an unusable limit falls back instead of disabling the guard", () => {
    // Number("eighty") is NaN, and every comparison against NaN is false.
    expect(positiveIntOr("eighty", 80)).toBe(80);
    expect(positiveIntOr("", 80)).toBe(80);
    expect(positiveIntOr(undefined, 80)).toBe(80);
    expect(positiveIntOr("0", 80)).toBe(80);
    expect(positiveIntOr("-5", 80)).toBe(80);
    expect(positiveIntOr("120", 80)).toBe(120);
  });

  test("missing additions/deletions counts as zero rather than NaN", () => {
    const verdict = classifyPrSize([{ filename: "src/a.ts" }], limits);
    expect(verdict.reviewedLines).toBe(0);
    expect(verdict.tooLarge).toBe(false);
  });
});

const deniedRun = [
  {
    type: "assistant",
    message: { content: [{ type: "text", text: "## Review\n- (high) `a.ts:1` boom" }] },
  },
  {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 56,
    total_cost_usd: 1.65,
    duration_ms: 276000,
    permission_denials: [
      {
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        tool_input: { command: "rg -n 'foo' apps/" },
      },
    ],
  },
];

describe("claude-review post-mortem", () => {
  test("reads denials, stats and partial findings out of the execution log", () => {
    const stats = extractStats(deniedRun);
    expect(stats?.isError).toBe(true);
    expect(stats?.numTurns).toBe(56);
    expect(stats?.denialCount).toBe(1);

    const denials = extractDenials(deniedRun);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.tool).toBe("Bash");
    expect(denials[0]?.input).toContain("rg -n");

    expect(extractLastAssistantText(deniedRun)).toContain("(high)");
  });

  test("falls back to errored tool_results when permission_denials is absent", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "jq ." } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              is_error: true,
              content: "Claude requested permissions to use Bash, but you haven't granted it yet.",
            },
          ],
        },
      },
      { type: "result", subtype: "success", is_error: true, num_turns: 3 },
    ];
    const denials = extractDenials(messages);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.tool).toBe("Bash");
    expect(denials[0]?.input).toContain("jq");
  });

  test("an errored tool_result that is not a denial is ignored", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: "1 test failed" },
          ],
        },
      },
      { type: "result", subtype: "success", is_error: true },
    ];
    expect(extractDenials(messages)).toHaveLength(0);
  });

  test("last assistant text skips trailing tool-only turns", () => {
    const messages = [
      { type: "assistant", message: { content: [{ type: "text", text: "findings" }] } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] },
      },
    ];
    expect(extractLastAssistantText(messages)).toBe("findings");
  });

  test("empty log yields no stats and no crash", () => {
    expect(extractStats([])).toBeUndefined();
    expect(extractDenials([])).toEqual([]);
    expect(extractLastAssistantText([])).toBe("");
  });

  test("workflow commands in model prose are neutralized before logging", () => {
    const zwsp = String.fromCodePoint(0x200b);
    // Bare, indented (the runner parses those too) and the dangerous one.
    for (const line of ["::error::pwned", "   ::error::pwned", "\t::stop-commands::abc"]) {
      const safe = sanitizeForLog(line);
      expect(safe).toContain(zwsp);
      expect(safe.trimStart().startsWith("::")).toBe(false);
    }
    // Multi-line prose: every offending line, not just the first.
    const safe = sanitizeForLog("ok\n::warning::a\n  ::error::b");
    expect(safe.split("\n").filter((l) => l.trimStart().startsWith("::"))).toHaveLength(0);
    // `::` mid-line is ordinary text (C++ scopes, TS types) and stays put.
    expect(sanitizeForLog("std::vector")).toBe("std::vector");
  });

  test("the sanitizer source has no raw zero-width character", async () => {
    // A literal U+200B in the source is invisible in review; it must be \u200B.
    const source = await Bun.file(
      new URL("./claude-review-postmortem.ts", import.meta.url).pathname,
    ).text();
    expect(source.includes(String.fromCodePoint(0x200b))).toBe(false);
  });

  test("the partial comment carries the marker, the denials and the findings", () => {
    const body = renderPartialComment({
      marker: "<!-- claude-auto-review:failed:abc123 -->",
      heading: "Auto-review did not complete",
      reason: "The `claude-review` job failed before posting a review.",
      stats: extractStats(deniedRun),
      denials: extractDenials(deniedRun),
      partial: extractLastAssistantText(deniedRun),
      runUrl: "https://example.test/run/1",
    });
    expect(body.startsWith("<!-- claude-auto-review:failed:abc123 -->")).toBe(true);
    expect(body).toContain("has not been auto-reviewed");
    expect(body).toContain("rg -n");
    expect(body).toContain("(high)");
    expect(body).toContain("https://example.test/run/1");
  });

  test("no recovered findings says so instead of pretending", () => {
    const body = renderPartialComment({
      marker: "<!-- m -->",
      heading: "Auto-review did not complete",
      reason: "The `claude-review` session ended without posting a review.",
      stats: undefined,
      denials: [],
      partial: "",
      runUrl: "https://example.test/run/2",
    });
    expect(body).toContain("No findings were recovered from this run");
    expect(body).toContain("no result message at all");
  });

  test("a lost execution log is reported instead of silence", () => {
    const body = renderPartialComment({
      marker: "<!-- m -->",
      heading: "Auto-review did not complete",
      reason: "The `claude-review` job failed before posting a review.",
      stats: undefined,
      denials: [],
      partial: "",
      runUrl: "https://example.test/run/3",
      logProblem: "no execution log was written (path unknown)",
    });
    expect(body).toContain("no execution log was written");
  });

  test("the rendered comment stays inside GitHub's 65536-char limit", () => {
    const denials = Array.from({ length: 80 }, (_, i) => ({
      tool: "Bash",
      input: JSON.stringify({ command: `x`.repeat(600) + i }),
    }));
    const body = renderPartialComment({
      marker: "<!-- m -->",
      heading: "Auto-review did not complete",
      reason: "The `claude-review` job failed before posting a review.",
      stats: extractStats(deniedRun),
      denials,
      partial: "z".repeat(200000),
      runUrl: "https://example.test/run/4",
    });
    expect(body.length).toBeLessThan(65536);
    expect(body).toContain("60 more denial(s)");
  });
});

describe("claude-review verdict", () => {
  test("a review that landed is green", () => {
    expect(decideVerdict({ outcome: "success", ranModel: true, reviewPosted: true, reviewWorkflowChanged: false })).toEqual({
      shouldFail: false,
      kind: "reviewed",
    });
  });

  test("an errored run that posted first is red, but not 'produced no review'", () => {
    const verdict = decideVerdict({
      outcome: "failure",
      ranModel: true,
      reviewPosted: true,
      reviewWorkflowChanged: false,
    });
    expect(verdict).toEqual({ shouldFail: true, kind: "errored-with-review" });
    expect(FAIL_REASONS[verdict.kind]).toContain("a review was posted");
  });

  test("an errored run that posted nothing says so", () => {
    const verdict = decideVerdict({
      outcome: "failure",
      ranModel: true,
      reviewPosted: false,
      reviewWorkflowChanged: false,
    });
    expect(verdict).toEqual({ shouldFail: true, kind: "errored" });
    expect(FAIL_REASONS[verdict.kind]).toContain("posted no review");
  });

  test("a model that ran and posted nothing is red - the silent miss", () => {
    expect(decideVerdict({ outcome: "success", ranModel: true, reviewPosted: false, reviewWorkflowChanged: false })).toEqual({
      shouldFail: true,
      kind: "posted-nothing",
    });
  });

  test("an action that never started the model is green but reported", () => {
    // Claude's workflow validation skip: expected on PRs that edit this workflow.
    expect(
      decideVerdict({
        outcome: "success",
        ranModel: false,
        reviewPosted: false,
        reviewWorkflowChanged: true,
      }),
    ).toEqual({ shouldFail: false, kind: "never-started" });
  });

  test("an unexplained skip is red, not waved through as the known one", () => {
    expect(
      decideVerdict({
        outcome: "success",
        ranModel: false,
        reviewPosted: false,
        reviewWorkflowChanged: false,
      }),
    ).toEqual({ shouldFail: true, kind: "never-started-unexpected" });
  });

  test("the workflow-edit signal is read off the PR's own file list", () => {
    expect(
      changesReviewWorkflow([{ filename: ".github/workflows/claude-code-review.yml" }]),
    ).toBe(true);
    expect(changesReviewWorkflow([{ filename: ".github/workflows/ci.yml" }])).toBe(false);
  });
});

describe("claude-review posted-comment probe", () => {
  const started = "2026-09-01T12:00:00Z";
  const reviewer = "claude[bot]";

  test("the reviewer's comment posted during the run counts as a review", () => {
    expect(
      reviewCommentExists(
        [{ user: { login: reviewer }, created_at: "2026-09-01T12:03:00Z", body: "## Review" }],
        started,
        reviewer,
      ),
    ).toBe(true);
  });

  test("our own failure comment never counts as a review", () => {
    expect(
      reviewCommentExists(
        [
          {
            user: { login: reviewer },
            created_at: "2026-09-01T12:05:00Z",
            body: "<!-- claude-auto-review:failed:abc -->\n### Auto-review did not complete",
          },
        ],
        started,
        reviewer,
      ),
    ).toBe(false);
  });

  test("a review that merely QUOTES our marker still counts as a review", () => {
    expect(
      reviewCommentExists(
        [
          {
            user: { login: reviewer },
            created_at: "2026-09-01T12:05:00Z",
            body: "## Review\n- (nit) the marker `<!-- claude-auto-review:failed -->` reads oddly",
          },
        ],
        started,
        reviewer,
      ),
    ).toBe(true);
  });

  test("another bot commenting mid-run is not a review", () => {
    expect(
      reviewCommentExists(
        [
          {
            user: { login: "dependabot[bot]" },
            created_at: "2026-09-01T12:04:00Z",
            body: "bumping deps",
          },
        ],
        started,
        reviewer,
      ),
    ).toBe(false);
  });

  test("an older round's review does not count for this run", () => {
    expect(
      reviewCommentExists(
        [{ user: { login: reviewer }, created_at: "2026-09-01T11:00:00Z", body: "## Review" }],
        started,
        reviewer,
      ),
    ).toBe(false);
  });

  test("a human comment mid-run does not stand in for the review", () => {
    expect(
      reviewCommentExists(
        [{ user: { login: "nc9" }, created_at: "2026-09-01T12:04:00Z", body: "looks fine" }],
        started,
        reviewer,
      ),
    ).toBe(false);
  });
});
