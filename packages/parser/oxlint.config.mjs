import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "unicorn/no-useless-spread": "off",
  "sonarjs/variable-name": "off",
  "eslint/accessor-pairs": "off",
  "eslint/guard-for-in": "off",
  "eslint/no-control-regex": "off",
  "eslint/operator-assignment": "off",
  "github/get-attribute": "off",
  "github/no-inner-html": "off",
  "sonarjs/for-in": "off",
  "sonarjs/hashing": "off",
  "sonarjs/no-unused-function-argument": "off",
  "unicorn/prefer-dom-node-dataset": "off",
  "unicorn/prefer-dom-node-remove": "off",
  "unicorn/prefer-math-trunc": "off",
  "unicorn/prefer-modern-dom-apis": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
