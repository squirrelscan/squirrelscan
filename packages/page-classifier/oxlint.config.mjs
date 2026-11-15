import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "eslint/no-self-compare": "off",
  "eslint/operator-assignment": "off",
  "eslint/sort-vars": "off",
  "github/no-inner-html": "off",
  "sonarjs/misplaced-loop-counter": "off",
  "sonarjs/no-nested-assignment": "off",
  "sonarjs/no-unused-function-argument": "off",
  "typescript/no-confusing-non-null-assertion": "off",
  "unicorn/prefer-includes": "off",
  "unicorn/prefer-math-trunc": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
