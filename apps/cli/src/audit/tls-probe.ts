// The TLS probe moved to @squirrelscan/fetchers/tls-probe so the CLI and the
// cloud audit share one implementation (#3922). This path keeps the CLI's
// imports and tests unchanged.
export * from "@squirrelscan/fetchers/tls-probe";
