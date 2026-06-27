# context-mode justfile
# Usage: just <recipe> [args]
# Run `just` or `just help` to list all recipes.

root := justfile_directory()

# List all recipes
help:
    @just --list

# ── Build ─────────────────────────────────────────────────────────────────────

# Type-check + bundle + assert (full build, same as prepublishOnly)
[group('build')]
build:
    npm run build

# Type-check only (fast — no emit)
[group('build')]
typecheck:
    npx tsc --noEmit

# Bundle all outputs (skip tsc — fast iteration)
[group('build')]
bundle:
    npm run bundle

# Bundle only server.bundle.mjs
[group('build')]
bundle-server:
    npx esbuild src/server.ts --bundle --platform=node --target=node18 --format=esm \
        --outfile=server.bundle.mjs \
        --external:better-sqlite3 --external:turndown --external:turndown-plugin-gfm \
        --external:@mixmark-io/domino --minify

# Bundle only cli.bundle.mjs
[group('build')]
bundle-cli:
    npx esbuild src/cli.ts --bundle --platform=node --target=node18 --format=esm \
        --outfile=cli.bundle.mjs --external:better-sqlite3 --minify

# Bundle only the session/hook bundles
[group('build')]
bundle-hooks:
    npx esbuild src/session/extract.ts  --bundle --platform=node --target=node18 --format=esm --outfile=hooks/session-extract.bundle.mjs  --minify
    npx esbuild src/session/snapshot.ts --bundle --platform=node --target=node18 --format=esm --outfile=hooks/session-snapshot.bundle.mjs --minify
    npx esbuild src/session/db.ts       --bundle --platform=node --target=node18 --format=esm --outfile=hooks/session-db.bundle.mjs       --external:better-sqlite3 --minify
    npx esbuild src/security.ts         --bundle --platform=node --target=node18 --format=esm --outfile=hooks/security.bundle.mjs          --minify

# Assert bundles are non-empty and pass drift checks
[group('build')]
assert:
    npm run assert-bundle
    npm run assert-asymmetric-drift

# ── Dev ───────────────────────────────────────────────────────────────────────

# Start MCP server in dev mode (tsx watch, no bundle needed)
[group('dev')]
dev:
    npm run dev

# Run cli.ts directly via tsx (no bundle needed)
[group('dev')]
cli *args:
    npx tsx src/cli.ts {{args}}

# Run setup wizard
[group('dev')]
setup:
    npx tsx src/cli.ts setup

# Run doctor check
[group('dev')]
doctor:
    npx tsx src/cli.ts doctor

# ── Test ──────────────────────────────────────────────────────────────────────

# Run full test suite (skips tsc build — uses existing build/)
[group('test')]
test *args:
    node_modules/.bin/vitest run {{args}}

# Run tests matching a pattern
[group('test')]
test-match pattern:
    node_modules/.bin/vitest run --reporter=verbose "{{pattern}}"

# Watch mode
[group('test')]
test-watch *args:
    node_modules/.bin/vitest {{args}}

# Run only tests for changed/staged files
[group('test')]
test-changed:
    node_modules/.bin/vitest run --changed

# Run our specific kb-index fix tests
[group('test')]
test-kb:
    node_modules/.bin/vitest run --reporter=verbose tests/core/kb-index-directory.test.ts

# Run a specific test file verbosely
[group('test')]
test-file file:
    node_modules/.bin/vitest run --reporter=verbose "{{file}}"

# ── KB (knowledge base) ───────────────────────────────────────────────────────

# Index a file or directory into the global KB
[group('kb')]
kb-index path source:
    CONTEXT_MODE_KNOWLEDGE_DB={{root}}/.kb.db \
        node cli.bundle.mjs kb-index --path "{{path}}" --source "{{source}}"

# Search the global KB
[group('kb')]
kb-search query:
    CONTEXT_MODE_KNOWLEDGE_DB={{root}}/.kb.db \
        node cli.bundle.mjs kb-search --query "{{query}}"

# Show KB stats
[group('kb')]
kb-stats:
    CONTEXT_MODE_KNOWLEDGE_DB={{root}}/.kb.db \
        node cli.bundle.mjs stats

# Index this project's source into the local KB
[group('kb')]
kb-index-src:
    CONTEXT_MODE_KNOWLEDGE_DB={{root}}/.kb.db \
        node cli.bundle.mjs kb-index --path "{{root}}/src" --source "context-mode/src"

# Index this project's docs into the local KB
[group('kb')]
kb-index-docs:
    CONTEXT_MODE_KNOWLEDGE_DB={{root}}/.kb.db \
        node cli.bundle.mjs kb-index --path "{{root}}/docs" --source "context-mode/docs"

# ── Repo ──────────────────────────────────────────────────────────────────────

# Short status + recent commits
[group('repo')]
st:
    @git status -s
    @git log --oneline -7

# Pull from origin with rebase
[group('repo')]
pull:
    git pull --rebase origin main

# Push to origin (force-with-lease safe)
[group('repo')]
push:
    git push --force-with-lease origin main

# Show what's ahead/behind origin
[group('repo')]
sync-status:
    @git fetch origin
    @echo "=== ahead ==="
    @git log origin/main..HEAD --oneline
    @echo "=== behind ==="
    @git log HEAD..origin/main --oneline | head -20

# Bump version and stage all manifest files
[group('repo')]
version:
    npm run version

# ── CI ────────────────────────────────────────────────────────────────────────

# Full CI: typecheck → bundle → assert → test
[group('ci')]
ci:
    just typecheck
    just bundle
    just assert
    just test

# Fast CI: bundle cli+server only → test (skips tsc, hooks)
[group('ci')]
ci-fast:
    just bundle-cli
    just bundle-server
    just test
