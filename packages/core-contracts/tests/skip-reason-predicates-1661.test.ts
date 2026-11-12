// What the three skip-reason predicates answer for every coded skip reason (#1661).
//
// This file ran green on the code that wrote the predicates out by hand, and must stay green
// now that they derive from one table: the refactor changes where the answers come from, not
// the answers.

import { describe, expect, test } from "bun:test";

import {
  CRAWL_CAPPED_SKIP_REASON,
  EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
  EXTERNAL_LINKS_OUT_OF_TIME_SKIP_REASON,
  EXTERNAL_LINKS_OVER_CAP_SKIP_REASON,
  LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
  NOT_CHECKED_SKIP_REASONS,
  PRIVATE_TARGET_SKIP_REASON,
  TARGETED_RUN_SKIP_REASON,
  TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON,
} from "../src/index";
import { IGNORED_SKIP_REASON } from "../src/ignore";
import {
  CHECK_NOT_APPLICABLE_SKIP_REASON,
  isRuleNotApplicableReason,
  isRuleWideGapSkipReason,
  NOT_APPLICABLE_SKIP_REASON,
  PAGE_TYPE_SKIP_REASON,
  RULE_TIMED_OUT_SKIP_REASON,
  SCAN_TRUNCATED_SKIP_REASON,
  UNREAD_PAGE_SKIP_REASON,
} from "../src/resolution";

// reason -> [rule-wide not applicable, rule-wide gap, in NOT_CHECKED_SKIP_REASONS]
const TABLE: Array<[string, boolean, boolean, boolean]> = [
  [NOT_APPLICABLE_SKIP_REASON, true, false, false],
  [PAGE_TYPE_SKIP_REASON, true, false, false],
  [CHECK_NOT_APPLICABLE_SKIP_REASON, false, false, false],
  [RULE_TIMED_OUT_SKIP_REASON, false, true, true],
  [UNREAD_PAGE_SKIP_REASON, false, true, false],
  [SCAN_TRUNCATED_SKIP_REASON, false, false, false],
  [TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON, false, false, true],
  [EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON, false, false, true],
  [LINK_TARGETS_NOT_FETCHED_SKIP_REASON, false, false, true],
  [EXTERNAL_LINKS_OVER_CAP_SKIP_REASON, false, false, true],
  [EXTERNAL_LINKS_OUT_OF_TIME_SKIP_REASON, false, false, true],
  [CRAWL_CAPPED_SKIP_REASON, false, false, true],
  // A targeted run (#1777): a whole-site rule has nothing to judge, so the rule-wide gap is also not checked.
  [TARGETED_RUN_SKIP_REASON, false, true, true],
  [IGNORED_SKIP_REASON, false, false, false],
  [PRIVATE_TARGET_SKIP_REASON, false, false, false],
];

describe("the predicates over every coded skip reason", () => {
  for (const [reason, notApplicable, gap, notChecked] of TABLE) {
    test(`${reason}`, () => {
      expect(isRuleNotApplicableReason(reason)).toBe(notApplicable);
      expect(isRuleWideGapSkipReason(reason)).toBe(gap);
      expect(NOT_CHECKED_SKIP_REASONS.has(reason)).toBe(notChecked);
    });
  }

  test("free text and undefined are none of them", () => {
    for (const reason of ["Parse error", "No pages crawled", "", undefined]) {
      expect(isRuleNotApplicableReason(reason)).toBe(false);
      expect(isRuleWideGapSkipReason(reason)).toBe(false);
      expect(NOT_CHECKED_SKIP_REASONS.has(reason as string)).toBe(false);
    }
  });

  test("the not-checked set is exactly the eight reasons", () => {
    expect([...NOT_CHECKED_SKIP_REASONS].sort()).toEqual(
      TABLE.filter((r) => r[3]).map((r) => r[0]).sort(),
    );
  });
});
