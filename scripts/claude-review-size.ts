#!/usr/bin/env bun
/**
 * Diff-size guard for .github/workflows/claude-code-review.yml (#1612).
 *
 * The auto-reviewer burns turns (and dollars) proportional to the diff it has
 * to read, and on a big enough PR it dies mid-session and posts nothing. This
 * classifies the PR first so the workflow can say "too large, review it
 * manually" instead of paying for a review that never arrives.
 *
 * Lockfiles and other generated artefacts do not count: a PR that is 4000 lines
 * of `bun.lock` and 40 lines of code is a small review.
 *
 * Fails OPEN: any error resolves to "not too large" so a broken guard degrades
 * to today's behaviour rather than silently disabling every review.
 */

import { appendFileSync } from "node:fs";

export type PrFile = {
  filename: string;
  additions?: number;
  deletions?: number;
};

export type SizeLimits = { maxFiles: number; maxLines: number };

export type SizeVerdict = {
  tooLarge: boolean;
  reviewedFiles: number;
  reviewedLines: number;
  generatedFiles: number;
  /** Human-readable reason, empty when the PR is reviewable. */
  reason: string;
};

/** Paths whose bytes no reviewer reads: lockfiles, build output, binaries. */
const GENERATED_PATTERNS: RegExp[] = [
  /(^|\/)bun\.lockb?$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)(dist|build|out)\//,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  // drizzle-kit's migration bookkeeping. The `.sql` beside it IS reviewable and
  // stays counted; `meta/NNNN_snapshot.json` is a whole-schema dump that a
  // two-column migration inflates by 8000 lines, which was enough on its own to
  // push a PR past the budget and skip the review of the code that mattered.
  /(^|\/)drizzle\/(.+\/)?meta\//,
  /\.min\.(js|css)$/,
  /\.generated\.[A-Za-z0-9]+$/,
  /\.(svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|pdf|mp4|webm|zip|wasm)$/i,
];

export function isGeneratedPath(filename: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(filename));
}

/** This workflow's own file. Editing it makes Claude refuse to run (see below). */
export const REVIEW_WORKFLOW_PATH = ".github/workflows/claude-code-review.yml";

/**
 * Claude's OIDC token exchange rejects a run whose copy of this workflow file
 * differs from the default branch ("Workflow validation failed"), so a PR that
 * edits it can never be auto-reviewed. The post-mortem needs to know that to
 * tell an expected skip apart from a broken one.
 */
export function changesReviewWorkflow(files: readonly PrFile[]): boolean {
  return files.some((file) => file.filename === REVIEW_WORKFLOW_PATH);
}

/**
 * A typo'd limit (`MAX_REVIEW_FILES: eighty`) must not become NaN: every
 * comparison against NaN is false, which would silently disable the guard.
 */
export function positiveIntOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (raw !== undefined) {
      console.log(`::warning::Ignoring unusable review limit "${raw}"; using ${fallback}`);
    }
    return fallback;
  }
  return Math.floor(parsed);
}

export function classifyPrSize(
  files: readonly PrFile[],
  limits: SizeLimits,
): SizeVerdict {
  let reviewedFiles = 0;
  let reviewedLines = 0;
  let generatedFiles = 0;

  for (const file of files) {
    if (isGeneratedPath(file.filename)) {
      generatedFiles++;
      continue;
    }
    reviewedFiles++;
    reviewedLines += (file.additions ?? 0) + (file.deletions ?? 0);
  }

  const reasons: string[] = [];
  if (reviewedFiles > limits.maxFiles) {
    reasons.push(`${reviewedFiles} changed files (limit ${limits.maxFiles})`);
  }
  if (reviewedLines > limits.maxLines) {
    reasons.push(`${reviewedLines} changed lines (limit ${limits.maxLines})`);
  }

  return {
    tooLarge: reasons.length > 0,
    reviewedFiles,
    reviewedLines,
    generatedFiles,
    reason: reasons.join(" and "),
  };
}

/** GitHub caps the files endpoint at 3000 files / 30 pages of 100. */
const MAX_PAGES = 30;

export async function fetchPrFiles(
  repo: string,
  prNumber: string,
  token: string,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
): Promise<PrFile[]> {
  const files: PrFile[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetch(
      `${apiUrl}/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `GET /pulls/${prNumber}/files page ${page} -> ${response.status}`,
      );
    }
    const batch = (await response.json()) as PrFile[];
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

function writeOutputs(values: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  // Single-line values only: GITHUB_OUTPUT needs heredoc framing for newlines.
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value.replace(/\r?\n/g, " ")}`)
    .join("\n");
  console.log(lines);
  // Append: the step may write outputs more than once and other steps share the file.
  if (outputPath) appendFileSync(outputPath, `${lines}\n`);
}

async function main(): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const limits: SizeLimits = {
    maxFiles: positiveIntOr(process.env.MAX_REVIEW_FILES, 80),
    maxLines: positiveIntOr(process.env.MAX_REVIEW_LINES, 6000),
  };

  // Unknown is NOT "no": a false `review_workflow_changed` only ever makes the
  // post-mortem stricter (an unexplained skip goes red instead of green).
  if (!repo || !prNumber || !token) {
    console.log("::warning::claude-review size guard missing inputs; failing open");
    writeOutputs({ too_large: "false", summary: "", review_workflow_changed: "false" });
    return;
  }

  let verdict: SizeVerdict;
  let workflowChanged = false;
  try {
    const files = await fetchPrFiles(repo, prNumber, token);
    verdict = classifyPrSize(files, limits);
    workflowChanged = changesReviewWorkflow(files);
  } catch (error) {
    console.log(`::warning::claude-review size guard failed (${error}); failing open`);
    writeOutputs({ too_large: "false", summary: "", review_workflow_changed: "false" });
    return;
  }

  const summary =
    `${verdict.reviewedFiles} reviewable files, ${verdict.reviewedLines} changed lines ` +
    `(${verdict.generatedFiles} generated files ignored)`;
  console.log(summary);
  if (workflowChanged) {
    console.log(
      `::warning::This PR changes ${REVIEW_WORKFLOW_PATH}, so Claude will refuse to run until it is on main`,
    );
  }

  writeOutputs({
    too_large: String(verdict.tooLarge),
    summary,
    reason: verdict.reason,
    review_workflow_changed: String(workflowChanged),
  });
}

if (import.meta.main) {
  await main();
}
