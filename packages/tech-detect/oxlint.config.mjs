import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "eslint/no-control-regex": "off",
  "eslint/no-template-curly-in-string": "off",
  "eslint/no-useless-escape": "off",
  "eslint/prefer-regex-literals": "off",
  "sonarjs/no-nested-assignment": "off",
  "sonarjs/updated-loop-counter": "off",
  "unicorn/no-useless-spread": "off",
  "unicorn/prefer-math-trunc": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
