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

## GHSA-hp3w-g68c-fv3c

`sprintf-js` DoS via unbounded precision specifiers. The affected range is
`<=1.1.3`, and `1.1.3` is the newest release: there is no patched version to move
to.

The tree resolves one copy, `1.0.3`, through `gray-matter` > `js-yaml@3` >
`argparse@1`, and `gray-matter` is installed only by `tangly` in the docs
workspace. `bun audit` also prints an
`eslint-plugin-github` > `@eslint/eslintrc` path, but that `js-yaml` resolves to
`4.x`, which uses `argparse@2` and does not depend on `sprintf-js`. Within
`js-yaml@3` only its own `bin/js-yaml.js` command loads `argparse`, so the
library calls `gray-matter` makes never load `sprintf-js`, and nothing in the
compiled `squirrel` binary does either.

Remove this exception when `sprintf-js` ships a fix or `gray-matter` moves off
`js-yaml@3`.

## GHSA-238p-pmpm-9mq7

KaTeX trust-restriction bypass that needs an existing prototype pollution. The
fix is `0.18.2`; the tree resolves `0.16.47`, and every consumer (`tangly`,
`@tanglydocs/theme-ui`, `rehype-katex`, `micromark-extension-math`, `mermaid`)
asks for `^0.16`. All of them are docs-workspace only, and nothing in the
compiled `squirrel` binary loads KaTeX.

Forcing `0.18` through an override crosses two breaking releases (`0.17` changed
the internal `defineFunction` API and `0.18` prefixed KaTeX's CSS classes), which
the docs theme's KaTeX styles and the plugins above were not built against. The
docs render only our own math, so there is no untrusted input to bypass.

Remove this exception when every consumer above accepts KaTeX `0.18`.

## GHSA-98hj-9722-w3j8 and GHSA-mpr7-6m5w-76rw

Astro: unescaped `<script>`/`<style>` content in JSX/MDX rendering (moderate,
fixed in `7.3.2`), and CSS injection through View Transitions (low, fixed in
`7.3.3`). The tree resolves `7.2.9`, held by the root `overrides` range
`>=7.2.8 <7.2.10` (#301). Astro `7.2.10` and `7.3.x` need
`@astrojs/markdown-remark` `^7.3.0` and `markdown-satteri` `0.4.x`, while the
`@astrojs/mdx` `7.0.x` that tangly is built against (tangly `0.5.2`, the latest,
still asks for `^7.0.8`) pins `markdown-remark` `7.2.4` and peers on
`markdown-satteri` `^0.3.1`. Lifting the cap leaves the MDX integration with
unsatisfied peers and duplicate copies.

Astro is docs-workspace only: nothing in the compiled `squirrel` binary loads it.
docs.squirrelscan.com is a static build served as Cloudflare assets, so nothing
renders at request time, and every page is our own MDX with no untrusted props or
view-transition values. Neither advisory has untrusted input to work with.

Remove this exception, and the cap, when tangly moves to `@astrojs/mdx` `8`.

## GHSA-mrhx-c7xc-m3w5

Zod: memory exhaustion while validating oversized constrained collections (high,
fixed in `4.6.6`). The tree resolves `4.4.3`, `4.1.11` and `3.25.76`. `cli` and
`rules` ask for `^4.4.3`, but `config` and `crawler` ask for `^3.25.76`, so
reaching `4.6.6` there is a zod 3 to 4 migration, not a bump (#1085). The MCP
packages, tangly/astro and ultracite pull zod in transitively.

Public zod validates trusted local config and our own cloud API responses. The
attack needs an attacker-sized array inside the validated input, and neither
source carries one from an untrusted party.

Remove this exception when zod is at `4.6.6` or later everywhere (#1085).
