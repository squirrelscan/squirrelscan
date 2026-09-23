# Fixing structured data identity

Load this when an audit reports a `schema/entity-*` finding, or when a user asks why their structured data is not working despite validating.

Canonical version: https://docs.squirrelscan.com/entity-map/fixing

## The one idea

A structured data validator checks one page at a time, and that is the wrong unit for most of what goes wrong.

Sixty pages can each carry a perfectly valid `Organization` block, and if none of them says they are the same organization, a search engine has sixty organizations and no reason to connect them. Nothing accumulates: not the reviews, not the profile links, not the authority of the articles.

The fix is almost always the same: **declare each real thing once, give it one absolute `@id`, and reference that `@id` everywhere else instead of repeating the block.**

An `@id` is not a URL that has to resolve. It is a name. It has to be absolute, and it has to be byte-identical on every page.

## The shape that works

One script per page, one `@graph`, everything referenced by `@id`:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": "https://example.com/about#webpage",
      "url": "https://example.com/about",
      "name": "About",
      "isPartOf": { "@id": "https://example.com/#website" },
      "about": { "@id": "https://example.com/#organization" }
    },
    {
      "@type": "WebSite",
      "@id": "https://example.com/#website",
      "url": "https://example.com/",
      "publisher": { "@id": "https://example.com/#organization" }
    },
    {
      "@type": "Organization",
      "@id": "https://example.com/#organization",
      "name": "Example Ltd",
      "url": "https://example.com/",
      "logo": "https://example.com/logo.png",
      "sameAs": [
        "https://www.linkedin.com/company/example",
        "https://github.com/example"
      ]
    }
  ]
}
</script>
```

The `WebPage` node's `@id` changes per page. The `WebSite` and `Organization` ones never do.

## Finding by finding

| Finding | What it means | The change |
|---|---|---|
| `entity-identity` | The same organization, person or website on many pages with no `@id` | Add one absolute `@id`, identical on every page |
| `entity-split-identity` | One entity under two different `@id`s, usually two plugins | Pick one; make the other a `sameAs` or remove it |
| `entity-conflicts` | The same entity with two logos, names or phone numbers | Converge on one value, then reference instead of repeating |
| `entity-dangling` | A reference to an `@id` nothing declares | Declare the target in the `@graph` of every page that references it |
| `entity-id-format` | An `@id` that is not an absolute URL | Write the scheme and host out in full |
| `entity-type-drift` | One `@id` with different `@type` sets on different pages | Emit the same type array everywhere |
| `entity-authors` | A byline with no `Person`, or a `Person` with no identifiers | Declare the author with `@id`, `url` and `sameAs` |
| `entity-publisher-mismatch` | Pages that name different publishers | One publisher, referenced by `@id` |
| `entity-website-missing` | No `WebSite` node, or no `isPartOf` links to it | Declare it once, reference it from every page |
| `entity-organization-missing` | A business with no organization entity | Declare it once with `sameAs` |
| `entity-sameas-missing` | An organization with no `sameAs` profiles | List every profile you control |
| `entity-local-business-per-page` | The whole business block on every page | Declare once, reference elsewhere |
| `entity-orphan` | An `@id` nothing points at, on one page | Reference it, or drop the `@id` |

Rule pages: `https://docs.squirrelscan.com/rules/schema/{finding}`

## By generator

### Yoast SEO

Yoast emits the right shape by default: one `@graph` per page, stable absolute `@id`s, everything referenced. When a Yoast site reports an identity finding, something else on the page is declaring the same entity.

- **Split identity** usually means a second source of markup. Turn schema output off in one of them rather than reconciling both.
- **Organization details** live under Yoast SEO → Settings → Site representation. The social profiles set there become `sameAs`.
- A **hand-written block** added to the theme header years ago will fight Yoast. Search the theme for `application/ld+json` before blaming the plugin.

### Rank Math

Same shape, same advice. Schema and Local SEO settings both live under Rank Math → Titles and Meta.

`entity-local-business-per-page` on a Rank Math site means the Local SEO markup is reaching nearly every page rather than the home, about and contact pages it is meant for.

### WordLift

WordLift identifies entities under `data.wordlift.io` URLs, which is a legitimate identifier scheme. Running it alongside Yoast produces exactly the two-organization split this category reports.

WordLift documents a configuration that coexists with Yoast; use it rather than running both with their defaults.

If a split exists today, one of the two declarations has to go. **Adding the other id as a `sameAs` does not resolve the finding**, because both organizations are still declared: `sameAs` records a relationship, it does not remove the second entity.

### Next.js

Render one script per page with the complete `@graph`. Build the `@id`s from an environment variable so they cannot drift between environments:

```tsx
const SITE = process.env.NEXT_PUBLIC_SITE_URL!;
const ORG = `${SITE}/#organization`;

// `<` is escaped because JSON.stringify does not escape it, and a page title
// containing `</script>` would otherwise close the tag and turn the rest of the
// JSON into markup. Any value reaching a JSON-LD block from a CMS needs this.
const embed = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c");

export function Schema({ page }: { page: { url: string; title: string } }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: embed({
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebPage", "@id": `${page.url}#webpage`, name: page.title,
              isPartOf: { "@id": `${SITE}/#website` } },
            { "@type": "WebSite", "@id": `${SITE}/#website`, url: SITE,
              publisher: { "@id": ORG } },
            { "@type": "Organization", "@id": ORG, name: "Example Ltd", url: SITE },
          ],
        }),
      }}
    />
  );
}
```

The mistake to avoid is building `@id` from a relative path. `` `#organization` `` and `` `${SITE}/#organization` `` look equally correct in a template and only one of them works.

### Astro

```astro
---
const { title } = Astro.props;
const SITE = Astro.site!.href.replace(/\/$/, "");
const graph = [
  { "@type": "WebPage", "@id": `${Astro.url.href}#webpage`, name: title,
    isPartOf: { "@id": `${SITE}/#website` } },
  { "@type": "WebSite", "@id": `${SITE}/#website`, url: `${SITE}/`,
    publisher: { "@id": `${SITE}/#organization` } },
  { "@type": "Organization", "@id": `${SITE}/#organization`, name: "Example Ltd" },
];
// `set:html` does not escape, so escape `<` for the same reason as above.
const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
  .replace(/</g, "\\u003c");
---
<script type="application/ld+json" set:html={json} />
```

Set `site` in `astro.config.mjs` so `Astro.site` is defined. Without it the identifiers silently become relative.

### tangly

tangly emits the `@graph` shape from the site config. Set `site.url`, `organization` and `social` and the `WebSite`, `Organization` and per-page nodes are generated with stable identifiers.

## Checking your work

Re-audit and compare, rather than re-reading the markup:

```bash
squirrel audit https://example.com
squirrel entities --diff
```

An entity that gained an `@id` **changes key**, because the key is the `@id` when there is one. A naive comparison reports that as one removal plus one addition, which looks like damage. The `gainedId` section is what says a fix landed.

Two things to check before calling it done:

- **`coverage`** on each `gainedId` row. `proven` means the newer audit visited every page that declared the old version *and* found the replacement on all of them. `partial` means one of those could not be established, so re-audit the same scope you audited the first time.
- **`notCrawled`** should be empty. An entity there was not removed; its pages were not visited again.

A missing `gainedId` row is not proof the fix failed. The match needs the type and name unchanged, so changing the `@id` and the name in one edit appears as a removal plus an addition. Change the identifier first, confirm, then rename.
