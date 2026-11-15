import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "eslint/no-control-regex": "off",
  "eslint/no-proto": "off",
  "eslint/no-useless-concat": "off",
  "eslint/prefer-regex-literals": "off",
  "sonarjs/misplaced-loop-counter": "off",
  "sonarjs/no-inverted-boolean-check": "off",
  "unicorn/no-useless-fallback-in-spread": "off",
  "unicorn/prefer-math-trunc": "off",
  "unicorn/prefer-string-starts-ends-with": "off",
  "unicorn/prefer-structured-clone": "off",
  "unicorn/relative-url-style": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
