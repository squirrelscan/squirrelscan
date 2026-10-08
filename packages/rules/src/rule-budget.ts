// Per-rule wall-clock budget. Rules run regexes and DOM walks over page content
// the audited site controls, so one pathological pattern (catastrophic or
// polynomial backtracking) on one crafted page could otherwise stall the whole
// audit. The budget turns that into one abandoned rule on one page.
//
// Page rules are synchronous CPU on the main thread and cannot move to workers
// (the linkedom Document does not cross a worker boundary, see
// audit-engine/src/page-rule-executor.ts), so a timer or Promise.race cannot
// stop them. `node:vm`'s `timeout` can: Bun arms the engine watchdog for the
// duration of the call, and when it fires the engine raises a termination
// exception that the rule's own try/catch cannot swallow. The rule function is
// still called with its own realm's globals; the context only hosts the call.
//
// Verified on Bun 1.3.14: `runInContext` with a `timeout` interrupts a catastrophic
// regex run by a main-realm function called from inside the context (a 200 ms
// budget threw ERR_SCRIPT_EXECUTION_TIMEOUT after about 430 ms; a spin loop after
// about 110 ms). tests/rule-time-budget.test.ts pins it through RuleRunner on the
// ReDoS fixture. CI runs it (the "Rules tests" step of the CLI tests job) on the
// Bun pinned in .github/actions/setup-bun, so a bump of that pin re-checks it.
// squirrel ships as a Bun executable; Node is not a supported runtime.
//
// Granularity: the watchdog is checked between operations, not inside one regex
// match. JavaScriptCore already gives up on a single runaway match after a
// bounded amount of backtracking (the match reports no match), so the worst
// overshoot past the budget is about one such match. What the budget prevents is
// a rule repeating a slow match across many elements or pages, which without it
// is unbounded.
//
// An abandoned rule stops at an arbitrary point, so a rule must not leave
// shared state half-written when it throws or is stopped: build results locally
// and publish them last. What this module guarantees: the runner's own state is
// never touched by a timeout, and `lastIndex` on the module-level `/g` and `/y`
// regexes registered with `sharedRegex` (shared-regex.ts) is reset to 0 when a
// rule is abandoned. What it does not: any other module-level state a rule
// mutates (a cache, a counter, a regex that is not registered) is left as the
// rule left it, so rules must keep such state consistent at every operation
// boundary or not share it.
//
// Only the synchronous part of `run()` is budgeted. An async rule's awaits are
// network I/O with their own per-request timeouts, and its code after an await
// runs outside the call.

import vm from "node:vm";

import { resetSharedRegexes } from "./shared-regex";

/**
 * Wall-clock budget for one page-rule evaluation on one page, in ms. A site rule
 * gets this much per page of the site (see {@link siteRuleBudgetMs}), because its
 * work grows with the site.
 *
 * Chosen from measured rule times on the golden corpus (500-page fixture, 3 runs,
 * `packages/audit-engine/scripts/rule-time-percentiles.ts`): the slowest page
 * rule's p99 is 6 ms and the slowest single page-rule run 90 ms; the heaviest
 * synchronous site rule spends about 2 ms per page. 1000 ms leaves more than 10x
 * headroom over the worst observed run on a slow, shared CPU, so it only fires
 * on pathological input.
 */
export const RULE_TIME_BUDGET_MS = 1000;

/**
 * Ceiling on one site-rule evaluation, in ms. Without it the per-page scaling
 * gives a 5,000-page site over an hour for a single stuck rule. The heaviest
 * synchronous site rule spends about 2 ms per page, so 60 s is still 30x
 * headroom at 500 pages and 6x at 5,000.
 */
export const SITE_RULE_BUDGET_CAP_MS = 60_000;

/**
 * Budget for one site-rule evaluation: {@link RULE_TIME_BUDGET_MS} per page,
 * capped at {@link SITE_RULE_BUDGET_CAP_MS} (never below the per-page budget).
 */
export function siteRuleBudgetMs(budgetMs: number, pageCount: number): number {
  return Math.min(budgetMs * Math.max(1, pageCount), Math.max(SITE_RULE_BUDGET_CAP_MS, budgetMs));
}

/** Thrown when a rule's synchronous work runs past its budget. */
export class RuleTimeoutError extends Error {
  constructor(readonly budgetMs: number) {
    super(`exceeded its ${budgetMs} ms time budget and was abandoned`);
    this.name = "RuleTimeoutError";
  }
}

// One context and one compiled script for the process: the call just swaps the
// function in. A call made while another is active (nesting) runs directly
// under the outer call's budget, so the single slot is never clobbered.
let active = false;
const slot: { fn?: () => unknown } = {};
const context = vm.createContext(slot);
const callSlot = new vm.Script("fn()");

/**
 * Call `fn` and return its result, or throw {@link RuleTimeoutError} if its
 * synchronous execution exceeds `budgetMs`. Errors `fn` throws pass through
 * unchanged. A non-positive or non-finite budget calls `fn` directly.
 */
export function runWithinBudget<T>(fn: () => T, budgetMs: number): T {
  if (!(budgetMs > 0) || !Number.isFinite(budgetMs)) return fn();
  if (active) return fn();
  active = true;
  slot.fn = fn;
  try {
    return callSlot.runInContext(context, { timeout: Math.ceil(budgetMs) }) as T;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      // The rule stopped at an arbitrary point, possibly mid `exec()` loop on a
      // shared `/g` or `/y` regex whose `lastIndex` would carry into the next rule.
      resetSharedRegexes();
      throw new RuleTimeoutError(budgetMs);
    }
    throw e;
  } finally {
    slot.fn = undefined;
    active = false;
  }
}
