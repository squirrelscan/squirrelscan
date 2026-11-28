// release.yml's quality gate reuses a green CI run only when it provably
// tested the release tree (#1824). These pin each refusal as well as the reuse.

import { describe, expect, test } from "bun:test";

import {
  type Api,
  candidateRuns,
  findReusableRun,
  jobProblems,
  REQUIRED_JOBS,
  type WorkflowJob,
  type WorkflowRun,
} from "./release-ci-reuse";

const REPO = "squirrelscan/squirrelscan";
const SHA = "a".repeat(40); // the release commit
const PARENT = "b".repeat(40); // its parent on main
const TREE = "c".repeat(40);
const OTHER_TREE = "d".repeat(40);
const PR_HEAD = "e".repeat(40);
const COMMITTED = "2026-11-20T04:21:00Z";

function greenJobs(): WorkflowJob[] {
  return Object.keys(REQUIRED_JOBS).map((name) => ({ name, conclusion: "success" }));
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    event: "pull_request",
    head_sha: PR_HEAD,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/x/runs/1",
    created_at: "2026-11-20T04:00:00Z",
    head_commit: { tree_id: TREE },
    ...over,
  };
}

/** A fake GitHub API: every lookup the script makes, answerable per test. */
function fakeApi(o: {
  runs: WorkflowRun[];
  jobs?: WorkflowJob[];
  compare?: string;
  apiTree?: string;
  headTree?: string;
  fail?: boolean;
}): { api: Api; calls: string[] } {
  const calls: string[] = [];
  const api: Api = async (path) => {
    calls.push(path);
    if (o.fail) throw new Error("HTTP 502");
    if (path === `repos/${REPO}/commits/${SHA}`) {
      return {
        commit: { tree: { sha: o.apiTree ?? TREE }, committer: { date: COMMITTED } },
        parents: [{ sha: PARENT }],
      };
    }
    if (path.startsWith(`repos/${REPO}/actions/workflows/ci.yml/runs`)) {
      return { workflow_runs: o.runs };
    }
    if (path.startsWith(`repos/${REPO}/git/commits/`)) return { tree: { sha: o.headTree ?? TREE } };
    if (path.startsWith(`repos/${REPO}/compare/`)) return { status: o.compare ?? "ahead" };
    if (path.includes("/jobs")) return { jobs: o.jobs ?? greenJobs() };
    throw new Error(`unexpected ${path}`);
  };
  return { api, calls };
}

const decide = (api: Api) => findReusableRun({ repo: REPO, sha: SHA, tree: TREE, api });

