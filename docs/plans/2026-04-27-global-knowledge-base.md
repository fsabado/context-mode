# Design: Global Persistent Knowledge Base + Full CLI

**Date:** 2026-04-27  
**Author:** Francis Sabado  
**Status:** Approved

---

## Problem

context-mode's knowledge index is ephemeral — it dies with the session. For large,
rarely-changing codebases (lyft/etl, lyft/ads, ai-skills, etc.) this means re-indexing
on every session start, which is slow and wasteful. There's also no way to use
context-mode tools from shell scripts without the JSON-RPC hack.

---

## Goals

1. **Global persistent KB** — index repos once via CLI, available in all sessions forever
2. **Session DB unchanged** — existing ephemeral behavior fully preserved
3. **AI chooses which DB to query** — separate tools, explicit intent
4. **Full CLI** — every MCP tool exposed as a CLI subcommand with `--json` support

---

## Non-Goals

- Merging/syncing session DB into global KB automatically
- Per-project persistent DBs (may come later)
- Changing any existing `ctx_*` tool signatures

---

## Architecture

```
~/.context-mode/knowledge.db              ← global KB (persistent, CLI-populated)
  └── ContentStore (kbStore)              ← read-write from CLI, read-only hint in sessions

~/.claude/context-mode/content/<hash>.db  ← session DB (ephemeral, unchanged)
  └── ContentStore (sessionStore)         ← existing behavior, untouched
```

Two `ContentStore` instances in the same server process. `kbStore` opens at startup
if `knowledge.db` exists, creates it on first `ctx_kb_index` call.

---

## Environment Variable

```bash
CONTEXT_MODE_KNOWLEDGE_DB=~/.context-mode/knowledge.db   # default
```

- Resolved at server startup with `~` expansion
- Overridable for custom paths
- If unset or empty, global KB is disabled (no `ctx_kb_*` tools registered)

---

## New MCP Tools (2)

### `ctx_kb_index`

Index content into the global persistent knowledge base.

```typescript
Input: {
  path?: string      // file path — content never enters context window
  content?: string   // raw text (one of path or content required)
  source: string     // label e.g. "lyft/etl", "ai-skills"
}

Output: "Indexed N sections (M with code) from: <source>
         Use ctx_kb_search(queries: [...]) to query."
```

### `ctx_kb_search`

Search the global persistent knowledge base.

```typescript
Input: {
  queries: string[]   // 1-8 queries, same interface as ctx_search
  source?: string     // optional label filter e.g. "lyft/etl"
}

Output: // same format as ctx_search
```

**AI guidance in tool descriptions:**
- `ctx_search` — "Search current session index. Use for output indexed this session."
- `ctx_kb_search` — "Search global knowledge base. Use for codebases, docs, skills — content indexed via CLI."

---

## Full CLI Surface

All MCP tools exposed as CLI subcommands. Default DB is **global KB**.
Use `--session` flag to target the session DB instead.

```bash
# Knowledge base (global, persistent) — default
context-mode search   --query "acxiom schema" [--source lyft/etl] [--json]
context-mode index    --path <file> --source <label> [--json]
context-mode kb-search  --query "..." [--source ...] [--json]   # alias for search
context-mode kb-index   --path <file> --source <label> [--json] # alias for index

# Session DB (ephemeral)
context-mode search   --query "..." --session [--json]
context-mode index    --path <file> --source <label> --session [--json]

# Informational (no DB flag needed)
context-mode stats    [--session] [--json]
context-mode sources  [--session] [--json]
context-mode purge    [--session]           # session only — never purge global KB
context-mode execute  --language shell --code "ls ~/src" [--json]
context-mode doctor   [--json]
```

### JSON Output Shapes

```typescript
// search / kb-search
{
  results: Array<{
    title: string
    content: string
    source: string
    rank: number
    contentType: "code" | "prose"
  }>
}

// index / kb-index
{
  source: string
  totalChunks: number
  codeChunks: number
  sourceId: number
}

// stats
{
  sources: number
  chunks: number
  codeChunks: number
  dbSizeBytes: number
  dbPath: string
}

// sources
{
  sources: Array<{ label: string; chunkCount: number }>
}

// execute
{
  output: string
  exitCode: number
  language: string
}

// doctor
{
  checks: Array<{ name: string; status: "pass" | "fail" | "warn"; message: string }>
}
```

---

## Code Changes

| File | Change |
|---|---|
| `src/server.ts` | Instantiate `kbStore` from env var path; register `ctx_kb_index` + `ctx_kb_search` tools; update tool descriptions to guide AI |
| `src/cli.ts` | Add all subcommands: `search`, `index`, `kb-search`, `kb-index`, `stats`, `sources`, `purge`, `execute`; add `--json` and `--session` flags |
| `src/store.ts` | **No changes** — `ContentStore` already supports persistent DBs |
| `src/adapters/*` | **No changes** |
| `hooks/*` | **No changes** |

Total: 2 files changed. ~200 lines added.

---

## Global KB Lifecycle

| Event | Behavior |
|---|---|
| Server start, KB exists | Open read-write |
| Server start, KB missing | Skip (no `ctx_kb_*` tools registered) |
| First `ctx_kb_index` call | Create DB + index |
| Re-index same source | Atomic dedup — delete old, insert new (existing behavior) |
| File-backed sources | Auto-refresh on search if mtime changed (existing behavior) |
| Age-based cleanup | **Never** — global KB is permanent |
| `purge` CLI command | Session DB only — never touches global KB |

---

## Justfile Integration

After this ships, `~/src/justfile` `ctx-index` recipe becomes:

```bash
# Before (JSON-RPC hack)
printf '{"jsonrpc"...}' | node server.bundle.mjs | python3 ...

# After (clean CLI)
context-mode kb-index --path /tmp/idx_etl.txt --source lyft/etl --json \
  | jq '.totalChunks'
```

---

## Implementation Order

1. `src/server.ts` — `kbStore` instantiation + 2 new MCP tools
2. `src/cli.ts` — full CLI with `--json` + `--session` flags
3. Build + test
4. Update `~/src/justfile` to use new CLI
5. Update `~/.pi/agent/mcp.json` — remove `CONTEXT_MODE_SESSION_SUFFIX` hack

---

## Open Questions

- Should `ctx_kb_search` appear in the MCP tool list when KB is empty (no `knowledge.db`)? 
  → Recommendation: **yes, always register** — return helpful message "Knowledge base is empty. Run `context-mode kb-index` to populate."
