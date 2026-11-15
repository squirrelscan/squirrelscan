import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "eslint/array-callback-return": "off",
  "eslint/no-control-regex": "off",
  "eslint/no-loss-of-precision": "off",
  "github/array-foreach": "off",
  "sonarjs/code-eval": "off",
  "sonarjs/no-nested-assignment": "off",
  "unicorn/no-array-for-each": "off",
  "unicorn/no-useless-fallback-in-spread": "off",
  "unicorn/no-useless-spread": "off",
  "unicorn/prefer-native-coercion-functions": "off",
  "unicorn/prefer-structured-clone": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
