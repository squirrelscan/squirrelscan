// The rules version, inlined at transpile time by a Bun macro (see
// rules-fingerprint.ts). Kept in its own small module so Bun's runtime transpiler
// cache, which only stores large files, never serves a stale hash in a checkout.

import { rulesSourceFingerprint } from "./rules-fingerprint" with { type: "macro" };

export const RULES_VERSION: string = rulesSourceFingerprint();
