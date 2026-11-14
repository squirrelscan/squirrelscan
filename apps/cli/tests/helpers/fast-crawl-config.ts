// #1839: the default per-host politeness delay (50 ms) is paid serially by the
// ~45 discovery probes (llms.txt, .well-known/*, sitemaps...) every audit
// sends, which is ~2 s of pure waiting per run against a stubbed fetch. The
// requests, the order and the assertions are unchanged; only the sleep goes.
// Merges `per_host_delay_ms = 0` into a squirrel.toml body.
export function fastCrawlConfig(toml = ""): string {
  if (/^\[crawler\]\s*$/m.test(toml)) {
    return toml.replace(
      /^\[crawler\]\s*$/m,
      "[crawler]\nper_host_delay_ms = 0"
    );
  }
  return `[crawler]\nper_host_delay_ms = 0\n\n${toml}`;
}
