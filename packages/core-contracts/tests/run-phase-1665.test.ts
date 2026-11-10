// Run status `queued` and the visible run phase (#1665).

import { describe, expect, test } from "bun:test";

import {
  isRunNotice,
  isRunPhase,
  nextVisiblePhase,
  RUN_NOTICES,
  RUN_PHASES,
  TERMINAL_AGENT_RUN_STATUSES,
  type AgentRunStatus,
  type RunPhase,
  type RunSyncDelta,
} from "../src/index";

describe("AgentRunStatus", () => {
  test("queued is a status, and it is not terminal", () => {
    const status: AgentRunStatus = "queued";
    expect(TERMINAL_AGENT_RUN_STATUSES.has(status)).toBe(false);
  });

  test("the terminal statuses are exactly the three that were", () => {
    expect([...TERMINAL_AGENT_RUN_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"]);
  });

  test("every non-terminal status is not terminal", () => {
    for (const s of ["queued", "pending", "running"] satisfies AgentRunStatus[]) {
      expect(TERMINAL_AGENT_RUN_STATUSES.has(s), s).toBe(false);
    }
  });

  test("a sync delta takes queued and a typed phase", () => {
    const delta: RunSyncDelta = { status: "queued", phase: null };
    const next: RunSyncDelta = { status: "running", phase: "crawling" };
    expect([delta.status, next.phase]).toEqual(["queued", "crawling"]);
  });
});

describe("RunPhase and RunNotice", () => {
  test("the two lists are disjoint", () => {
    for (const phase of RUN_PHASES) expect(isRunNotice(phase), phase).toBe(false);
    for (const notice of RUN_NOTICES) expect(isRunPhase(notice), notice).toBe(false);
  });

  test("the notices named in the issue are notices", () => {
    expect(isRunNotice("memory_pressure")).toBe(true);
    expect(isRunNotice("crawl_scope")).toBe(true);
  });

  test("the guards reject anything that is not a string in the list", () => {
    for (const v of [null, undefined, 3, {}, "", "Crawling", "crawling "]) {
      expect(isRunPhase(v), String(v)).toBe(false);
    }
  });
});

describe("nextVisiblePhase", () => {
  const table: Array<[string, RunPhase | null, string | null | undefined, RunPhase | null]> = [
    ["a phase replaces nothing", null, "crawling", "crawling"],
    ["a phase replaces the current phase", "crawling", "rules", "rules"],
    ["the same phase stays", "rules", "rules", "rules"],
    ["a notice does not overwrite the phase", "crawling", "memory_pressure", "crawling"],
    ["the other notice does not either", "cloud", "crawl_scope", "cloud"],
    ["a notice with no phase yet shows no phase", null, "memory_pressure", null],
    ["an unknown stage name leaves the phase alone", "rules", "editor_summary", "rules"],
    ["null leaves the phase alone", "rules", null, "rules"],
    ["undefined leaves the phase alone", "rules", undefined, "rules"],
    ["an empty string leaves the phase alone", "rules", "", "rules"],
    ["complete is a phase", "rules", "complete", "complete"],
  ];
  for (const [name, current, incoming, expected] of table) {
    test(name, () => {
      expect(nextVisiblePhase(current, incoming)).toBe(expected);
    });
  }

  test("every phase is reachable from every other phase", () => {
    for (const from of RUN_PHASES) for (const to of RUN_PHASES) expect(nextVisiblePhase(from, to)).toBe(to);
  });
});
