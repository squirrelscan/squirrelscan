.PHONY: validate dev build deploy

validate:
	bun x tangly check --strict
	bun scripts/check-links.ts
	bun scripts/glossary.ts --check
	bun test ./scripts/glossary.test.ts ./scripts/check-links.test.ts

dev:
	bun x tangly dev

build:
	bun x tangly build

deploy:
	bun x tangly build && bun x wrangler deploy
