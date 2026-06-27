# Incremental `indexDirectory` Implementation Plan

> **For Claude:** Use the `executing-plans` skill to implement this plan task-by-task.

**Goal:** Make `indexDirectory({ incremental: true })` skip unchanged files using mtime → SHA-256 gate, delete chunks for removed files, and expose the flag through CLI (`--incremental`) and MCP (`incremental: bool`).

**Architecture:** Add two new tables (`file_manifest`, `chunk_files`) to `ContentStore` for per-file tracking. All logic lives in `store.indexDirectory()`. CLI and MCP each pass the flag through in one line. Full re-index (default) unchanged.

**Tech Stack:** TypeScript, better-sqlite3, existing `walkDirectoryDetailed`, `createHash` (already imported in store.ts).

**Constraints (from pre-implementation review):**
- **No source label change.** Per-file labels (`lyft/etl/sql:/abs/path/file.py`) are preserved on full re-index. The shared directory label is only used on the incremental path. Avoids breaking `ctx_search(source: "...")` scoping for existing users.
- **`trackChunkFiles` flag on `#insertChunks`.** Only write `chunk_files` rows when called from `indexDirectory` incremental path. Pass `trackChunkFiles?: boolean` into `#insertChunks` to avoid unbounded growth from single-file `index()` calls.
- **Single read per file.** On both full re-index and incremental paths, read each file once (via `openSync`/`readFileSync`), pass `content` directly to `index()`, and hash the same bytes for the manifest. No double-read.

---

### Task 1: Add `file_manifest` and `chunk_files` tables to schema

**Files:**
- Modify: `src/store.ts` — schema init block (~line 448) + prepared statements (~line 539)

**Step 1: Write the failing test**

In `tests/core/kb-index-directory.test.ts`, add at the end of the `describe` block:

