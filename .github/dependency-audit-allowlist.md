# Dependency Audit Allowlist

Every `--ignore` in the `audit:dependencies` script in `package.json` is an exception (the two
ignores for `GHSA-gcqx-w48m-w2h4` and `GHSA-wx4j-mvgx-mqwp` have no section below), and an
exception stays only while its advisory still matches the lockfile. When a dependency change makes an
advisory stop matching (check with `bun audit` after removing the ignore, on the bun version in
`packageManager`), drop the ignore and its section here in the same change, so the list does not
hide a later regression of the same advisory. The `dependency-advisory` workflow opens an issue when
the audit fails; it is also the moment to prune.

## GHSA-9wv6-86v2-598j

`path-to-regexp@6.1.0` is installed only through Tangly's `@astrojs/vercel`
adapter. The documentation project is a static Cloudflare build and does not
load or deploy the Vercel adapter. The Wrangler and MCP dependency paths resolve
to patched `path-to-regexp` versions.

Remove this exception when Tangly stops installing unused deployment adapters.

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
