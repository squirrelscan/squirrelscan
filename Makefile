SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

APP_DIR := apps/cli
VERSION ?= 0.0.0
PLATFORMS := darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl windows-x64

.PHONY: format format-check lint typecheck test test-release-tooling check ci build build-all manifest clean dev release

format:
	@cd $(APP_DIR) && bun run format

format-check:
	@cd $(APP_DIR) && bun run format:check

lint:
	@cd $(APP_DIR) && bun run lint

typecheck:
	@bun run typecheck

test:
	@cd $(APP_DIR) && bun test

test-release-tooling:
	@bash scripts/test-changelog-extraction.sh
	@bun test scripts/release-version.test.ts

check: format-check lint typecheck

ci: check test test-release-tooling

build: ci
	@cd $(APP_DIR) && bun run build

build-all: ci
	@for platform in $(PLATFORMS); do \
		echo "==> Building $$platform..."; \
		ext=""; target="$$platform"; \
		if [ "$$platform" = "windows-x64" ]; then ext=".exe"; fi; \
		case "$$platform" in \
			linux-x64) target="linux-x64-baseline";; \
			linux-x64-musl) target="linux-x64-musl-baseline";; \
			windows-x64) target="windows-x64-baseline";; \
		esac; \
		(cd $(APP_DIR) && bun build src/cli.ts --compile --minify \
			--target=bun-$$target \
			--outfile=build/squirrel-$(VERSION)-$$platform$$ext); \
	done

manifest:
	@cd $(APP_DIR) && VERSION=$(VERSION) bun run scripts/generate-manifest.ts

clean:
	@rm -rf $(APP_DIR)/build

dev:
	@bun run dev

release:
	@bun run scripts/release.ts
