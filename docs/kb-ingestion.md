# Knowledge Base Ingestion Guide

This guide covers building and maintaining pre-built knowledge bases (KBs) for fast
search and discovery across repos and session history.

---

## Storage layout

All KBs live on EFS (`~/studio/pi/`) — persistent across instance recycles.

| KB | Path | Contents |
|---|---|---|
| Global default | `~/studio/pi/knowledge/knowledge.db` | Symlinked from `~/.context-mode/knowledge.db` |
| Pi sessions | `~/studio/pi/.sessions.kb.db` | Past conversation history |
| ETL repo | `~/studio/airflow/repos/etl.master/.etl.kb.db` | Lyft ETL codebase |
| Dashboards | `~/studio/airflow/repos/dashboards.master/.dashboards.kb.db` | Grafana dashboards repo |
| Veritydata | `~/studio/airflow/repos/veritydata.master/.veritydata.kb.db` | Verity data repo |

Select a KB by setting `CONTEXT_MODE_KNOWLEDGE_DB` before any CLI command:

```bash
CONTEXT_MODE_KNOWLEDGE_DB=~/studio/pi/.sessions.kb.db \
  context-mode kb-search --query "kyte backfill"
```

---

## File types that index well

context-mode's chunker (`#chunkMarkdown`) splits on `# ## ### ####` headings.

| Type | Indexes? | Chunks well? | Notes |
|---|---|---|---|
| `.md` `.mdx` | ✅ default | ✅ excellent | Headings → clean chunks |
| `.txt` | ✅ default | ⚠ one blob | No headings → single chunk per file |
| `.yaml` `.yml` | ✅ default | ⚠ one blob | |
| `.json` | ✅ default | ⚠ one blob | |
| `.py` | ✅ default | ⚠ one blob | No markdown headings in Python |
| `.ts` `.js` `.tsx` `.jsx` | ✅ default | ⚠ one blob | |
| `.sh` `.go` `.rs` | ✅ default | ⚠ one blob | |
| `.sql` `.hql` | ❌ not default | ⚠ one blob | Add via `--ext .sql,.hql` |
| `.jsonl` | ❌ not default | ❌ unusable | Raw JSON lines, no headings |
| binary, images | ❌ | ❌ | Not readable |

**Rule of thumb:** if the file has `#`-prefixed section headings it will chunk well.
Python/SQL/YAML index as flat searchable text — useful but coarse-grained.

### Better chunking for code: `code-chunk`

For Python/TypeScript/Go/Rust/Java, use
[`code-chunk`](https://github.com/supermemoryai/code-chunk) (npm) as a preprocessor:

1. Parse file with tree-sitter → split at function/class boundaries
2. Emit each function as markdown with `# ClassName > method_name` heading
3. Pass markdown to `kb-index --content` — context-mode then chunks by heading

This gives function-level search granularity instead of file-level blobs.
See `scripts/ingest-code.mjs` (planned).

---

## Session history ingestion

Pi session JSONL files (`~/studio/pi/sessions/`) are not directly indexable — they
contain raw JSON with no headings, producing one 3MB blob per file.

Use `scripts/ingest-sessions.mjs` to preprocess them:

```bash
# Index all sessions (incremental by default — skips already-indexed dates)
node /path/to/context-mode/scripts/ingest-sessions.mjs

# Index sessions since a date
node scripts/ingest-sessions.mjs --since 2026-06-01

# Force re-index everything
node scripts/ingest-sessions.mjs --reindex

# Dry run — show what would be indexed
node scripts/ingest-sessions.mjs --dry-run
```

**How it works:**
- Reads each `.jsonl` file
- Extracts `user` and `assistant` text blocks (skips tool calls, tool results, thinking)
- Formats as markdown: `# Session <date> — <cwd>` with `## User` / `## Assistant` turns
- Calls `kb-index --content <markdown> --source pi/sessions:<date>`
- Source labels are date-based: `pi/sessions:2026-06-27`

**Incremental:** By default skips any date label already in the KB. Sessions are
immutable once written — safe to skip.

**Large sessions:** Files >100KB of extracted text are written to a temp file and
indexed via `--path` to avoid OS argument size limits (`E2BIG`).

---

## ETL repo ingestion

The ETL repo has 21,496 files across multiple types. Not all are worth indexing.

**Recommended tiers:**

| Tier | Dirs | Exts | Files | Time | Value |
|---|---|---|---|---|---|
| 1 — fast | `sql/`, `test/`, `docs/` | `.py .sql .hql .md .yaml` | ~2,400 | ~3 min | ⭐⭐⭐ |
| 2 — full | `lib/` | `.py .sql .hql .md .yaml` | ~15,000 | ~15 min | ⭐⭐⭐ |
| skip | — | `.csv .png .java .config .deprecated` | — | — | noise |

**Run via justfile** (in context-mode repo):

```bash
just ingest-etl-sql     # Tier 1: sql/ + test/ + docs/ (~3 min)
just ingest-etl-lib     # Tier 2: lib/ (~15 min)
just ingest-etl-full    # Both tiers sequentially
```

**Search the ETL KB:**

```bash
just kb-search-repo etl "acxiom write impressions"
just kb-search-repo etl "PySpark operator transform"
just kb-search-repo etl "lyft media audience extension"
```

**Performance baseline (2026-06-27):**
- Rate: ~0.174s/file (single-read fix applied — was ~0.148s/file double-read)
- Full run (4,932 files): 14m 20s
- Chunker: flat text per `.py` file — upgrade path is `code-chunk` preprocessing

---

## Persistent storage

All KBs are on EFS and survive instance recycles. `~/.context-mode/knowledge.db`
is symlinked to `~/studio/pi/knowledge/knowledge.db`.

`~/.pi/context-mode/` (sessions + content DBs) is symlinked to
`~/studio/pi/context-mode/`.

These symlinks are managed by `~/studio/pi-agent/justfile`:

```bash
cd ~/studio/pi-agent && just link-persistent   # recreate all symlinks on fresh instance
cd ~/studio/pi-agent && just status            # verify symlink health
```

---

## Adding a new KB

1. Choose a path on EFS: `~/studio/pi/<name>.kb.db`
2. Index: `CONTEXT_MODE_KNOWLEDGE_DB=~/studio/pi/<name>.kb.db context-mode kb-index --path <dir> --source "<label>"`
3. Search: `CONTEXT_MODE_KNOWLEDGE_DB=~/studio/pi/<name>.kb.db context-mode kb-search --query "..."`
4. Add a `just ingest-<name>` recipe to the context-mode `justfile`