describe("findReusableRun", () => {
  test("reuses a green pull request run whose head has the tree and descends from the parent", async () => {
    const { api, calls } = fakeApi({ runs: [run()] });
    const d = await decide(api);
    expect(d.reused).toBe(true);
    expect(d.run?.id).toBe(1);
    expect(calls).toContain(`repos/${REPO}/compare/${PARENT}...${PR_HEAD}`);
  });

  test("reuses a push run at the release sha without an ancestry check", async () => {
    const { api, calls } = fakeApi({
      runs: [run({ event: "push", head_sha: SHA })],
      compare: "diverged",
    });
    expect((await decide(api)).reused).toBe(true);
    expect(calls.some((c) => c.includes("/compare/"))).toBe(false);
  });

  test("does not reuse a run of a different tree", async () => {
    const { api } = fakeApi({ runs: [run({ head_commit: { tree_id: OTHER_TREE } })] });
    expect((await decide(api)).reused).toBe(false);
  });

  test("does not reuse when the run's head commit does not have the tree", async () => {
    const { api } = fakeApi({ runs: [run()], headTree: OTHER_TREE });
    expect((await decide(api)).reused).toBe(false);
  });

  test("does not reuse when the checkout's tree disagrees with the API", async () => {
    const { api, calls } = fakeApi({ runs: [run()], apiTree: OTHER_TREE });
    expect((await decide(api)).reused).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("does not reuse a pull request run whose head does not descend from the parent", async () => {
    const { api } = fakeApi({ runs: [run()], compare: "diverged" });
    expect((await decide(api)).reused).toBe(false);
  });

  test("does not reuse a pull request run created after the release commit", async () => {
    const { api } = fakeApi({ runs: [run({ created_at: "2026-11-20T04:22:00Z" })] });
    expect((await decide(api)).reused).toBe(false);
  });

  test("does not reuse a run whose CLI tests were skipped", async () => {
    const jobs = greenJobs().map((j) =>
      j.name === "CLI tests" ? { ...j, conclusion: "skipped" } : j,
    );
    const { api } = fakeApi({ runs: [run()], jobs });
    expect((await decide(api)).reused).toBe(false);
  });

  test("falls through a rejected run to an older one that qualifies", async () => {
    const newer = run({ id: 2, created_at: "2026-11-20T04:10:00Z", event: "push", head_sha: SHA });
    const older = run({ id: 1 });
    let jobCalls = 0;
    const { api: base } = fakeApi({ runs: [older, newer] });
    const api: Api = async (path) => {
      if (path.includes("/runs/2/jobs")) {
        jobCalls++;
        return { jobs: greenJobs().filter((j) => j.name !== "Dependency audit") };
      }
      return base(path);
    };
    const d = await decide(api);
    expect(jobCalls).toBe(1);
    expect(d.reused).toBe(true);
    expect(d.run?.id).toBe(1);
  });

  test("an API failure means run the checks, not pass", async () => {
    const { api } = fakeApi({ runs: [run()], fail: true });
    const d = await decide(api);
    expect(d.reused).toBe(false);
    expect(d.log.join("\n")).toContain("lookup failed");
  });

  test("rejects a malformed sha or tree before calling the API", async () => {
    const { api, calls } = fakeApi({ runs: [run()] });
    const d = await findReusableRun({ repo: REPO, sha: "main", tree: TREE, api });
    expect(d.reused).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("jobProblems", () => {
  test("accepts every gating job green", () => {
    expect(jobProblems(greenJobs())).toEqual([]);
  });

  test("accepts a skipped engine golden job, which CLI tests covers", () => {
    const jobs = greenJobs().map((j) =>
      j.name === "Audit engine golden tests" ? { ...j, conclusion: "skipped" } : j,
    );
    expect(jobProblems(jobs)).toEqual([]);
  });

  test("rejects a skipped release tooling job: its shell tests run nowhere else", () => {
    const jobs = greenJobs().map((j) =>
      j.name === "Release tooling tests" ? { ...j, conclusion: "skipped" } : j,
    );
    expect(jobProblems(jobs)).toEqual(['job "Release tooling tests" concluded skipped']);
  });

  test("rejects a missing job", () => {
    expect(jobProblems(greenJobs().filter((j) => j.name !== "CLI tests"))).toEqual([
      'job "CLI tests" is missing',
    ]);
  });
});

describe("candidateRuns", () => {
  test("keeps only completed successful runs of push, merge_group or pull_request, newest first", () => {
    const runs = [
      run({ id: 1, created_at: "2026-11-20T01:00:00Z" }),
      run({ id: 2, created_at: "2026-11-20T03:00:00Z", event: "merge_group" }),
      run({ id: 3, conclusion: "failure" }),
      run({ id: 4, event: "workflow_dispatch" }),
      run({ id: 5, status: "in_progress", conclusion: null }),
      run({ id: 6, head_commit: null }),
    ];
    expect(candidateRuns(runs, TREE).map((r) => r.id)).toEqual([2, 1]);
  });
});

test("REQUIRED_JOBS names jobs that exist in ci.yml", async () => {
  const ci = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  const names = [...ci.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1]?.trim());
  for (const job of Object.keys(REQUIRED_JOBS)) expect(names).toContain(job);
});
