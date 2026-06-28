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

# Build cli and install to ~/.local/bin/ctx
[group('build')]
install-cli: bundle-cli bundle-server
    cp cli.bundle.mjs ~/.local/bin/ctx
    chmod +x ~/.local/bin/ctx
    ln -sf {{root}}/server.bundle.mjs ~/.local/bin/ctx-server
    @echo "installed → ~/.local/bin/ctx (copy) + ctx-server (symlink)"

# Start HTTP daemon on port 4748 (detached) for CLI use
[group('dev')]
daemon-start:
    node server.bundle.mjs --http {{env_var_or_default("CONTEXT_MODE_DAEMON_PORT", "4748")}}

# Check daemon status
[group('dev')]
daemon-status:
    node cli.bundle.mjs daemon status

# Stop daemon
[group('dev')]
daemon-stop:
    node cli.bundle.mjs daemon stop

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

# Sync version from package.json to all plugin manifests
[group('build')]
version-sync:
    node scripts/version-sync.mjs

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

# Smoke-test all CLI subcommands against cli.bundle.mjs (14 checks)
[group('test')]
test-cli:
    node scripts/test-cli.mjs

# Smoke-test all 13 MCP tools via JSON-RPC against server.bundle.mjs (19 checks)
[group('test')]
test-mcp:
    CONTEXT_MODE_KNOWLEDGE_DB=/tmp/ctx-test-mcp-$PPID.db node scripts/test-mcp.mjs

# Run both CLI and MCP smoke tests
[group('test')]
test-all: test-cli test-mcp
    @echo "All smoke tests passed."

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

# ── ETL Ingestion ─────────────────────────────────────────────────────────────

etl_repo    := env_var_or_default("ETL_REPO", "/home/sagemaker-user/studio/airflow/repos/etl.master")
etl_cli     := "/home/sagemaker-user/.pi/agent/git/github.com/fsabado/context-mode/cli.bundle.mjs"
# Extensions safe to index as text (no binaries — store.index reads any regular file as utf-8)
etl_exts    := "py sql yaml yml md hql tf sh json txt proto rst java"
etl_dir     := env_var_or_default("ETL_CONTEXT_DIR", "/home/sagemaker-user/.context-mode/etl")
# Tracks git commit SHA of last completed full ingest — enables git-diff incremental updates
etl_commit  := env_var_or_default("ETL_COMMIT_FILE", "/home/sagemaker-user/.context-mode/etl-commit.txt")
# Tracks which top-level folders finished first-time full ingest
etl_state   := env_var_or_default("ETL_STATE", "/home/sagemaker-user/.context-mode/etl-ingested.txt")