```typescript
describe("file_manifest and chunk_files schema", () => {
  it("ContentStore creates file_manifest and chunk_files tables", async () => {
    if (!(await hasFts5())) return;
    const { ContentStore } = await import("../../src/store.js");
    const db = join(tmpdir(), `ctx-schema-test-${process.pid}.db`);
    const store = new ContentStore(db);
    // Access internal DB to verify tables exist
    // We verify indirectly: indexDirectory must not throw on first call
    const dir = join(tmpdir(), `ctx-schema-dir-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "# A\nContent.");
    const r = store.indexDirectory({ path: dir, source: "schema-test" });
    expect(r.filesIndexed).toBe(1);
    store.close();
    for (const s of ["", "-wal", "-shm"]) { try { rmSync(db + s); } catch {} }
    try { rmSync(dir, { recursive: true }); } catch {}
  });
});
```

**Step 2: Run test — expect pass (schema test is structural, will pass once tables added)**

```bash
cd /mnt/custom-file-systems/efs/fs-04bf86d02daf87e14/src/context-mode
node_modules/.bin/vitest run tests/core/kb-index-directory.test.ts
```

**Step 3: Add tables to ContentStore schema**

In `src/store.ts`, find the `CREATE TABLE IF NOT EXISTS sources` block (~line 448) and add after the `CREATE INDEX IF NOT EXISTS idx_sources_label` line:

```typescript
      CREATE TABLE IF NOT EXISTS file_manifest (
        abs_path     TEXT PRIMARY KEY,
        dir_source   TEXT NOT NULL,
        mtime_ms     INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_manifest_source ON file_manifest(dir_source);
      CREATE TABLE IF NOT EXISTS chunk_files (
        chunk_rowid  INTEGER NOT NULL,
        file_path    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_files_path ON chunk_files(file_path);
```

Also add ALTER TABLE fallbacks after the existing ones (~line 533):
```typescript
try { this.#db.exec("ALTER TABLE file_manifest ADD COLUMN dir_source TEXT NOT NULL DEFAULT ''"); } catch {}
```
(Not needed — new table, always created fresh. Skip ALTER for new tables.)

**Step 4: Add prepared statements** (~line 350 field declarations, ~line 539 init)

Field declarations (after existing `#stmtDeleteSourcesByLabel`):
```typescript
#stmtManifestGet!: PreparedStatement;
#stmtManifestUpsert!: PreparedStatement;
#stmtManifestUpdateMtime!: PreparedStatement;
#stmtManifestDelete!: PreparedStatement;
#stmtManifestBySource!: PreparedStatement;
#stmtManifestReplaceAll!: PreparedStatement;
#stmtChunkFilesInsert!: PreparedStatement;
#stmtChunkFilesDeleteByPath!: PreparedStatement;
#stmtChunkRowidsByPath!: PreparedStatement;
```

Prepared statement init (after existing delete stmts):
```typescript
this.#stmtManifestGet = this.#db.prepare(
  "SELECT abs_path, dir_source, mtime_ms, content_hash FROM file_manifest WHERE abs_path = ?"
);
this.#stmtManifestUpsert = this.#db.prepare(
  "INSERT INTO file_manifest (abs_path, dir_source, mtime_ms, content_hash) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(abs_path) DO UPDATE SET dir_source=excluded.dir_source, mtime_ms=excluded.mtime_ms, " +
  "content_hash=excluded.content_hash, indexed_at=datetime('now')"
);
this.#stmtManifestUpdateMtime = this.#db.prepare(
  "UPDATE file_manifest SET mtime_ms = ?, indexed_at = datetime('now') WHERE abs_path = ?"
);
this.#stmtManifestDelete = this.#db.prepare(
  "DELETE FROM file_manifest WHERE abs_path = ?"
);
this.#stmtManifestBySource = this.#db.prepare(
  "SELECT abs_path, mtime_ms, content_hash FROM file_manifest WHERE dir_source = ?"
);
this.#stmtChunkFilesInsert = this.#db.prepare(
  "INSERT INTO chunk_files (chunk_rowid, file_path) VALUES (?, ?)"
);
this.#stmtChunkFilesDeleteByPath = this.#db.prepare(
  "DELETE FROM chunk_files WHERE file_path = ?"
);
this.#stmtChunkRowidsByPath = this.#db.prepare(
  "SELECT chunk_rowid FROM chunk_files WHERE file_path = ?"
);
```

**Step 5: Run test**
```bash
node_modules/.bin/vitest run tests/core/kb-index-directory.test.ts
```
Expected: all pass.

**Step 6: Commit**
```bash
git add src/store.ts tests/core/kb-index-directory.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(store): add file_manifest and chunk_files schema for incremental indexing"
```

---

### Task 2: Populate `chunk_files` in `#insertChunks`

**Files:**
- Modify: `src/store.ts` — `#insertChunks` method (~line 1014)

**Step 1: Write failing test**

Add to `tests/core/kb-index-directory.test.ts`:

```typescript
describe("chunk_files population", () => {
  it("indexDirectory populates chunk_files rows", async () => {
    if (!(await hasFts5())) return;
    const { ContentStore } = await import("../../src/store.js");
    const db = join(tmpdir(), `ctx-chunkfiles-${process.pid}.db`);
    const store = new ContentStore(db);
    const dir = join(tmpdir(), `ctx-chunkfiles-dir-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "# A\nContent about A.");
    writeFileSync(join(dir, "b.md"), "# B\nContent about B.");
    store.indexDirectory({ path: dir, source: "cf-test" });
    // chunk_files rows exist — verify via re-index behaviour (indirect)
    // Direct verification: re-index one file and confirm old chunks gone
    writeFileSync(join(dir, "a.md"), "# A updated\nNew content.");
    const r2 = store.indexDirectory({ path: dir, source: "cf-test", incremental: true });
    expect(r2.filesIndexed).toBe(1);
    expect(r2.filesSkipped).toBe(1);
    store.close();
    for (const s of ["", "-wal", "-shm"]) { try { rmSync(db + s); } catch {} }
    try { rmSync(dir, { recursive: true }); } catch {}
  });
});
```

Run: expect **FAIL** (`filesSkipped` not yet returned, `incremental` not yet implemented).

**Step 2: Add `chunk_files` insertion in `#insertChunks`**

