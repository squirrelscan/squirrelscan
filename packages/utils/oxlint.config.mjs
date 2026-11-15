import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "eslint/no-loop-func": "off",
  "eslint/no-template-curly-in-string": "off",
  "eslint/no-throw-literal": "off",
  "eslint/no-void": "off",
  "github/array-foreach": "off",
  "import/no-cycle": "off",
  "promise/prefer-catch": "off",
  "sonarjs/array-constructor": "off",
  "sonarjs/no-nested-assignment": "off",
  "sonarjs/updated-loop-counter": "off",
  "typescript/triple-slash-reference": "off",
  "unicorn/no-array-for-each": "off",
  "unicorn/no-new-array": "off",
  "unicorn/no-useless-spread": "off",
  "unicorn/prefer-includes": "off",
  "unicorn/prefer-math-trunc": "off",
  "unicorn/prefer-native-coercion-functions": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
