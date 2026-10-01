# Bug: `kb-index` does not support directory paths

**Date:** 2026-06-27
**Branch:** `origin/main` (not yet merged to local main)
**File:** `src/cli.ts` → `runKbCmd()`
**Severity:** Minor — workaround available (iterate files manually)

---

## Description

`context-mode kb-index --path <dir> --source <label>` fails with:

```
Error: refusing to index /path/to/dir/: not a regular file
```

The new `runKbCmd()` dispatcher (added in `feat(cli): add search, index, stats,
sources subcommands`) calls `store.index()` for both `kb-index` and `index`
subcommands. `store.index()` only accepts regular files — it throws on directories.

The old `index` command (still present, routes to `indexCommand()`) correctly calls
`store.indexDirectory()` for directory paths but targets the **session DB**, not the
global KB.

---

## Root Cause

`src/cli.ts` `runKbCmd()`, lines ~2189–2210:

```typescript
if (cmd === "index" || cmd === "kb-index") {
  // ...
  const store = openStore();
  const result = store.index({          // ← always calls index(), never indexDirectory()
    path: filePath ?? undefined,
    content: content ?? undefined,
    source,
  });
```

`store.index()` checks `isFile()` and throws on directories. `store.indexDirectory()`
exists and handles recursive directory walks with file caps, extension filters, etc.

---

## Fix (5 lines)

In `runKbCmd()`, detect if `--path` is a directory and route to `indexDirectory()`:

```typescript
if (cmd === "index" || cmd === "kb-index") {
  const filePath = getCliFlag("--path");
  const content = getCliFlag("--content");
  const source = getCliFlag("--source") ?? getCliFlag("-s");
  // ... validation ...

  const store = openStore();

  // ADD: detect directory
  if (filePath && statSync(filePath).isDirectory()) {
    const result = store.indexDirectory({ path: filePath, source });
    store.close();
    if (isJson) {
      console.log(JSON.stringify({ source: result.label, totalChunks: result.totalChunks, filesIndexed: result.filesIndexed }, null, 2));
    } else {
      console.log(`Indexed ${result.totalChunks} chunks from ${result.filesIndexed} files in: ${result.label}`);
    }
    process.exit(0);
  }

  // existing file/content path below...
  const result = store.index({ ... });
```

---

## Workaround

Iterate files manually from shell:

```bash
find ./docs -name "*.md" | while read f; do
  context-mode kb-index --path "$f" --source "my-project-docs"
done
```

Or use the old `index` command with a custom script that pipes to the global KB
via `CONTEXT_MODE_KNOWLEDGE_DB`.

---

## Reproduction

```bash
# Requires origin/main bundle
CONTEXT_MODE_KNOWLEDGE_DB=/tmp/test.db node server.bundle.mjs &
CONTEXT_MODE_KNOWLEDGE_DB=/tmp/test.db context-mode kb-index \
  --path ./docs/ --source "test"
# → Error: refusing to index ./docs/: not a regular file
```

---

## Notes

- `store.indexDirectory()` already exists in `src/store.ts` with full dir-walk,
  file caps (`maxFiles`), depth limits (`maxDepth`), extension filters — no new
  logic needed, just wire it up in the CLI dispatcher.
- The `index` (old) → `indexCommand()` path already does this correctly for the
  session DB. The fix mirrors that logic for the KB path.
- Needs a test in `tests/` covering `kb-index --path <dir>`.
