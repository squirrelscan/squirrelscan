// #1822 - the PUBLIC half of the cross-repo classifier parity check.
//
// The private twin of this file is apps/crawler-worker/src/classifier-parity
// .test.ts in squirrelscan/repo, and both drive the same corpus. Neither repo
// can import the other's classifier, so the corpus is what keeps them honest:
// a rule that drifts on either side fails here or there, instead of silently
// sending one audit a different failure email depending on which surface
// classified it.

import { describe, expect, test } from "bun:test";

import {
  AUDIT_FAILURE_REASON_CODES,
  classifyAuditFailureReasonText,
} from "../src/failure-reason";
import { CLASSIFIER_PARITY_CORPUS } from "./classifier-parity-corpus";

describe("classifier parity corpus (#1822)", () => {
  test("every reason classifies to its agreed code", () => {
    const wrong: string[] = [];
    for (const [reason, expected] of CLASSIFIER_PARITY_CORPUS) {
      const actual = classifyAuditFailureReasonText(reason);
      if (actual !== expected) wrong.push(`${expected} != ${actual}  ${reason}`);
    }
    expect(wrong).toEqual([]);
  });

  test("the corpus covers every code, so no class goes unexercised", () => {
    const covered = new Set(CLASSIFIER_PARITY_CORPUS.map(([, code]) => code));
    for (const code of AUDIT_FAILURE_REASON_CODES) {
      expect(covered.has(code)).toBe(true);
    }
  });

  test("Playwright's timeout wording matches with or without a space before ms", () => {
    // `\s*` not `\s?`: Playwright writes both spacings, and a double space
    // should not fall through to `unknown`.
    for (const reason of [
      "page.goto: Timeout 20000ms exceeded",
      "Timeout 20000 ms exceeded",
      "Timeout 20000  ms exceeded",
    ]) {
      expect(classifyAuditFailureReasonText(reason)).toBe("timeout");
    }
  });

  test("our own internal failures never read as the audited site's", () => {
    // The half of the corpus that matters most: every one of these would
    // otherwise tell a site owner to fix something that was never theirs.
    for (const reason of [
      "Callback 'mark-completed' failed after 3 attempts (HTTP 500: internal error)",
      "upload failed, HTTP 503 from storage",
      "database query timed out",
      "internal API got no response from the billing service",
      "database query failed after 403 retries",
    ]) {
      expect(classifyAuditFailureReasonText(reason)).toBe("unknown");
    }
  });
});
