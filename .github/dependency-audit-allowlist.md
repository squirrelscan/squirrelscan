# Dependency Audit Allowlist

## GHSA-9wv6-86v2-598j

`path-to-regexp@6.1.0` is installed only through Tangly's `@astrojs/vercel`
adapter. The documentation project is a static Cloudflare build and does not
load or deploy the Vercel adapter. The Wrangler and MCP dependency paths resolve
to patched `path-to-regexp` versions.

Remove this exception when Tangly stops installing unused deployment adapters.
