import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "eslint/preserve-caught-error": "off",
  "github/array-foreach": "off",
  "unicorn/no-array-for-each": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