Inside the transaction in `#insertChunks`, after `this.#stmtInsertChunk.run(...)`:
```typescript
// Track chunk → file mapping for incremental delete
if (filePath) {
  const rowid = this.#db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number };
  this.#stmtChunkFilesInsert.run(rowid.r, filePath);
}
```

But `last_insert_rowid()` inside a loop is fragile. Better: use the rowid returned by `stmtInsertChunk.run().lastInsertRowid`:

```typescript
const chunkInfo = this.#stmtInsertChunk.run(chunk.title, chunk.content, sourceId, ct, null, sessionIdCol, eventIdCol, now);
this.#stmtInsertChunkTrigram.run(chunk.title, chunk.content, sourceId, ct, null, sessionIdCol, eventIdCol, now);
if (filePath) {
  this.#stmtChunkFilesInsert.run(Number(chunkInfo.lastInsertRowid), filePath);
}
```

Also add a cleanup helper (private method) for deleting chunks by file path:
```typescript
#deleteChunksByFilePath(absPath: string): void {
  const rows = this.#stmtChunkRowidsByPath.all(absPath) as Array<{ chunk_rowid: number }>;
  for (const { chunk_rowid } of rows) {
    this.#db.prepare("DELETE FROM chunks WHERE rowid = ?").run(chunk_rowid);
    this.#db.prepare("DELETE FROM chunks_trigram WHERE rowid = ?").run(chunk_rowid);
  }
  this.#stmtChunkFilesDeleteByPath.run(absPath);
}
```

(Prepare the two DELETE stmts as cached fields too — add to declarations and `#prepareStatements`):
```typescript
#stmtDeleteChunkByRowid!: PreparedStatement;
#stmtDeleteChunkTrigramByRowid!: PreparedStatement;
// init:
this.#stmtDeleteChunkByRowid = this.#db.prepare("DELETE FROM chunks WHERE rowid = ?");
this.#stmtDeleteChunkTrigramByRowid = this.#db.prepare("DELETE FROM chunks_trigram WHERE rowid = ?");
```

Update `#deleteChunksByFilePath` to use them:
```typescript
#deleteChunksByFilePath(absPath: string): void {
  const rows = this.#stmtChunkRowidsByPath.all(absPath) as Array<{ chunk_rowid: number }>;
  this.#db.transaction(() => {
    for (const { chunk_rowid } of rows) {
      this.#stmtDeleteChunkByRowid.run(chunk_rowid);
      this.#stmtDeleteChunkTrigramByRowid.run(chunk_rowid);
    }
    this.#stmtChunkFilesDeleteByPath.run(absPath);
  })();
}
```

**Step 3: Commit (partial — chunk_files population only, test still fails on incremental)**
```bash
git add src/store.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(store): populate chunk_files on insert, add #deleteChunksByFilePath"
```

---

### Task 3: Implement incremental path in `indexDirectory`

**Files:**
- Modify: `src/store.ts` — `indexDirectory` method (~line 889)

**Step 1: Update `indexDirectory` signature and return type**

Add `incremental?: boolean` to opts and `filesSkipped` / `filesDeleted` to return type:

```typescript
indexDirectory(opts: {
  path: string;
  source?: string;
  incremental?: boolean;
  attribution?: { sessionId?: string; eventId?: string };
  perFileDeny?: (absPath: string) => boolean;
} & WalkOptions): {
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  totalChunks: number;
  capped: boolean;
  totalSeen: number;
  denied: number;
  failed: number;
  label: string;
}
```

**Step 2: Implement incremental path**

Replace the method body with:

