import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";
import { disabledReactRules } from "../../oxlint.disabled-react-rules.mjs";

export default defineConfig({
  extends: [core, react],
  rules: { ...disabledCoreRules, ...disabledReactRules },
});
