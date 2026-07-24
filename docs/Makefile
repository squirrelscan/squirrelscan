.PHONY: validate dev build deploy

validate:
	bun x tangly check --strict

dev:
	bun x tangly dev

build:
	bun x tangly build

deploy:
	bun x tangly build && bun x wrangler deploy
