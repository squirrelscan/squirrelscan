import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "unicorn/no-useless-fallback-in-spread": "off",
  "sonarjs/variable-name": "off",
  "eslint/func-name-matching": "off",
  "eslint/no-loop-func": "off",
  "eslint/no-unmodified-loop-condition": "off",
  "sonarjs/misplaced-loop-counter": "off",
  "sonarjs/no-inverted-boolean-check": "off",
  "sonarjs/no-unused-collection": "off",
  "sonarjs/no-unused-function-argument": "off",
  "sonarjs/updated-loop-counter": "off",
  "typescript/no-invalid-void-type": "off",
  "typescript/triple-slash-reference": "off",
  "unicorn/no-thenable": "off",
  "unicorn/no-useless-spread": "off",
  "unicorn/prefer-negative-index": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
