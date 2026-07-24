# Contributing

Thanks for contributing to SquirrelScan. Bug fixes, rules, tests, documentation, and focused performance improvements are welcome.

## Development

Use Bun 1.3.14 or the version in `package.json`.

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