```typescript
const { path: rootPath, source, incremental, attribution, perFileDeny, ...walkOpts } = opts;
const walked = walkDirectoryDetailed(rootPath, walkOpts);
const dirSource = source ?? rootPath;

let filesIndexed = 0;
let filesSkipped = 0;
let filesDeleted = 0;
let totalChunks = 0;
let denied = 0;
let failed = 0;

if (incremental) {
  // Load existing manifest for this source
  const manifestRows = this.#stmtManifestBySource.all(dirSource) as Array<{
    abs_path: string; mtime_ms: number; content_hash: string;
  }>;
  const manifest = new Map(manifestRows.map(r => [r.abs_path, r]));
  const walkedSet = new Set(walked.files);

  // Deletion sweep: files in manifest but not in current walk → deleted
  for (const [absPath, _row] of manifest) {
    if (!walkedSet.has(absPath)) {
      this.#deleteChunksByFilePath(absPath);
      this.#stmtManifestDelete.run(absPath);
      filesDeleted++;
    }
  }

  // Per-file incremental check
  for (const file of walked.files) {
    if (perFileDeny && perFileDeny(file)) { denied++; continue; }
    try {
      const mtimeMs = statSync(file).mtimeMs;
      const row = manifest.get(file);

      // Fast path: mtime unchanged
      if (row && row.mtime_ms === mtimeMs) {
        filesSkipped++;
        continue;
      }

      // mtime changed — read and hash
      const fd = openSync(file, "r");
      let content: string;
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) { failed++; continue; }
        content = readFileSync(fd, "utf-8");
      } finally {
        closeSync(fd);
      }
      const newHash = createHash("sha256").update(content).digest("hex");

      // Hash unchanged — mtime drifted only, update mtime and skip
      if (row && row.content_hash === newHash) {
        this.#stmtManifestUpdateMtime.run(mtimeMs, file);
        filesSkipped++;
        continue;
      }

      // Content changed or new file — delete old chunks, re-index
      if (row) this.#deleteChunksByFilePath(file);
      const r = this.index({ path: file, content, source: dirSource, attribution });
      this.#stmtManifestUpsert.run(file, dirSource, mtimeMs, newHash);
      filesIndexed++;
      totalChunks += r.totalChunks;
    } catch {
      failed++;
    }
  }
} else {
  // Full re-index (existing behaviour) — but use dirSource as the label
  // and update manifest for all files
  this.#db.prepare("DELETE FROM file_manifest WHERE dir_source = ?").run(dirSource);
  this.#db.prepare(
    "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)"
  ).run(dirSource);
  this.#db.prepare(
    "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)"
  ).run(dirSource);
  this.#db.prepare("DELETE FROM sources WHERE label = ?").run(dirSource);

  for (const file of walked.files) {
    if (perFileDeny && perFileDeny(file)) { denied++; continue; }
    try {
      const r = this.index({ path: file, source: dirSource, attribution });
      const mtimeMs = statSync(file).mtimeMs;
      // content_hash stored by index() in sources.content_hash — retrieve it
      const meta = this.getSourceMeta(`${dirSource}`) ;
      // Simpler: hash inline
      const content = readFileSync(file, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");
      this.#stmtManifestUpsert.run(file, dirSource, mtimeMs, hash);
      filesIndexed++;
      totalChunks += r.totalChunks;
    } catch {
      failed++;
    }
  }
}

return {
  filesIndexed, filesSkipped, filesDeleted,
  totalChunks,
  capped: walked.capped,
  totalSeen: walked.totalSeen,
  denied, failed,
  label: dirSource,
};
```

**Note:** The full re-index path above double-reads files (once in `index()`, once for manifest hash). Optimise by reading once: pass `content` to `index()` and hash the same bytes. Refactor:

