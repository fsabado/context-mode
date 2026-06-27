# Design: Incremental `indexDirectory` with `file_manifest`

**Date:** 2026-06-27  
**Status:** Approved  
**Goal:** Make re-ingestion of large repos (e.g. lyft/etl, 11k files) fast by skipping
unchanged files. Full re-index takes ~14 min; incremental re-run with no changes
should take < 2s.

---

## Problem

`indexDirectory()` currently does a full DELETE + re-insert of all chunks for the
source label on every call. There is no per-file tracking — every file is re-read,
re-chunked, and re-inserted regardless of whether it changed.

`#refreshStaleSources()` already implements mtime → SHA-256 incremental re-index, but
only for single-file sources (`file_path IS NOT NULL` in the `sources` table). Directory
sources get per-file labels (`lyft/etl/sql:/abs/path/file.py`) which pollutes search
results with thousands of source entries.

---

## Design

### Layer map

```
CLI (--incremental flag)  ──┐
                             ├──► store.indexDirectory({ incremental: true })
MCP (incremental: bool)   ──┘              │
                                           ▼
                                  file_manifest table
                                  mtime → hash gate
                                  skip / re-index / delete
```

All logic lives in `store.indexDirectory()`. CLI and MCP are one-line callers.

---

### 1. Schema — `file_manifest` table

Added in `ContentStore` constructor via `CREATE TABLE IF NOT EXISTS` (backward-
compatible; existing DBs get it on first open).

```sql
CREATE TABLE IF NOT EXISTS file_manifest (
  abs_path     TEXT PRIMARY KEY,
  dir_source   TEXT NOT NULL,       -- e.g. "lyft/etl/sql"
  mtime_ms     INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_manifest_source ON file_manifest(dir_source);
```

`sources` table and `chunks` table are **unchanged**. `file_manifest` is internal
tracking only — never queried by search, never exposed to callers.

---

### 2. Source label change

**Before:** every file in a directory gets its own source label:
`lyft/etl/sql:/abs/path/to/dag.py`

**After:** all files in a directory share the directory source label:
`lyft/etl/sql`

This makes `ctx_search(source: "lyft/etl/sql")` return clean results instead of
11k labelled entries. Per-file tracking moves to `file_manifest`.

**Impact:** `ctx_search` cannot scope to a single file within a directory source.
Acceptable trade-off for a pre-built KB use case. Single-file indexing via
`ctx_kb_index(path: "/abs/file.py")` is unchanged and still gets a per-file label.

---

### 3. `indexDirectory` algorithm

New opt: `incremental?: boolean` (default `false` — backward compatible).

```
indexDirectory(opts):
  walk all files (existing walkDirectoryDetailed, respects maxFiles/maxDepth/etc.)

  if incremental:
    load manifest rows for dir_source into a Map<abs_path, row>
    walked_set = new Set(walked.files)

    # deletion sweep
    for row in manifest where row.dir_source == source:
      if row.abs_path NOT IN walked_set:
        delete chunks WHERE source label == source AND chunks came from this file
        delete manifest row
        filesDeleted++

    for each file in walked.files:
      mtime_ms = statSync(file).mtimeMs
      row = manifest.get(file)
      if row exists AND row.mtime_ms == mtime_ms:
        filesSkipped++          # fast path — no read, no hash
        continue
      content = readFileSync(file)
      hash = sha256(content)
      if row exists AND row.hash == hash:
        manifest.update(mtime_ms)   # mtime drifted but content same
        filesSkipped++
        continue
      # changed or new file
      re-index: DELETE old chunks for this file (by abs_path lookup in manifest)
               INSERT new chunks with source label = dir_source
      manifest.upsert(abs_path, dir_source, mtime_ms, hash, now)
      filesIndexed++

  else (full re-index, current behaviour):
    DELETE all chunks for source label
    for each file: index with source label = dir_source
    manifest.replace_all(dir_source, walked files)

return { filesIndexed, filesSkipped, filesDeleted, totalChunks, capped, ... }
```

Deletion of specific file's chunks: since all files share one source label, we need
to track which chunks belong to which file. Two options:

**Option A (simplest):** Store `abs_path` as a hidden field in `file_manifest` only.
On re-index of a changed file: full DELETE of source label chunks + re-index all
non-deleted files from manifest. Correct but O(n) on change.

**Option B (efficient):** Add `file_path TEXT` column to `chunks` (non-FTS5 shadow
table or a separate `chunk_files` join table). On re-index of a changed file: DELETE
only chunks WHERE `file_path = abs_path`. O(1) per changed file.

**Recommendation: Option B** via a `chunk_files` shadow table (adding a column to an
FTS5 virtual table is not straightforward). Schema:

```sql
CREATE TABLE IF NOT EXISTS chunk_files (
  chunk_rowid INTEGER,
  file_path   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_files_path ON chunk_files(file_path);
```

Populated during `#insertChunks` when `filePath` is provided. On incremental
re-index of a changed file: `DELETE FROM chunks WHERE rowid IN (SELECT chunk_rowid
FROM chunk_files WHERE file_path = ?)`, then delete from `chunk_files` too.

---

### 4. Caller changes (one line each)

**`src/cli.ts` `runKbCmd`:**
```ts
const incremental = hasCliFlag("--incremental");
store.indexDirectory({ path: filePath, source, maxFiles, maxDepth, incremental });
```

Output gains `filesSkipped` / `filesDeleted` in both text and JSON modes.

**`src/server.ts` `ctx_kb_index` handler:**
```ts
// inputSchema adds:
incremental: z.boolean().optional().describe("Only re-index changed files (mtime+hash gate). Safe to call repeatedly.")

// handler:
store.indexDirectory({ path, source, incremental });
```

---

### 5. Performance expectation

| Scenario | Current | After |
|---|---|---|
| Full index, 11k files | ~14 min | ~14 min (unchanged) |
| Re-run, 0 files changed | ~14 min | < 2s (mtime check only) |
| Re-run, 10 files changed | ~14 min | ~1s + 10 × 0.074s ≈ 2s |
| Re-run, 500 files changed | ~14 min | ~37s |

---

### 6. Testing

- `indexDirectory(incremental: true)` on a temp dir:
  - Initial index → assert `filesIndexed = N`, `filesSkipped = 0`
  - Re-run unchanged → assert `filesSkipped = N`, `filesIndexed = 0`, `totalChunks` same
  - Modify one file → assert `filesIndexed = 1`, `filesSkipped = N-1`
  - Delete one file → assert `filesDeleted = 1`, manifest row gone, chunks purged
  - Touch file mtime without changing content → assert still skipped (hash gate)
- Existing `indexDirectory` tests unchanged (`incremental` defaults to `false`)

---

### Files to modify

| File | Change |
|---|---|
| `src/store.ts` | Add `file_manifest` + `chunk_files` tables; update `#insertChunks`; add incremental path to `indexDirectory` |
| `src/cli.ts` | Pass `incremental` flag in `runKbCmd`; update output text/JSON |
| `src/server.ts` | Add `incremental` param to `ctx_kb_index` schema + handler |
| `tests/core/kb-index-directory.test.ts` | Add incremental test cases |
| `justfile` | Add `--incremental` to ingest recipes |
