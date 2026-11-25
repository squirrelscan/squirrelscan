// Bun test preload (see bunfig.toml): guards every built-in rule that declares `meta.checks` (#2343).
import { loadKnownRules } from "../../src/loader";
import { guardRule } from "./undeclared-check-guard";

for (const rule of loadKnownRules().values()) guardRule(rule);
