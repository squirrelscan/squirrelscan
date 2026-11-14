// The TLS probe lives in @squirrelscan/tls-probe, its own package, so the
// node:net/node:tls sockets stay out of packages the hosted worker depends on
// (#2410, #3922). Re-exported here so the CLI's imports and tests stay as they were.
export * from "@squirrelscan/tls-probe";
