export interface GlossaryJsonLdTerm {
  slug: string;
  term: string;
  definition: string;
}

export interface GlossaryJsonLdOptions {
  origin: string;
  terms: readonly GlossaryJsonLdTerm[];
  written: ReadonlySet<string>;
  slug?: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A term's sort key: case-folded, leading punctuation (`@id`) dropped. */
function sortKey(term: string): string {
  return term.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
}

/** The definition as a reader sees it rendered: code spans lose their backticks. */
function plainDefinition(term: GlossaryJsonLdTerm): string {
  return term.definition.replace(/`/g, "");
}

/** Build the schema.org node rendered by the glossary JSON-LD component. */
export function buildGlossaryJsonLd({
  origin,
  terms,
  written,
  slug,
}: GlossaryJsonLdOptions): Record<string, unknown> | null {
  const site = origin.replace(/\/+$/, "");
  const set = `${site}/glossary#set`;
  const node = (term: GlossaryJsonLdTerm) => {
    const url = written.has(term.slug)
      ? `${site}/glossary/${term.slug}`
      : `${site}/glossary#${term.slug}`;
    return {
      "@type": "DefinedTerm",
      "@id": `${url}#term`,
      name: term.term,
      description: plainDefinition(term),
      url,
    };
  };

  if (slug !== undefined) {
    const term = terms.find((candidate) => candidate.slug === slug);
    if (!term) return null;
    return {
      "@context": "https://schema.org",
      ...node(term),
      inDefinedTermSet: {
        "@type": "DefinedTermSet",
        "@id": set,
        name: "Website audit glossary",
        url: `${site}/glossary`,
      },
    };
  }

  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": set,
    name: "Website audit glossary",
    url: `${site}/glossary`,
    hasDefinedTerm: [...terms]
      .sort(
        (a, b) =>
          cmp(sortKey(a.term), sortKey(b.term)) || cmp(a.slug, b.slug),
      )
      .map(node),
  };
}