```typescript
// in full re-index loop:
const fd = openSync(file, "r");
let content: string;
try {
  const st = fstatSync(fd);
  if (!st.isFile()) { failed++; continue; }
  content = readFileSync(fd, "utf-8");
} finally { closeSync(fd); }
const hash = createHash("sha256").update(content).digest("hex");
const mtimeMs = statSync(file).mtimeMs;
const r = this.index({ path: file, content, source: dirSource, attribution });
this.#stmtManifestUpsert.run(file, dirSource, mtimeMs, hash);
filesIndexed++;
totalChunks += r.totalChunks;
```

**Step 3: Check `createHash` is imported**
```bash
grep "createHash" src/store.ts | head -3
```
If not present, add to imports: `import { createHash } from "node:crypto";`

Also verify `openSync`, `fstatSync`, `readFileSync`, `closeSync`, `statSync` are imported (they are — confirmed earlier).

**Step 4: Run tests**
```bash
node_modules/.bin/vitest run tests/core/kb-index-directory.test.ts
```
Expected: all pass including the new `chunk_files population` test.

**Step 5: Commit**
```bash
git add src/store.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(store): implement incremental indexDirectory with file_manifest + chunk_files"
```

---

### Task 4: Add incremental test cases

**Files:**
- Modify: `tests/core/kb-index-directory.test.ts`

**Step 1: Add full incremental test suite**

Add a new `describe("indexDirectory incremental", ...)` block:

```typescript
describe("indexDirectory — incremental", () => {
  let dir: string;
  let db: string;
  let store: InstanceType<typeof ContentStore>;

  beforeEach(async () => {
    if (!(await hasFts5())) return;
    const { ContentStore } = await import("../../src/store.js");
    dir = join(tmpdir(), `ctx-incr-${process.pid}-${Date.now()}`);
    db  = join(tmpdir(), `ctx-incr-${process.pid}-${Date.now()}.db`);
    mkdirSync(dir, { recursive: true });
    store = new ContentStore(db);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    for (const s of ["", "-wal", "-shm"]) { try { rmSync(db + s); } catch {} }
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  it("initial index: filesSkipped=0, filesIndexed=N", async () => {
    if (!(await hasFts5())) return;
    writeFileSync(join(dir, "a.md"), "# A\nContent A.");
    writeFileSync(join(dir, "b.md"), "# B\nContent B.");
    const r = store.indexDirectory({ path: dir, source: "incr", incremental: true });
    expect(r.filesIndexed).toBe(2);
    expect(r.filesSkipped).toBe(0);
    expect(r.filesDeleted).toBe(0);
  });

  it("re-run unchanged: all files skipped", async () => {
    if (!(await hasFts5())) return;
    writeFileSync(join(dir, "a.md"), "# A\nContent A.");
    store.indexDirectory({ path: dir, source: "incr", incremental: true });
    const r2 = store.indexDirectory({ path: dir, source: "incr", incremental: true });
    expect(r2.filesSkipped).toBe(1);
    expect(r2.filesIndexed).toBe(0);
    expect(r2.filesDeleted).toBe(0);
  });

  it("modified file: only that file re-indexed", async () => {
    if (!(await hasFts5())) return;
    writeFileSync(join(dir, "a.md"), "# A\nOriginal.");
    writeFileSync(join(dir, "b.md"), "# B\nUnchanged.");
    store.indexDirectory({ path: dir, source: "incr", incremental: true });
    // modify a.md
    writeFileSync(join(dir, "a.md"), "# A\nModified content.");
    const r2 = store.indexDirectory({ path: dir, source: "incr", incremental: true });
    expect(r2.filesIndexed).toBe(1);
    expect(r2.filesSkipped).toBe(1);
  });

  it("deleted file: chunks purged, manifest row removed", async () => {
    if (!(await hasFts5())) return;
    writeFileSync(join(dir, "a.md"), "# A\nWill be deleted.");
    writeFileSync(join(dir, "b.md"), "# B\nStays.");
    store.indexDirectory({ path: dir, source: "incr", incremental: true });
    rmSync(join(dir, "a.md"));
    const r2 = store.indexDirectory({ path: dir, source: "incr", incremental: true });
    expect(r2.filesDeleted).toBe(1);
    expect(r2.filesSkipped).toBe(1);
    // Search should not find deleted content
    const results = store.searchWithFallback("Will be deleted", 5, "incr");
    expect(results.length).toBe(0);
  });

  it("mtime drift without content change: skipped (hash gate)", async () => {
    if (!(await hasFts5())) return;
    const filePath = join(dir, "a.md");
    writeFileSync(filePath, "# A\nSame content.");
    store.indexDirectory({ path: dir, source: "incr", incremental: true });
    // Touch mtime without changing content
    const now = new Date();
    utimesSync(filePath, now, now);
    const r2 = store.indexDirectory({ path: dir, source: "incr", incremental: true });
    expect(r2.filesSkipped).toBe(1);
    expect(r2.filesIndexed).toBe(0);
  });
});
```

