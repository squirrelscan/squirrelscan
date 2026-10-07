#!/usr/bin/env bun
/**
 * Post-mortem for .github/workflows/claude-code-review.yml (#1612).
 *
 * claude-code-action hides the tool stream ("full output hidden for security"),
 * so when a review dies mid-session the job log shows only
 * `permission_denials_count: 8` with no way to learn WHAT was denied, and the
 * findings the reviewer had already written are thrown away with the runner.
 *
 * The action does leave the raw SDK message array on disk
 * (`$RUNNER_TEMP/claude-execution-output.json`, also exposed as the step's
 * `execution_file` output). This reads it and:
 *   - prints every permission denial (tool name + input) as a log annotation,
 *   - recovers the last assistant message so the workflow can post it as an
 *     explicitly-marked PARTIAL review instead of posting nothing.
 *
 * Only denials, result stats and Claude's own prose are printed. Tool RESULTS
 * (which can contain repo secrets) never are.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export type Denial = { tool: string; input: string };

export type ResultStats = {
  subtype: string;
  isError: boolean;
  numTurns: number;
  costUsd: number;
  durationMs: number;
  denialCount: number;
};

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null;

/** Zero-width space, as a code point: a raw literal here is unreviewable. */
const ZERO_WIDTH_SPACE = "\u200B";

/**
 * The runner parses a workflow command anywhere on a line after leading
 * whitespace, `::stop-commands::` included, so indentation is not protection.
 * Model prose (and any tool input echoed with it) must never be able to speak
 * to the runner.
 */
export function sanitizeForLog(text: string): string {
  return text.replace(/^([ \t]*)::/gm, `$1${ZERO_WIDTH_SPACE}::`);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

function findResult(messages: readonly unknown[]): Json | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRecord(message) && message.type === "result") return message;
  }
  return undefined;
}

export function extractStats(messages: readonly unknown[]): ResultStats | undefined {
  const result = findResult(messages);
  if (!result) return undefined;
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials.length
    : 0;
  return {
    subtype: String(result.subtype ?? "unknown"),
    isError: result.is_error === true,
    numTurns: Number(result.num_turns ?? 0),
    costUsd: Number(result.total_cost_usd ?? 0),
    durationMs: Number(result.duration_ms ?? 0),
    denialCount: denials,
  };
}

/**
 * Denials come from the result message's `permission_denials`. Older/edge runs
 * that lack it are recovered from the errored tool_result blocks instead.
 */
export function extractDenials(messages: readonly unknown[]): Denial[] {
  const result = findResult(messages);
  const listed = Array.isArray(result?.permission_denials)
    ? (result.permission_denials as unknown[])
    : [];

  if (listed.length > 0) {
    return listed.map((denial) => {
      if (!isRecord(denial)) return { tool: "unknown", input: String(denial) };
      return {
        tool: String(denial.tool_name ?? "unknown"),
        input: truncate(JSON.stringify(denial.tool_input ?? {}), 400),
      };
    });
  }

  // Fallback: pair errored "permission" tool_results back to their tool_use.
  const toolUses = new Map<string, { name: string; input: unknown }>();
  const denials: Denial[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const inner = isRecord(message.message) ? message.message : undefined;
    const content = inner && Array.isArray(inner.content) ? inner.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string") {
        toolUses.set(block.id, {
          name: String(block.name ?? "unknown"),
          input: block.input,
        });
      }
      if (block.type === "tool_result" && block.is_error === true) {
        const text = JSON.stringify(block.content ?? "");
        if (!/permission|not allowed|haven't granted/i.test(text)) continue;
        const use =
          typeof block.tool_use_id === "string"
            ? toolUses.get(block.tool_use_id)
            : undefined;
        denials.push({
          tool: use?.name ?? "unknown",
          input: truncate(JSON.stringify(use?.input ?? {}), 400),
        });
      }
    }
  }
  return denials;
}

/** The reviewer's last prose: the findings it had written when the run died. */
export function extractLastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.type !== "assistant") continue;
    const inner = isRecord(message.message) ? message.message : undefined;
    const content = inner && Array.isArray(inner.content) ? inner.content : [];
    const text = content
      .filter(
        (block): block is Json =>
          isRecord(block) && block.type === "text" && typeof block.text === "string",
      )
      .map((block) => String(block.text))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** GitHub rejects an issue comment over 65536 chars; leave headroom. */
