# Dependency Audit Allowlist

## GHSA-9wv6-86v2-598j

`path-to-regexp@6.1.0` is installed only through Tangly's `@astrojs/vercel`
adapter. The documentation project is a static Cloudflare build and does not
load or deploy the Vercel adapter. The Wrangler and MCP dependency paths resolve
to patched `path-to-regexp` versions.

Remove this exception when Tangly stops installing unused deployment adapters.

## GHSA-mh99-v99m-4gvg

`brace-expansion` DoS via unbounded expansion. The affected range is `<=5.0.7`, and
the tree resolves two copies: `5.0.8` (already patched) and `1.1.16`, which is the
newest release on the 1.x line — there is no patched 1.x to move to.

The `1.1.16` copy arrives only through lint and docs tooling:
`eslint-plugin-sonarjs`, `eslint-plugin-github` and `ultracite` (all
`devDependencies` of `@squirrelscan/cli`), plus `tangly` in the docs workspace.
None of them are bundled into the compiled `squirrel` binary, so no shipped
artifact is exposed; the reachable impact is a developer running lint locally or
in CI against hostile glob input, which does not occur.

Forcing the 1.x consumers onto 2.x/5.x via an `overrides` entry is a major bump of
third-party lint tooling and churns the lockfile and generated notices, so it is
tracked separately rather than bundled into a security fix.

Remove this exception when those packages ship a patched `brace-expansion`, or when
the override bump is done deliberately.
