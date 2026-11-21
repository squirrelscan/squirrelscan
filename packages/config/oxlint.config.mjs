import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";
import { disabledPackageRules } from "../../oxlint.disabled-package-rules.mjs";

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...disabledPackageRules },
});