const MAX_COMMENT_CHARS = 60000;
const MAX_RENDERED_DENIALS = 20;

export function renderPartialComment(args: {
  marker: string;
  /** Headline: the session died, or it never started. */
  heading: string;
  /** Why we are commenting: the session errored, or it ended posting nothing. */
  reason: string;
  stats: ResultStats | undefined;
  denials: readonly Denial[];
  partial: string;
  runUrl: string;
  logProblem?: string;
}): string {
  const { marker, heading, reason, stats, denials, partial, runUrl, logProblem } = args;
  const statLine = stats
    ? `\`${stats.subtype}\` / is_error=\`${stats.isError}\` after ${stats.numTurns} turns, ` +
      `${denials.length} permission denial(s), $${stats.costUsd.toFixed(2)}`
    : logProblem || "the run produced no result message at all";

  const shown = denials.slice(0, MAX_RENDERED_DENIALS);
  const elided =
    denials.length > shown.length
      ? `\n… ${denials.length - shown.length} more denial(s) in the job log`
      : "";
  const denialBlock = shown.length
    ? `\n<details><summary>Permission denials (${denials.length})</summary>\n\n\`\`\`\n${shown
        .map((denial) => `${denial.tool} ${truncate(denial.input, 200)}`)
        .join("\n")}${elided}\n\`\`\`\n\n</details>\n`
    : "";

  const head = `${marker}
### ${heading}

${reason} **This PR has not been auto-reviewed.** Run a review manually (\`/review\`) before merging.

- Result: ${statLine}
- [Job log](${runUrl})
${denialBlock}`;

  if (!partial) {
    return `${head}\nNo findings were recovered from this run.\n`;
  }

  const wrapper = `\n**Partial findings recovered from the session** (incomplete, unverified, and NOT a merge signal):\n\n<details><summary>Show partial review</summary>\n\n\n\n</details>\n`;
  // One shared budget: denials + prose together must fit in a GitHub comment.
  const room = MAX_COMMENT_CHARS - head.length - wrapper.length;
  if (room < 500) return `${head}\nFindings were recovered but did not fit in a comment; see the job log.\n`;
  return `${head}\n**Partial findings recovered from the session** (incomplete, unverified, and NOT a merge signal):\n\n<details><summary>Show partial review</summary>\n\n${truncate(partial, room)}\n\n</details>\n`;
}

export type VerdictKind =
  /** A review comment landed during this run. Nothing to do. */
  | "reviewed"
  /** The action errored (is_error, crash, timeout). Red, and salvage findings. */
  | "errored"
  /** It posted a review and THEN errored. Red, but not "produced no review". */
  | "errored-with-review"
  /** The model ran and finished having posted nothing. Red: the silent miss. */
  | "posted-nothing"
  /**
   * The action bailed before running the model, on a PR that edits this
   * workflow. Claude's workflow validation refuses to run while
   * claude-code-review.yml differs from the copy on the default branch: it
   * logs a warning and exits 0. Nothing malfunctioned and no red check on such
   * a PR could ever be cleared, so it is not red; but the PR still has no
   * review, so it does not pass silently either - it gets a comment saying so.
   */
  | "never-started"
  /** Same shape, but with no workflow edit to explain it. Red. */
  | "never-started-unexpected";

export type ReviewVerdict = { shouldFail: boolean; kind: VerdictKind };

/** One line per kind, for the job-log error and nothing else. */
export const FAIL_REASONS: Record<VerdictKind, string> = {
  reviewed: "",
  errored: "the session errored and posted no review",
  "errored-with-review": "a review was posted, but the session then errored",
  "posted-nothing": "the model ran to completion and posted no review",
  "never-started": "",
  "never-started-unexpected":
    "the action exited without starting a review, and nothing in this PR explains it",
};