Add `utimesSync` to the import: `import { ..., utimesSync } from "node:fs";`

**Step 2: Run tests**
```bash
node_modules/.bin/vitest run tests/core/kb-index-directory.test.ts --reporter=verbose
```
Expected: all pass.

**Step 3: Commit**
```bash
git add tests/core/kb-index-directory.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "test(store): incremental indexDirectory test suite (5 cases)"
```

---

### Task 5: Wire CLI and MCP (one line each)

**Files:**
- Modify: `src/cli.ts` — `runKbCmd` directory branch
- Modify: `src/server.ts` — `ctx_kb_index` handler

**Step 1: CLI**

In `runKbCmd`, find the `isDirectory()` block and update:
```typescript
// before:
const result = store.indexDirectory({ path: filePath, source, maxFiles, maxDepth });

// after:
const incremental = hasCliFlag("--incremental");
const result = store.indexDirectory({ path: filePath, source, maxFiles, maxDepth, incremental });
```

Update output to show skipped/deleted counts:
```typescript
// text output (non-JSON):
console.log(
  `Indexed ${result.filesIndexed} files (+${result.filesSkipped} skipped, ${result.filesDeleted} deleted) — ${result.totalChunks} chunks in: ${result.label}`,
);

// JSON output:
JSON.stringify({
  source: result.label,
  totalChunks: result.totalChunks,
  filesIndexed: result.filesIndexed,
  filesSkipped: result.filesSkipped,
  filesDeleted: result.filesDeleted,
}, null, 2)
```

**Step 2: MCP**

In `src/server.ts` `ctx_kb_index` handler, add to `inputSchema`:
```typescript
incremental: z.boolean().optional().describe(
  "Only re-index files whose content changed since last run (mtime + SHA-256 gate). " +
  "Deleted files are purged. Safe to call repeatedly — fast on unchanged repos."
),
```

Update the directory branch of the handler:
```typescript
// before:
const result = kb.indexDirectory({ path, source });

// after:
const result = kb.indexDirectory({ path, source, incremental });
```

Update the response text:
```typescript
text: `Indexed ${result.filesIndexed} files (+${result.filesSkipped} skipped, ${result.filesDeleted} deleted) — ${result.totalChunks} sections from: ${result.label}` +
  `\nUse ctx_kb_search(queries: ["..."]) to query.`,
```

**Step 3: TypeScript check**
```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep "src/cli\|src/server\|src/store" | head -10
```
Expected: no errors.

**Step 4: Bundle**
```bash
just bundle-cli && just bundle-server
```

**Step 5: Smoke test**
```bash
DB=/tmp/incr-smoke-$$.db
# First run (full)
CONTEXT_MODE_KNOWLEDGE_DB=$DB node cli.bundle.mjs kb-index \
  --path docs/ --source "smoke" --json
# Second run (incremental, nothing changed)
CONTEXT_MODE_KNOWLEDGE_DB=$DB node cli.bundle.mjs kb-index \
  --path docs/ --source "smoke" --incremental --json
# Expect: filesIndexed=0, filesSkipped=N
```

