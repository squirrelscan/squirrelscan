# Contributing

Thanks for contributing to squirrelscan. Bug fixes, rules, tests, documentation, and focused performance improvements are welcome.

Working with a coding agent, or want the long version? [AGENTS.md](AGENTS.md) covers the repo layout, adding a rule or a CLI command, test conventions, untrusted-input rules and the CI checks that catch people out.

## Development

Use Bun 1.4.4 or the version in `package.json`.

```bash
bun install --frozen-lockfile
bun run dev -- audit https://example.com --max-pages 10
bun run format:check
bun run lint
bun run typecheck
bun test
bun run docs:check
bun run docs:build
```

Add focused tests for behavioral changes. Keep changes scoped and avoid generated or unrelated formatting churn.

Documentation source lives in `docs/`. Run `bun run docs:check` after editing links,
navigation, or MDX content, and `bun run docs:build` before submitting structural or
configuration changes.

`docs:check` (and `make validate` in `docs/`) runs `tangly check --strict`, then
`docs/scripts/check-links.ts`, because tangly does not check internal links. The
script fails on a link to a page that does not exist, a `#anchor` the target page
does not render, a missing anchor from `docs/scripts/required-anchors.json` (the
cloud app links to those sections, so keep a heading's `{#id}` when you rename it),
and a rule page `## Options` row that prints `unknown` or `undefined`.

It then runs `docs/scripts/glossary.ts --check`. The glossary and the rule-category
hubs are built from `docs/scripts/glossary/terms.json` and `hubs.json`: the content
between `{/* glossary:...:start */}` or `{/* hub:...:start */}` markers is generated,
so edit the data files and run `bun scripts/glossary.ts --write` in `docs/` instead
of editing it by hand. The check also fails on a term naming a rule with no docs
page, a hub that does not link one of its rules, a category hub with a category
`<Card>` or a stated rule count, a glossary or hub title over 60 or description over
155 characters, an em-dash, and two pages with the same title. Last, it runs the
tests for both scripts (`docs/scripts/glossary.test.ts` and `check-links.test.ts`).

## Declaring `verdictScope: "template"`

A rule that sets `verdictScope: "template"` has one page's verdict copied to every page that shares its fan-out key (the stored chrome key, the page origin and `fanoutInputSignature` in `packages/audit-engine/src/template-fanout.ts`), so the rule only runs once per template. That is a claim that every input the rule reads is constant across the pages of a template. Declare it only for rules that read chrome (script and stylesheet lists, `<meta>` names, `<html>` attributes, icon links), never body content, response headers or per-page data. The `VerdictScope` doc in `packages/rules/src/types.ts` is the full rule.

Two tests hold the declaration to that:

- `packages/rules/tests/template-verdict-inputs.test.ts` scans the rule's source for the selectors, attributes and raw-HTML reads it uses and fails on any read that is not on its reviewed list. Add the new read to `REVIEWED` as keyed (the signature covers it) or unkeyed (it does not). If it is unkeyed, name the rule in the `VerdictScope` doc, or extend `fanoutInputSignature` so the read becomes keyed.
- `packages/audit-engine/tests/template-fanout-parity-golden.test.ts` compares fanned-out verdicts with a full run over an authored multi-page corpus.

If you cannot say why an input is constant across a template, leave the rule page-scoped.

## Issues

Every issue carries a `## Acceptance Criteria` checklist: the observable outcomes that mean it is done. The issue templates include the section. If a report arrives without one, maintainers add it at triage.

## Pull requests

Open an issue before large architectural changes. Pull requests should explain the behavior change and list the commands used to verify it.

Every commit must include a Developer Certificate of Origin sign-off:

```bash
git commit -s -m "fix: describe the change"
```

The sign-off certifies that you have the right to submit the contribution under this project's license. See [developercertificate.org](https://developercertificate.org/) for the full DCO text.

By submitting a contribution, you agree that it may be distributed under the MIT License. Do not submit secrets, private customer data, copied proprietary code, or material whose license is incompatible with MIT distribution.

## Security issues

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