export function decideVerdict(args: {
  outcome: string;
  ranModel: boolean;
  reviewPosted: boolean;
  /** Does this PR change claude-code-review.yml? Only that explains a skip. */
  reviewWorkflowChanged: boolean;
}): ReviewVerdict {
  // A run that posted a good review and then died is still red, but it did not
  // "produce no review" - saying so would send people looking for the wrong bug.
  if (args.outcome === "failure") {
    return {
      shouldFail: true,
      kind: args.reviewPosted ? "errored-with-review" : "errored",
    };
  }
  if (!args.ranModel) {
    return args.reviewWorkflowChanged
      ? { shouldFail: false, kind: "never-started" }
      : { shouldFail: true, kind: "never-started-unexpected" };
  }
  if (!args.reviewPosted) return { shouldFail: true, kind: "posted-nothing" };
  return { shouldFail: false, kind: "reviewed" };
}

type CommentProbe = { posted: boolean; checked: boolean };

/** Every comment this script posts starts with this; a review never does. */
export const OWN_MARKER_PREFIX = "<!-- claude-auto-review:";

/**
 * Did the reviewer actually leave a comment during this run? A session that
 * ends "successfully" having posted nothing is the #1612 failure mode, and it
 * used to leave the job green with no review anywhere.
 */
export function reviewCommentExists(
  comments: readonly { user?: { login?: string }; created_at?: string; body?: string }[],
  startedAt: string,
  reviewerLogin: string,
): boolean {
  return comments.some((comment) => {
    // Author-exact: another bot commenting mid-run is not a review.
    if ((comment.user?.login ?? "") !== reviewerLogin) return false;
    // Prefix, not substring: a review that quotes our marker is still a review.
    if ((comment.body ?? "").trimStart().startsWith(OWN_MARKER_PREFIX)) return false;
    return (comment.created_at ?? "") >= startedAt;
  });
}

async function probeForReviewComment(startedAt: string): Promise<CommentProbe> {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const pr = process.env.PR_NUMBER ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const reviewer = process.env.REVIEWER_LOGIN || "claude[bot]";
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  if (!repo || !pr || !token || !startedAt) {
    console.log("::warning::Cannot check whether a review was posted: missing inputs");
    return { posted: false, checked: false };
  }

  const url = `${apiUrl}/repos/${repo}/issues/${pr}/comments?per_page=100&since=${encodeURIComponent(startedAt)}`;
  // Three passes so a NEGATIVE answer is confirmed too: a comment posted in the
  // last second of the session may not be readable yet, and a false red here
  // (on a perfectly good review) is exactly what teaches people to ignore the
  // gate. Errors retry for the same reason.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) throw new Error(`comments -> ${response.status}`);
      const comments = (await response.json()) as Parameters<typeof reviewCommentExists>[0];
      const posted = reviewCommentExists(comments, startedAt, reviewer);
      if (posted) return { posted: true, checked: true };
      if (attempt < 3) {
        console.log(
          `No review comment visible yet (attempt ${attempt}); waiting for propagation`,
        );
        await Bun.sleep(5000);
        continue;
      }
      return { posted: false, checked: true };
    } catch (error) {
      console.log(`::warning::Review-delivery check attempt ${attempt} failed (${error})`);
      if (attempt < 3) await Bun.sleep(3000);
    }
  }
  // Unverifiable. "Green" must mean "a review exists", so this goes red - but
  // quietly, without telling the PR something we could not actually confirm.
  return { posted: false, checked: false };
}

