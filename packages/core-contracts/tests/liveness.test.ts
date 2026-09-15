// #2112: the liveness rule a cloud audit is terminated by. These numbers are
// consumed by three things that cannot import each other — the container's
// watchdog, the API's reaper, and the failure-reason copy — so the contract is
// the only place they agree, and these tests pin the properties each of them
// relies on rather than the literals themselves.

import { describe, expect, test } from "bun:test";

import {
  AUDIT_LIVENESS_PHASES,
  AUDIT_RUNTIME,
  MAX_STALL_WINDOW_MS,
  stallWindowForPhaseMs,
} from "../src/limits";

describe("stall windows", () => {
  test("every declared phase has a window", () => {
    for (const phase of AUDIT_LIVENESS_PHASES) {
      expect(AUDIT_RUNTIME.stallWindowMsByPhase[phase]).toBeGreaterThan(0);
    }
    expect(Object.keys(AUDIT_RUNTIME.stallWindowMsByPhase).sort()).toEqual(
      [...AUDIT_LIVENESS_PHASES].sort(),
    );
  });

  test("an unknown phase fails OPEN to the longest window", () => {
    // The direction matters more than the number. A phase this build does not
    // recognize means the caller is newer than the contract, not that the run is
    // stuck, and killing a healthy audit is the expensive mistake.
    expect(stallWindowForPhaseMs("a-phase-from-the-future")).toBe(MAX_STALL_WINDOW_MS);
    expect(stallWindowForPhaseMs(undefined)).toBe(MAX_STALL_WINDOW_MS);
    expect(stallWindowForPhaseMs(null)).toBe(MAX_STALL_WINDOW_MS);
    expect(stallWindowForPhaseMs("")).toBe(MAX_STALL_WINDOW_MS);
  });

  test("a prototype key is not a phase", () => {
    // `Object.hasOwn`, not `in`: the phase reaches this as a string off a stored
    // run record, and a plain membership test also answers yes for these.
    expect(stallWindowForPhaseMs("toString")).toBe(MAX_STALL_WINDOW_MS);
    expect(stallWindowForPhaseMs("constructor")).toBe(MAX_STALL_WINDOW_MS);
  });

  test("a known phase gets its own window", () => {
    expect(stallWindowForPhaseMs("crawl")).toBe(AUDIT_RUNTIME.stallWindowMsByPhase.crawl);
    expect(stallWindowForPhaseMs("rules")).toBe(AUDIT_RUNTIME.stallWindowMsByPhase.rules);
  });

  test("MAX_STALL_WINDOW_MS is derived, not written twice", () => {
    expect(MAX_STALL_WINDOW_MS).toBe(
      Math.max(...Object.values(AUDIT_RUNTIME.stallWindowMsByPhase)),
    );
  });

  test("every window outlasts the longest single blocking operation a phase can make", () => {
    // The windows exist to survive one slow unit of work. The worst documented
    // one is the per-host rate-limit backoff cap (5 minutes, #1829), which the
    // crawl and external-link phases can both sit inside while perfectly
    // healthy. A window at or under that would kill throttled-but-fine runs.
    const maxBackoffMs = 5 * 60 * 1000;
    for (const phase of AUDIT_LIVENESS_PHASES) {
      expect(AUDIT_RUNTIME.stallWindowMsByPhase[phase]).toBeGreaterThan(maxBackoffMs);
    }
  });
});

describe("absolute ceilings", () => {
  test("free keeps the hour it has always had", () => {
    // Free is capped at 500 pages and 500 x runPerPageMs is exactly this hour, so
    // the ceiling has never been what bounds a free run. If this changes, check
    // whether the free page ladder moved with it.
    expect(AUDIT_RUNTIME.absoluteCeilingMsByPlanClass.free).toBe(AUDIT_RUNTIME.maxRunTimeoutMs);
    expect(AUDIT_RUNTIME.absoluteCeilingMsByPlanClass.free).toBe(60 * 60 * 1000);
  });

  test("paid is a backstop, not a budget", () => {
    // The point of #2112: a run making steady progress on a very large site
    // should finish. The paid ceiling has to be far enough above any real audit
    // that reaching it means wedged, and the stall windows are what catch the
    // common failure quickly.
    expect(AUDIT_RUNTIME.absoluteCeilingMsByPlanClass.paid).toBe(24 * 60 * 60 * 1000);
  });

  test("paid is more generous than free", () => {
    expect(AUDIT_RUNTIME.absoluteCeilingMsByPlanClass.paid).toBeGreaterThan(
      AUDIT_RUNTIME.absoluteCeilingMsByPlanClass.free,
    );
  });

  test("every ceiling leaves room for a full stall window plus the sigkill margin", () => {
    // A ceiling under one stall window would terminate on the ceiling before the
    // watchdog could ever attribute a stall to a phase, which would make every
    // termination read as `ceiling` and lose the diagnosis.
    for (const ceiling of Object.values(AUDIT_RUNTIME.absoluteCeilingMsByPlanClass)) {
      expect(ceiling).toBeGreaterThan(MAX_STALL_WINDOW_MS + AUDIT_RUNTIME.sigkillMarginMs);
    }
  });
});
