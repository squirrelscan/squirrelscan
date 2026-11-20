#!/usr/bin/env bun
/**
 * Release quality gate: reuse a green CI run for the same tree (#1824).
 *
 * release.yml used to re-run the whole suite serially (about 45 min) even when
 * CI had passed on the identical tree a minute earlier: a rebase-merge gives the
 * release commit a new sha but keeps the tree. This script looks for a
 * successful ci.yml run whose tested tree is exactly the tree being released and
 * whose gating jobs all passed. When it finds one, release.yml skips the
 * re-run; when it does not (or anything here goes wrong), release.yml runs every
 * check itself, as parallel jobs.
 *
 * What counts as "tested this tree":
 *
 *   push, merge_group  CI checked out head_sha itself, so head_sha's tree is
 *                      the tested tree.
 *   pull_request       CI checked out a merge of head_sha into the base branch
 *                      tip at trigger time, so head_sha's tree alone proves
 *                      nothing. That merge has head_sha's tree when the base
 *                      tip was an ancestor of head_sha. main is linear, so a
 *                      run created before the release commit was committed saw
 *                      the release commit's parent or an older commit as the
 *                      base tip: if that parent is an ancestor of head_sha, so
 *                      was the base. Both conditions are checked.
 *
 * The tree is also checked against the release checkout's own `git rev-parse
 * HEAD^{tree}`, and against the commit API for every candidate, rather than
 * trusting the run listing alone.
 *
 * Usage (release.yml): bun run scripts/release-ci-reuse.ts
 *   env: GH_TOKEN, REPO (owner/name), SHA (release commit), TREE (its tree)
 * Writes `reused=true|false` and `run_url=` to $GITHUB_OUTPUT. Exits 0 unless
 * its inputs are missing: a lookup failure means "run the checks", never "pass".
 */

import { appendFile } from "node:fs/promises";

/**
 * Jobs a reused run must have finished, and the conclusions accepted for each.
 * Names are ci.yml's job `name:`s.
 *
 * "Audit engine golden tests" may be skipped: its files are a subset of the
 * audit-engine suite that "CLI tests" runs, and ci.yml's classifier skips it on
 * the release bump PR (apps/cli/package.json is not an engine input). "Release
 * tooling tests" may not: it also runs the changelog shell tests, which no bun
 * suite covers, and the bump PR always triggers it.
 */
export const REQUIRED_JOBS: Readonly<Record<string, readonly string[]>> = {
  "Format, lint, and typecheck": ["success"],
  "CLI tests": ["success"],
  "Dependency audit": ["success"],
  "Audit engine golden tests": ["success", "skipped"],
  "Release tooling tests": ["success"],
};

/** Events whose runs can be reused. Anything else (workflow_dispatch, schedule) is ignored. */
const REUSABLE_EVENTS = new Set(["push", "merge_group", "pull_request"]);

export interface WorkflowRun {
  id: number;
  event: string;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  head_commit?: { tree_id?: string } | null;
}

export interface WorkflowJob {
  name: string;
  conclusion: string | null;
}

/** Reasons a run's jobs do not prove the tree passed. Empty means they do. */
export function jobProblems(jobs: WorkflowJob[]): string[] {
  const problems: string[] = [];
  for (const [name, accepted] of Object.entries(REQUIRED_JOBS)) {
    const matching = jobs.filter((j) => j.name === name);
    if (matching.length === 0) {
      problems.push(`job "${name}" is missing`);
      continue;
    }
    for (const job of matching) {
      if (!accepted.includes(job.conclusion ?? "")) {
        problems.push(`job "${name}" concluded ${job.conclusion ?? "without a conclusion"}`);
      }
    }
  }
  return problems;
}