async function main(): Promise<void> {
  const executionFile =
    process.env.EXECUTION_FILE ||
    (process.env.RUNNER_TEMP
      ? `${process.env.RUNNER_TEMP}/claude-execution-output.json`
      : "");
  const outcome = process.env.REVIEW_OUTCOME ?? "success";
  const bodyFile = process.env.COMMENT_BODY_FILE ?? "";
  const marker = process.env.COMMENT_MARKER ?? "<!-- claude-auto-review:failed -->";
  const runUrl = process.env.RUN_URL ?? "";

  const setOutput = (key: string, value: string) => {
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  };

  // A missing or unreadable log is not a reason to go quiet: those are the
  // hardest crashes, and the PR still needs to be told it was not reviewed.
  let messages: unknown[] = [];
  let logProblem = "";
  if (!executionFile || !existsSync(executionFile)) {
    logProblem = `no execution log was written (${executionFile || "path unknown"})`;
    console.log(`::warning::${logProblem}`);
  } else {
    try {
      const parsed: unknown = JSON.parse(readFileSync(executionFile, "utf8"));
      messages = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      logProblem = `the execution log could not be parsed (${error})`;
      console.log(`::warning::${logProblem}`);
    }
  }

  const stats = extractStats(messages);
  const denials = extractDenials(messages);

  if (stats) {
    console.log(
      `Claude review result: subtype=${stats.subtype} is_error=${stats.isError} ` +
        `turns=${stats.numTurns} cost=$${stats.costUsd.toFixed(2)} ` +
        `denials=${stats.denialCount} duration=${Math.round(stats.durationMs / 1000)}s`,
    );
  }

  // The whole point of #1612: name every denied tool call in the job log.
  if (denials.length === 0) {
    console.log("Permission denials: none");
  } else {
    console.log(`::group::Permission denials (${denials.length})`);
    for (const denial of denials) {
      console.log(sanitizeForLog(`${denial.tool} ${denial.input}`));
    }
    console.log("::endgroup::");
    console.log(
      `::warning::Claude review hit ${denials.length} permission denial(s): ` +
        sanitizeForLog(
          truncate([...new Set(denials.map((d) => d.tool))].join(", "), 300),
        ) +
        ": widen --allowed-tools in claude-code-review.yml",
    );
  }

  // "The action exited 0" is not the same as "a review exists on the PR".
  const probe = await probeForReviewComment(process.env.REVIEW_STARTED_AT ?? "");
  const verdict = decideVerdict({
    outcome,
    ranModel: messages.length > 0,
    reviewPosted: probe.posted,
    reviewWorkflowChanged: process.env.REVIEW_WORKFLOW_CHANGED === "true",
  });
  const failed = outcome === "failure";
  const neverStarted =
    verdict.kind === "never-started" || verdict.kind === "never-started-unexpected";
  console.log(
    `Review outcome=${outcome}; model ran=${messages.length > 0}; ` +
      `comment posted during this run=${probe.posted}` +
      (probe.checked ? "" : " (unverified)") +
      ` => ${verdict.kind}`,
  );

  setOutput("should_fail", String(verdict.shouldFail));
  setOutput(
    "fail_reason",
    verdict.shouldFail ? FAIL_REASONS[verdict.kind] || "did not produce a review" : "",
  );

  // A skip is unconditional for this PR, so the explanation is owed even in the
  // (near-impossible) case where some claude[bot] comment landed in the window.
  if (probe.posted && !neverStarted) {
    // Something is on the PR already (even if the run then errored); do not
    // tell the reader it was not reviewed. The job can still go red above.
    setOutput("has_comment", "false");
    return;
  }

  if (!probe.checked && !failed && !neverStarted) {
    // The action exited 0 and we could not confirm delivery either way. Go red
    // (above) but say nothing on the PR: "not reviewed" might simply be wrong.
    // When the action DID fail we still comment - the findings are worth more
    // than the small chance the reviewer posted on its way out.
    console.log(
      "::error::Could not verify that a review was posted; failing the check rather than assuming.",
    );
    setOutput("has_comment", "false");
    return;
  }

  const partial = extractLastAssistantText(messages);
  if (partial) {
    console.log("::group::Partial review recovered from the session");
    console.log(sanitizeForLog(truncate(partial, 20000)));
    console.log("::endgroup::");
  }

  const heading = neverStarted ? "Auto-review did not run" : "Auto-review did not complete";
  const reason =
    verdict.kind === "never-started"
      ? "The `claude-review` action exited before starting a review, because this PR changes `.github/workflows/claude-code-review.yml`: Claude's workflow validation refuses to run while that file differs from the copy on `main`, and it exits 0 with only a log warning (grep the job log for `workflow validation`). The check is left green because nothing malfunctioned and merging is the only way to clear it."
      : verdict.kind === "never-started-unexpected"
        ? "The `claude-review` action exited before starting a review and wrote no session log at all, with nothing in this PR to explain it (it does not touch the review workflow). Check the job log for an auth or startup failure."
        : failed
          ? "The `claude-review` job failed before posting a review."
          : "The `claude-review` session ended without posting a review.";
  const body = renderPartialComment({
    marker,
    heading,
    reason,
    stats,
    denials,
    partial,
    runUrl,
    logProblem,
  });
  if (bodyFile) {
    writeFileSync(bodyFile, body);
    setOutput("has_comment", "true");
  } else {
    setOutput("has_comment", "false");
  }
}

if (import.meta.main) {
  await main();
}
