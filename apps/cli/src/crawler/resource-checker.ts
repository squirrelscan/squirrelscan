// Resource size checker — re-exports the shared implementation from
// @squirrelscan/audit-engine. Previously this was a byte-for-byte duplicate
// (modulo the constants import path); both files now share one source so the
// sub-resource compression + cache logic (#107) can't drift between the CLI and
// the cloud runner.

export {
  checkResourceSizes,
  type ResourceCheckResult,
  type ResourceCheckerOptions,
} from "@squirrelscan/audit-engine";