# Ingest etl.master — incremental by git diff since last ingest commit
# First run:  full folder-by-folder ingest, saves HEAD SHA when complete
# Next runs:  only re-index files changed since last saved SHA (git diff)
# Usage: just ingest-etl            → incremental (git diff) or full if first time
#        just ingest-etl dir=lib    → force re-ingest one folder
#        just ingest-etl force=true → full re-ingest, resets commit tracker
[group('kb')]
ingest-etl dir="" force="false":
    #!/usr/bin/env bash
    set -euo pipefail
    REPO="{{etl_repo}}"
    CLI="{{etl_cli}}"
    EXTS="{{etl_exts}}"
    export CONTEXT_MODE_DIR="{{etl_dir}}"
    STATE="{{etl_state}}"
    COMMIT_FILE="{{etl_commit}}"
    mkdir -p "$CONTEXT_MODE_DIR"
    touch "$STATE"

    EXT_PATTERN=$(echo "$EXTS" | tr ' ' '|')

    # Index one file; label = etl.master/<parent-dir>
    index_file() {
        local file="$1" label="$2"
        [[ ! -s "$file" ]] && return 0
        node "$CLI" index "$file" --source "$label" --project "$REPO" 2>/dev/null
    }

    # Build eval-safe find -name args for allowed extensions
    ext_args() {
        local first=1
        for ext in $EXTS; do
            [[ $first -eq 0 ]] && printf ' -o'
            printf ' -name "*.%s"' "$ext"
            first=0
        done
    }

    ingest_folder() {
        local folder="$1"
        local rel_folder="${folder#$REPO/}"
        local count=0 skipped=0 errors=0
        mapfile -t FILES < <(eval "find '$folder' -type f \( $(ext_args) \)" | sort)
        local total=${#FILES[@]}
        [[ $total -eq 0 ]] && return
        echo "--- $rel_folder ($total files) ---"
        for file in "${FILES[@]}"; do
            count=$((count + 1))
            if [[ ! -s "$file" ]]; then skipped=$((skipped + 1)); continue; fi
            rel="${file#$REPO/}"
            if index_file "$file" "etl.master/${rel%/*}"; then
                printf "\r  [%d/%d] %-72s" "$count" "$total" "$rel"
            else
                errors=$((errors + 1))
                printf "\n  ERR: %s\n" "$rel" >&2
            fi
        done
        printf "\n  done: indexed=%d skipped=%d errors=%d\n" \
            "$((count - skipped - errors))" "$skipped" "$errors"
        echo "$rel_folder" >> "$STATE"
    }

    # ── Single folder mode ──
    if [[ -n "{{dir}}" ]]; then
        echo "=== Force ingesting: {{dir}} ==="
        ingest_folder "$REPO/{{dir}}"
        exit 0
    fi

    CURRENT_SHA=$(git -C "$REPO" rev-parse HEAD)
    LAST_SHA=$(cat "$COMMIT_FILE" 2>/dev/null || echo "")

    # ── Incremental mode: only files changed since last ingest ──
    if [[ -n "$LAST_SHA" && "{{force}}" != "true" ]]; then
        if [[ "$LAST_SHA" == "$CURRENT_SHA" ]]; then
            echo "Already up to date ($CURRENT_SHA). Nothing to do."
            exit 0
        fi
        echo "=== ETL incremental ingest ==="
        echo "Diff: $LAST_SHA → $CURRENT_SHA"
        echo ""
        mapfile -t CHANGED < <(
            git -C "$REPO" diff --name-only "$LAST_SHA" "$CURRENT_SHA" 2>/dev/null \
            | grep -E "\.(${EXT_PATTERN})$" || true
        )
        if [[ ${#CHANGED[@]} -eq 0 ]]; then
            echo "No changed files matching allowed extensions. Nothing to do."
            echo "$CURRENT_SHA" > "$COMMIT_FILE"
            exit 0
        fi
        echo "Changed files: ${#CHANGED[@]}"
        count=0 skipped=0 errors=0
        for rel in "${CHANGED[@]}"; do
            file="$REPO/$rel"
            count=$((count + 1))
            if [[ ! -f "$file" ]]; then
                # Deleted — skip indexing, old chunks stay (stale but harmless)
                skipped=$((skipped + 1))
                printf "\r  [%d/%d] DELETED %-60s" "$count" "${#CHANGED[@]}" "$rel"
                continue
            fi
            if index_file "$file" "etl.master/${rel%/*}"; then
                printf "\r  [%d/%d] %-72s" "$count" "${#CHANGED[@]}" "$rel"
            else
                errors=$((errors + 1))
                printf "\n  ERR: %s\n" "$rel" >&2
            fi
        done
        printf "\n"
        echo "Done. indexed=$((count - skipped - errors)) skipped=$skipped errors=$errors"
        echo "$CURRENT_SHA" > "$COMMIT_FILE"
        exit 0
    fi

    # ── Full ingest (first time or force=true) ──
    echo "=== ETL full ingest ==="
    echo "Repo:  $REPO"
    echo "State: $STATE"
    echo "DB:    $CONTEXT_MODE_DIR"
    [[ "{{force}}" == "true" ]] && > "$STATE"  # reset folder tracker on force
    echo ""

    total_folders=0 done_folders=0 skip_folders=0
    while IFS= read -r folder; do
        rel="${folder#$REPO/}"
        total_folders=$((total_folders + 1))
        if grep -qxF "$rel" "$STATE" 2>/dev/null; then
            skip_folders=$((skip_folders + 1))
            continue
        fi
        ingest_folder "$folder"
        done_folders=$((done_folders + 1))
    done < <(find "$REPO" -mindepth 1 -maxdepth 1 -type d | sort)

    # Root-level files
    if ! grep -qxF "." "$STATE" 2>/dev/null; then
        mapfile -t ROOT_FILES < <(eval "find '$REPO' -maxdepth 1 -type f \( $(ext_args) \)" | sort)
        if [[ ${#ROOT_FILES[@]} -gt 0 ]]; then
            echo "--- root (${#ROOT_FILES[@]} files) ---"
            for file in "${ROOT_FILES[@]}"; do
                rel="${file#$REPO/}"
                index_file "$file" "etl.master/." && printf "  %s\n" "$rel" || printf "  ERR: %s\n" "$rel" >&2
            done
            echo "." >> "$STATE"
        fi
    fi

    echo ""
    echo "=== Done. folders: ingested=$done_folders skipped=$skip_folders total=$total_folders ==="
    # Save HEAD SHA — next run diffs from here
    echo "$CURRENT_SHA" > "$COMMIT_FILE"
    echo "Commit tracked: $CURRENT_SHA"

# Show ingestion state: ingested folders, pending folders, last commit
[group('kb')]
ingest-etl-status:
    @echo "=== Last ingested commit ==="
    @cat "{{etl_commit}}" 2>/dev/null || echo "(none — full ingest not complete)"
    @echo ""
    @echo "=== Ingested folders ==="
    @cat "{{etl_state}}" 2>/dev/null | sort || echo "(none yet)"
    @echo ""
    @echo "=== Pending folders ==="
    @comm -23 \
        <(find "{{etl_repo}}" -mindepth 1 -maxdepth 1 -type d | sed 's|{{etl_repo}}/||' | sort) \
        <(sort "{{etl_state}}" 2>/dev/null) \
        2>/dev/null || echo "(all done or state missing)"
    @echo ""
    @echo "DB: {{etl_dir}}/content/"

# Ingest a single file manually
# Usage: just ingest-etl-file dags/some_dag.py
[group('kb')]
ingest-etl-file path:
    CONTEXT_MODE_DIR="{{etl_dir}}" node "{{etl_cli}}" index "{{etl_repo}}/{{path}}" \
        --source "etl.master/{{path}}" \
        --project "{{etl_repo}}"

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
