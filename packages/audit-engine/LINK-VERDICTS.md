# Late-bound link verdicts

By default the engine checks every external link, stores the verdicts, and only then starts the rules, because the link rules read those verdicts. A link host that takes a minute to answer holds every rule for that minute.

The late-binding mode removes that wait (repo#2144). The link check runs in the background, every rule that does not read link verdicts runs at once, and the rules that do run last, with the verdicts that arrived by one deadline. The default stays the blocking mode, so a caller opts in.

## Turn it on

```ts
const preRules = await Effect.runPromise(
  runStreamingPreRules(storage, crawlId, config, {
    externalLinks: {
      config: config.external_links,
      bulkChecker,
      limits: { budgetMs: 120_000 },
      lateBinding: { runDeadlineAt },
    },
  }),
);
const ran = await Effect.runPromise(
  runStreamingRules(storage, crawlId, config, preRules.assets, scope, {
    linkVerdicts: preRules.linkVerdicts,
  }),
);
```

`runStreamingPreRules` returns as soon as its walk and asset fetch are done. `preRules.externalLinkResults` is empty in this mode; the verdicts are `await preRules.linkVerdicts.settle()`'s `results`. Read the coverage stat (`externalLinkCheck`, with `outOfTime`) after `runStreamingRules` returns, or after `settle()`.

## Which rules wait

A rule waits when it reads `site.externalLinks` or `site.externalLinkCheck`, the two fields the link check fills. They are listed in `LINK_VERDICT_RULE_IDS` (`@squirrelscan/rules`): `links/dead-links`, `links/broken-external-links`, `integrity/known-malicious-url` and `reliability/broken-forms`. A test reads every rule's source and fails when a rule reads either field and is missing from the list.

Plugin rules wait too: the engine cannot see what they read.

All four are site rules. No page rule reads the verdicts, so the page rules and the other site rules run before the check ends, and their findings and cache keys are the same in both modes.

## The deadline

`linkVerdictDeadlineAt` is the one deadline, fixed when the check starts. It is the earliest of:

1. the check's start plus `limits.budgetMs`, the link check's own budget, which the blocking mode stops at too;
2. `lateBinding.runDeadlineAt` minus `LINK_RULES_RESERVE_MS` (30 s), so the link rules and the report still fit before the run's own deadline.

A bound that is unset, not finite, or (for the budget) zero or less is no bound. With neither, the link rules wait for every verdict, which gives the blocking mode's findings without holding the other rules.

The check is told the same deadline, so it sends no request after it, paid bulk calls included.

## At the deadline

- **In time.** When the check ends before the deadline, the verdicts stored are exactly the ones the blocking mode stores, and the link rules' findings are the same.
- **No verdict.** A link with no verdict by the deadline is unverifiable for this run. It gets no row and is counted as `outOfTime`, the same classification as a link the blocking check's budget ran out on: `links/broken-external-links` lists it as not checked, never as broken. A caller that refunds the links it was charged for with no stored answer refunds it.
- **Late verdicts.** `settle()` seals the handle. A verdict that arrives after that is discarded for this run. An answer already in flight may still reach the shared link cache, so the next run can use it.
- **One report.** The report is built once, after the seal. There is no path that amends a published report.

## The local fallback

A bulk checker that fails or answers nothing mid-check hands its remaining links to the local checker, as in the blocking mode, within the same deadline. A run whose link service goes down still produces a complete report.

## Sources

- `src/late-link-verdicts.ts`: the deadline, the handle and its seal.
- `src/adapter.ts`: `planExternalLinkCheck` and `persistExternalLinkResults`, shared by both modes; `readExternalLinkVerdicts`, the view the link rules read; the two site passes in `runStreamingRules`.
- `tests/late-link-verdicts-2144.test.ts`: ordering, parity with the blocking mode, deadline expiry, and the service failing mid-check.