**Step 6: Commit**
```bash
git add src/cli.ts src/server.ts cli.bundle.mjs server.bundle.mjs
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(cli,mcp): wire --incremental flag to indexDirectory"
```

---

### Task 6: Update justfile ingest recipes + run final test suite

**Files:**
- Modify: `justfile` — add `--incremental` to all `ingest-*` recipes
- Modify: `scripts/test-cli.mjs` — add incremental smoke check

**Step 1: Update justfile**

For each `ingest-*` recipe, add `--incremental` as a default after initial full index. Pattern:
```just
# Re-index etl/sql — skips unchanged files on repeat runs
[group('ingest')]
ingest-etl-sql:
    #!/usr/bin/env bash
    set -euo pipefail
    DB={{etl_kb}}
    echo "➤ Indexing etl/sql → $DB"
    time CONTEXT_MODE_KNOWLEDGE_DB="$DB" node {{cm}} kb-index \
        --path {{repos_dir}}/etl.master/sql \
        --source "lyft/etl/sql" \
        --max-files 500 \
        --incremental
    CONTEXT_MODE_KNOWLEDGE_DB="$DB" node {{cm}} stats
```

**Step 2: Add incremental smoke to `scripts/test-cli.mjs`**

After the existing `kb-index --path <dir>` check:
```javascript
// incremental: second run on same dir should skip all
check("kb-index --path <dir> --incremental (second run skips all)", () => {
  const r = cli("kb-index", "--path", docsDir, "--source", "cli-incr", "--incremental", "--json");
  if (r.status !== 0) return { ok: false, detail: r.stderr };
  let obj;
  try { obj = JSON.parse(r.stdout); } catch { return { ok: false, detail: `not JSON: ${r.stdout}` }; }
  // First run — no prior manifest, so all files indexed
  // Run again
  const r2 = cli("kb-index", "--path", docsDir, "--source", "cli-incr", "--incremental", "--json");
  if (r2.status !== 0) return { ok: false, detail: r2.stderr };
  let obj2;
  try { obj2 = JSON.parse(r2.stdout); } catch { return { ok: false, detail: `not JSON: ${r2.stdout}` }; }
  return {
    ok: obj2.filesSkipped > 0 && obj2.filesIndexed === 0,
    detail: JSON.stringify(obj2),
  };
});
```

**Step 3: Run full test suite**
```bash
node_modules/.bin/vitest run tests/core/kb-index-directory.test.ts --reporter=verbose
just test-cli
just test-mcp
```
Expected: all pass.

**Step 4: Performance smoke on etl/sql**
```bash
just ingest-etl-sql     # first run (full)
just ingest-etl-sql     # second run (incremental, ~0 changes expected)
# Second run should complete in < 5s
```

**Step 5: Commit and push**
```bash
git add justfile scripts/test-cli.mjs
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "chore: wire --incremental into justfile ingest recipes and test-cli smoke"
git push --force-with-lease origin main
```

---

## Addendum: code-chunk integration for Python/code files

**Added:** 2026-06-27

### Problem
context-mode's `#chunkMarkdown` splits on `#` headings. Python files have none → one blob per file → poor search granularity.

### Solution
[`code-chunk`](https://github.com/supermemoryai/code-chunk) (npm, TypeScript, tree-sitter) splits `.py`/`.ts`/`.go`/`.rs`/`.js`/`.java` at AST boundaries (functions, classes, methods). Output per chunk includes scope chain + imports.

### Integration approach
Preprocessor script `scripts/ingest-code.mjs`:
1. Walk files with `code-chunk`
2. Convert each function/class chunk → markdown: `# ClassName > method_name\n\ncontent`
3. Call `kb-index --content <markdown> --source lyft/etl:/abs/path/file.py`

Per-file source labels preserved — no store changes needed. context-mode FTS5/BM25 handles storage and search as usual.

### Files
- `scripts/ingest-code.mjs` — new preprocessor script
- `justfile` — add `ingest-etl-code` recipe using code-chunk path
