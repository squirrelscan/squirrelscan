// The rules that read external-link verdicts (repo#2144).
//
// The engine can run these LAST, after the external link check has answered
// (or run out of time), and every other rule without waiting on it. A rule
// belongs here when it reads `site.externalLinks` or `site.externalLinkCheck`:
// those are the only two SiteData fields the link check fills. A page rule
// never reads them (the per-page rule cache leaves them out of its key, see
// the engine's `pageRuleSiteContext`), so every rule listed is site-scope.
//
// `tests/link-verdict-rules.test.ts` reads every rule's source and fails when a
// rule reads either field and is missing here, so a new link rule cannot run
// before its verdicts without the test saying so.

/** Site rules that read `site.externalLinks` or `site.externalLinkCheck`. */
export const LINK_VERDICT_RULE_IDS: ReadonlySet<string> = new Set([
  "links/dead-links",
  "links/broken-external-links",
  "integrity/known-malicious-url",
  "reliability/broken-forms",
  // Reads `site.externalLinks === undefined` as "this audit may not request
  // other hosts" (--offline, external link checking off): the only signal a
  // rule has for that. Listed so it reads the bound field, never the one the
  // link check has not filled yet.
  "security/supabase-rls",
]);
