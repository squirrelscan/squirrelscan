SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

APP_DIR := apps/cli
VERSION ?= 0.0.0
PLATFORMS := darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl windows-x64

.PHONY: format format-check lint typecheck test test-release-tooling check ci build build-all build-ci sign-darwin manifest clean dev release

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
	@bash scripts/test-changelog-entries.sh
	@bun test scripts/release-version.test.ts scripts/build-targets.test.ts scripts/changelog.test.ts

check: format-check lint typecheck

ci: check test test-release-tooling

build: ci
	@cd $(APP_DIR) && bun run build

# NODE_ENV is pinned to "production" (#1839). `bun build` folds the literal
# `process.env.NODE_ENV` to a constant taken from the build environment
# ("development" when unset), so a runner exporting NODE_ENV=test would ship the
# test-only knobs live. `--define` pins the constant whatever the environment
# says; `--production` alone does not (it yields to an exported NODE_ENV). Keep
# `--production` too: it switches Bun's JSX transform from jsxDEV to jsx, which
# React's production jsx-dev-runtime (selected by the pinned NODE_ENV) needs,
# or the HTML report crashes calling an undefined jsxDEV.
# The dev build (`bun run build` in apps/cli, also behind `make build`) carries the same
# two flags for the same reasons (#1855); it just skips --minify.
# One flag set for the shipped artifact shape, shared by `build-all` (release) and
# `build-ci` (the CI compile job) so they cannot drift (#1414).
RELEASE_FLAGS := --compile --splitting --minify --production \
	--no-compile-autoload-dotenv --no-compile-autoload-bunfig \
	--define process.env.NODE_ENV='"production"'

# Host-target build with the release flags, no ci prerequisite (CI runs the
# checks as separate jobs). Output path matches `bun run build`.
build-ci:
	@cd $(APP_DIR) && bun build src/cli.ts $(RELEASE_FLAGS) --outfile=build/squirrelscan

build-all: ci
	@for platform in $(PLATFORMS); do \
		echo "==> Building $$platform..."; \
		ext=""; target="$$platform"; \
		if [ "$$platform" = "windows-x64" ]; then ext=".exe"; fi; \
		case "$$platform" in \
			darwin-x64) target="darwin-x64-baseline";; \
			linux-x64) target="linux-x64-baseline";; \
			linux-x64-musl) target="linux-x64-musl-baseline";; \
			windows-x64) target="windows-x64-baseline";; \
		esac; \
		(cd $(APP_DIR) && bun build src/cli.ts $(RELEASE_FLAGS) \
			--target=bun-$$target \
			--outfile=build/squirrel-$(VERSION)-$$platform$$ext); \
	done
	@$(MAKE) sign-darwin

# Must run after the compile and before `manifest`: signing rewrites the file,
# so a hash taken first would describe bytes nobody ever downloads (#2310).
sign-darwin:
	@bash scripts/sign-darwin.sh $(APP_DIR)/build

manifest:
	@cd $(APP_DIR) && VERSION=$(VERSION) bun run scripts/generate-manifest.ts

clean:
	@rm -rf $(APP_DIR)/build

dev:
	@bun run dev

release:
	@bun run scripts/release.ts