/** Successful CI runs of a reusable event whose listed head tree is `tree`, newest first. */
export function candidateRuns(runs: WorkflowRun[], tree: string): WorkflowRun[] {
  return runs
    .filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion === "success" &&
        REUSABLE_EVENTS.has(r.event) &&
        r.head_commit?.tree_id === tree,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Reads one GitHub REST path and returns its JSON. Throws on a non-2xx. */
export type Api = (path: string) => Promise<unknown>;

export interface Decision {
  reused: boolean;
  run?: WorkflowRun;
  log: string[];
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Find a CI run that already tested `tree`. Never throws: an API error is a
 * "no", so the release runs its own checks.
 */
export async function findReusableRun(opts: {
  repo: string;
  sha: string;
  tree: string;
  api: Api;
}): Promise<Decision> {
  const { repo, sha, tree, api } = opts;
  const log: string[] = [];
  const no = (msg: string): Decision => {
    log.push(msg);
    return { reused: false, log };
  };

  if (!SHA.test(sha) || !SHA.test(tree)) return no(`bad input: sha=${sha} tree=${tree}`);

  try {
    const commit = (await api(`repos/${repo}/commits/${sha}`)) as {
      commit?: { tree?: { sha?: string }; committer?: { date?: string } };
      parents?: { sha: string }[];
    };
    const apiTree = commit.commit?.tree?.sha;
    if (apiTree !== tree) {
      return no(`the API reports tree ${apiTree} for ${sha}, the checkout has ${tree}`);
    }
    const parent = commit.parents?.[0]?.sha;
    const committedAt = Date.parse(commit.commit?.committer?.date ?? "");

    const listing = (await api(
      `repos/${repo}/actions/workflows/ci.yml/runs?status=success&per_page=100`,
    )) as { workflow_runs?: WorkflowRun[] };
    const candidates = candidateRuns(listing.workflow_runs ?? [], tree);
    if (candidates.length === 0) return no(`no successful CI run tested tree ${tree}`);

    for (const run of candidates) {
      const label = `CI run ${run.id} (${run.event} at ${run.head_sha})`;

      const head = (await api(`repos/${repo}/git/commits/${run.head_sha}`)) as {
        tree?: { sha?: string };
      };
      if (head.tree?.sha !== tree) {
        log.push(`${label}: its head commit has tree ${head.tree?.sha}, skipped`);
        continue;
      }

      if (run.event === "pull_request" && run.head_sha !== sha) {
        if (!parent) {
          log.push(`${label}: ${sha} has no parent to prove the tested merge, skipped`);
          continue;
        }
        const createdAt = Date.parse(run.created_at);
        // NaN on either side is unknown, so it refuses rather than passes.
        if (Number.isNaN(createdAt) || Number.isNaN(committedAt) || createdAt > committedAt) {
          log.push(`${label}: created after ${sha} was committed, so its base is unknown; skipped`);
          continue;
        }
        const cmp = (await api(`repos/${repo}/compare/${parent}...${run.head_sha}`)) as {
          status?: string;
        };
        if (cmp.status !== "ahead" && cmp.status !== "identical") {
          log.push(
            `${label}: pull request head is ${cmp.status ?? "unrelated"} to ${parent}, so CI tested a different merge; skipped`,
          );
          continue;
        }
      }

      const jobs = (await api(
        `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      )) as { jobs?: WorkflowJob[] };
      const problems = jobProblems(jobs.jobs ?? []);
      if (problems.length > 0) {
        log.push(`${label}: ${problems.join("; ")}; skipped`);
        continue;
      }

      log.push(`${label} passed every gating job on tree ${tree}: ${run.html_url}`);
      return { reused: true, run, log };
    }
    return no(`no CI run for tree ${tree} passed every gating job`);
  } catch (err) {
    return no(`lookup failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

function githubApi(token: string): Api {
  return async (path) => {
    const res = await fetch(`https://api.github.com/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
  };
}

if (import.meta.main) {
  const { GH_TOKEN, REPO, SHA: sha, TREE, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
  if (!GH_TOKEN || !REPO || !sha || !TREE) {
    console.error("release-ci-reuse: GH_TOKEN, REPO, SHA and TREE are required");
    process.exit(1);
  }
  const decision = await findReusableRun({ repo: REPO, sha, tree: TREE, api: githubApi(GH_TOKEN) });
  for (const line of decision.log) console.log(line);
  const verdict = decision.reused
    ? `Reusing CI run ${decision.run?.html_url}: the test checks are skipped.`
    : "No reusable CI run: every check runs here, in parallel.";
  console.log(verdict);
  if (GITHUB_OUTPUT) {
    await appendFile(
      GITHUB_OUTPUT,
      `reused=${decision.reused}\nrun_url=${decision.run?.html_url ?? ""}\n`,
    );
  }
  if (GITHUB_STEP_SUMMARY) {
    const body = decision.log.map((l) => `- ${l}`).join("\n");
    await appendFile(GITHUB_STEP_SUMMARY, `### Release quality gate\n\n${verdict}\n\n${body}\n`);
  }
}
