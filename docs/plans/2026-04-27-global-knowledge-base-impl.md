# Global Persistent Knowledge Base + Full CLI — Implementation Plan

> **For Claude:** Use the `executing-plans` skill to implement this plan task-by-task.

**Goal:** Add a persistent global knowledge base (`~/.context-mode/knowledge.db`) alongside the ephemeral session DB, expose it via 2 new MCP tools (`ctx_kb_index`, `ctx_kb_search`), and add full CLI subcommands for all MCP tools with `--json` and `--session` flags.

**Architecture:** A second `ContentStore` instance (`kbStore`) opens at server startup from `CONTEXT_MODE_KNOWLEDGE_DB` env var (default `~/.context-mode/knowledge.db`). Session store unchanged. CLI subcommands call `ContentStore` directly — no JSON-RPC overhead.

**Tech Stack:** TypeScript, better-sqlite3, zod, @clack/prompts, existing `ContentStore`

---

### Task 1: `getKbStore()` — global KB store singleton

**Files:**
- Modify: `src/server.ts` — add after `getStore()` function (~line 205)

**Step 1: Write the failing test**

```typescript
// tests/core/kb-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, existsSync } from "node:fs";

describe("getKbStore", () => {
  const testDb = join(tmpdir(), `test-knowledge-${process.pid}.db`);

  afterEach(() => {
    for (const s of ["", "-wal", "-shm"]) {
      try { rmSync(testDb + s); } catch {}
    }
  });

  it("returns null when CONTEXT_MODE_KNOWLEDGE_DB not set", async () => {
    delete process.env.CONTEXT_MODE_KNOWLEDGE_DB;
    const { getKbStore } = await import("../../src/server.js");
    expect(getKbStore()).toBeNull();
  });

  it("creates ContentStore at specified path", async () => {
    process.env.CONTEXT_MODE_KNOWLEDGE_DB = testDb;
    const { getKbStore } = await import("../../src/server.js");
    const store = getKbStore();
    expect(store).not.toBeNull();
    expect(existsSync(testDb)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd ~/src/context-mode && npm test -- tests/core/kb-store.test.ts
```
Expected: FAIL — `getKbStore` not exported

**Step 3: Implement**

Add to `src/server.ts` after `getStore()`:

```typescript
// ─────────────────────────────────────────────────────────
// Global persistent knowledge base
// ─────────────────────────────────────────────────────────

let _kbStore: ContentStore | null = null;
let _kbStoreInitialized = false;

/**
 * Resolve ~ in path (Node doesn't do this automatically)
 */
function resolveKbPath(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Returns the global KB ContentStore, or null if not configured.
 * Lazy singleton — created on first call.
 * Never cleaned up by age — knowledge base is permanent.
 */
export function getKbStore(): ContentStore | null {
  if (_kbStoreInitialized) return _kbStore;
  _kbStoreInitialized = true;

  const rawPath = process.env.CONTEXT_MODE_KNOWLEDGE_DB
    ?? join(homedir(), ".context-mode", "knowledge.db");

  if (!rawPath) return null;

  try {
    const kbPath = resolveKbPath(rawPath);
    const kbDir = dirname(kbPath);
    mkdirSync(kbDir, { recursive: true });
    _kbStore = new ContentStore(kbPath);
  } catch (err) {
    process.stderr.write(`[context-mode] KB store init failed: ${err}\n`);
    _kbStore = null;
  }

  return _kbStore;
}
```

**Step 4: Run test to verify it passes**

```bash
cd ~/src/context-mode && npm test -- tests/core/kb-store.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
cd ~/src/context-mode
git add src/server.ts tests/core/kb-store.test.ts
git commit -m "feat(kb): add getKbStore() singleton for global persistent knowledge base"
```

---

### Task 2: `ctx_kb_index` MCP tool

**Files:**
- Modify: `src/server.ts` — add after `ctx_index` tool handler (~line 1170)

**Step 1: Write the failing test**

```typescript
// tests/core/server.test.ts — add to existing test file
it("ctx_kb_index indexes into global KB", async () => {
  process.env.CONTEXT_MODE_KNOWLEDGE_DB = join(tmpdir(), `kb-test-${process.pid}.db`);
  const result = await callTool("ctx_kb_index", {
    content: "# Test\nHello world",
    source: "test-source"
  });
  expect(result.content[0].text).toContain("Indexed");
  expect(result.content[0].text).toContain("test-source");
});
```

**Step 2: Run test to verify it fails**

```bash
cd ~/src/context-mode && npm test -- tests/core/server.test.ts -t "ctx_kb_index"
```
Expected: FAIL — tool not found

**Step 3: Implement**

Add to `src/server.ts` after `ctx_index` handler:

```typescript
server.tool(
  "ctx_kb_index",
  {
    title: "Index into Knowledge Base",
    description:
      "Index content into the GLOBAL PERSISTENT knowledge base. " +
      "Content persists across all sessions — use for codebases, docs, skills you want always available.\n\n" +
      "Unlike ctx_index (session-only), this survives session restarts.\n\n" +
      "WHEN TO USE:\n" +
      "- Indexing a repo you want searchable in all future sessions\n" +
      "- Adding reference docs to a permanent library\n\n" +
      "After indexing, use ctx_kb_search() to query.",
    inputSchema: z.object({
      content: z.string().optional().describe("Raw text/markdown to index. Provide this OR path."),
      path: z.string().optional().describe("File path to read and index (content never enters context)."),
      source: z.string().describe("Label for the indexed content (e.g., 'lyft/etl', 'ai-skills')"),
    }),
  },
  async ({ content, path, source }) => {
    if (!content && !path) {
      return { content: [{ type: "text" as const, text: "Error: Either content or path must be provided" }], isError: true };
    }

    const kb = getKbStore();
    if (!kb) {
      return { content: [{ type: "text" as const, text: "Knowledge base not configured. Set CONTEXT_MODE_KNOWLEDGE_DB env var." }], isError: true };
    }

    try {
      const result = kb.index({ content, path, source });
      return {
        content: [{
          type: "text" as const,
          text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse ctx_kb_search(queries: ["..."]) to query. Use source: "${result.label}" to scope results.`,
        }],
      };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `KB index error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);
```

**Step 4: Run test to verify it passes**

```bash
cd ~/src/context-mode && npm test -- tests/core/server.test.ts -t "ctx_kb_index"
```
Expected: PASS

**Step 5: Commit**

```bash
cd ~/src/context-mode
git add src/server.ts
git commit -m "feat(kb): add ctx_kb_index MCP tool"
```

---

### Task 3: `ctx_kb_search` MCP tool

**Files:**
- Modify: `src/server.ts` — add after `ctx_kb_index` handler

**Step 1: Write the failing test**

```typescript
// tests/core/server.test.ts — add
it("ctx_kb_search searches global KB", async () => {
  // First index something
  await callTool("ctx_kb_index", { content: "# Acxiom\nMD5 hashed email column", source: "test" });
  // Then search
  const result = await callTool("ctx_kb_search", { queries: ["acxiom email"] });
  expect(result.content[0].text).toContain("Acxiom");
});

it("ctx_kb_search returns helpful message when KB empty", async () => {
  delete process.env.CONTEXT_MODE_KNOWLEDGE_DB;
  const result = await callTool("ctx_kb_search", { queries: ["anything"] });
  expect(result.content[0].text).toContain("Knowledge base");
});
```

**Step 2: Run test to verify it fails**

```bash
cd ~/src/context-mode && npm test -- tests/core/server.test.ts -t "ctx_kb_search"
```
Expected: FAIL

**Step 3: Implement**

Add to `src/server.ts` after `ctx_kb_index`:

```typescript
server.tool(
  "ctx_kb_search",
  {
    title: "Search Knowledge Base",
    description:
      "Search the GLOBAL PERSISTENT knowledge base — codebases, docs, and skills indexed via ctx_kb_index or CLI.\n\n" +
      "Use this (not ctx_search) when you want content that persists across sessions:\n" +
      "- Lyft repos (lyft/etl, lyft/ads, etc.)\n" +
      "- ai-skills, linux-env\n" +
      "- Any content indexed with ctx_kb_index\n\n" +
      "Use ctx_search for content indexed THIS session only.",
    inputSchema: z.object({
      queries: z.array(z.string()).min(1).max(8).describe("Search queries (1-8). Use varied phrasing for broader coverage."),
      source: z.string().optional().describe("Optional: scope to a specific source label (e.g., 'lyft/etl')"),
    }),
  },
  async ({ queries, source }) => {
    const kb = getKbStore();
    if (!kb) {
      return {
        content: [{
          type: "text" as const,
          text: "Knowledge base is empty or not configured.\nRun: context-mode kb-index --path <file> --source <label>\nOr set CONTEXT_MODE_KNOWLEDGE_DB env var.",
        }],
      };
    }

    const stats = kb.getStats();
    if (stats.chunks === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "Knowledge base is empty. Populate it with:\n  context-mode kb-index --path <file> --source <label>",
        }],
      };
    }

    // Reuse same formatting logic as ctx_search
    const allResults: SearchResult[] = [];
    for (const query of queries) {
      const results = kb.searchWithFallback(query, 5, source);
      allResults.push(...results);
    }

    // Deduplicate by title+source
    const seen = new Set<string>();
    const deduped = allResults.filter(r => {
      const key = `${r.source}::${r.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (deduped.length === 0) {
      return { content: [{ type: "text" as const, text: `No results found in knowledge base for: ${queries.join(", ")}` }] };
    }

    // Format same as ctx_search
    const formatted = formatSearchResults(deduped, queries);
    return { content: [{ type: "text" as const, text: formatted }] };
  }
);
```

**Step 4: Run test to verify it passes**

```bash
cd ~/src/context-mode && npm test -- tests/core/server.test.ts -t "ctx_kb_search"
```
Expected: PASS

**Step 5: Commit**

```bash
cd ~/src/context-mode
git add src/server.ts
git commit -m "feat(kb): add ctx_kb_search MCP tool"
```

---

### Task 4: CLI — `search`, `index`, `stats`, `sources` subcommands

**Files:**
- Modify: `src/cli.ts` — add subcommand dispatch before server start

**Step 1: Write the failing test**

```typescript
// tests/core/cli.test.ts — add
it("search subcommand outputs results as plain text", async () => {
  // pre-index something
  const db = join(tmpdir(), `cli-test-${process.pid}.db`);
  process.env.CONTEXT_MODE_KNOWLEDGE_DB = db;
  // index first
  execSync(`node dist/cli.js kb-index --content "# Test\nHello world" --source test`);
  const out = execSync(`node dist/cli.js search --query "hello"`).toString();
  expect(out).toContain("Test");
});

it("search --json outputs valid JSON", async () => {
  const out = execSync(`node dist/cli.js search --query "hello" --json`).toString();
  const parsed = JSON.parse(out);
  expect(parsed).toHaveProperty("results");
  expect(Array.isArray(parsed.results)).toBe(true);
});

it("stats --json outputs valid JSON", async () => {
  const out = execSync(`node dist/cli.js stats --json`).toString();
  const parsed = JSON.parse(out);
  expect(parsed).toHaveProperty("chunks");
  expect(parsed).toHaveProperty("dbPath");
});
```

**Step 2: Run test to verify it fails**

```bash
cd ~/src/context-mode && npm run build && npm test -- tests/core/cli.test.ts -t "subcommand"
```
Expected: FAIL

**Step 3: Implement**

Add to `src/cli.ts` in the subcommand dispatch block:

```typescript
// ── KB / search subcommands ──────────────────────────────

if (args[0] === "search" || args[0] === "kb-search") {
  const query = getFlag("--query") ?? getFlag("-q");
  const source = getFlag("--source") ?? getFlag("-s");
  const isJson = hasFlag("--json");
  const useSession = hasFlag("--session");

  if (!query) { console.error("Error: --query required"); process.exit(1); }

  const store = useSession ? getSessionStoreForCli() : getKbStoreForCli();
  if (!store) { console.error("Knowledge base not found. Run kb-index first."); process.exit(1); }

  const results = store.searchWithFallback(query, 10, source ?? undefined);

  if (isJson) {
    console.log(JSON.stringify({
      results: results.map(r => ({
        title: r.title,
        content: r.content,
        source: r.source,
        rank: r.rank,
        contentType: r.contentType,
      }))
    }, null, 2));
  } else {
    if (results.length === 0) { console.log("No results found."); }
    else {
      for (const r of results) {
        console.log(`\n--- [${r.source}] ---`);
        console.log(`### ${r.title}\n`);
        console.log(r.content);
      }
    }
  }
  process.exit(0);
}

if (args[0] === "index" || args[0] === "kb-index") {
  const path = getFlag("--path");
  const content = getFlag("--content");
  const source = getFlag("--source") ?? getFlag("-s");
  const isJson = hasFlag("--json");
  const useSession = hasFlag("--session");

  if (!path && !content) { console.error("Error: --path or --content required"); process.exit(1); }
  if (!source) { console.error("Error: --source required"); process.exit(1); }

  const store = useSession ? getSessionStoreForCli() : getKbStoreForCli();
  if (!store) { console.error("Failed to open store."); process.exit(1); }

  const result = store.index({ path: path ?? undefined, content: content ?? undefined, source });

  if (isJson) {
    console.log(JSON.stringify({ source: result.label, totalChunks: result.totalChunks, codeChunks: result.codeChunks, sourceId: result.sourceId }, null, 2));
  } else {
    console.log(`Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}`);
  }
  store.close();
  process.exit(0);
}

if (args[0] === "stats") {
  const isJson = hasFlag("--json");
  const useSession = hasFlag("--session");
  const store = useSession ? getSessionStoreForCli() : getKbStoreForCli();
  if (!store) { console.log(isJson ? '{"sources":0,"chunks":0,"codeChunks":0}' : "Knowledge base empty."); process.exit(0); }

  const stats = store.getStats();
  const dbPath = useSession ? "session" : resolveKbPath(process.env.CONTEXT_MODE_KNOWLEDGE_DB ?? join(homedir(), ".context-mode", "knowledge.db"));

  if (isJson) {
    console.log(JSON.stringify({ ...stats, dbPath }, null, 2));
  } else {
    console.log(`Sources: ${stats.sources}  Chunks: ${stats.chunks}  Code: ${stats.codeChunks}`);
    console.log(`DB: ${dbPath} (${Math.round(store.getDBSizeBytes() / 1024 / 1024)}MB)`);
  }
  process.exit(0);
}

if (args[0] === "sources") {
  const isJson = hasFlag("--json");
  const useSession = hasFlag("--session");
  const store = useSession ? getSessionStoreForCli() : getKbStoreForCli();
  if (!store) { console.log(isJson ? '{"sources":[]}' : "Knowledge base empty."); process.exit(0); }

  const sources = store.listSources();
  if (isJson) {
    console.log(JSON.stringify({ sources }, null, 2));
  } else {
    for (const s of sources) console.log(`${s.label} (${s.chunkCount} chunks)`);
  }
  process.exit(0);
}
```

Also add helper functions at top of CLI subcommand section:

```typescript
function getKbStoreForCli(): ContentStore | null {
  const rawPath = process.env.CONTEXT_MODE_KNOWLEDGE_DB
    ?? join(homedir(), ".context-mode", "knowledge.db");
  try {
    const kbPath = resolveKbPath(rawPath);
    mkdirSync(dirname(kbPath), { recursive: true });
    return new ContentStore(kbPath);
  } catch { return null; }
}

function getSessionStoreForCli(): ContentStore | null {
  try {
    const dbPath = join(tmpdir(), `context-mode-cli-${process.pid}.db`);
    return new ContentStore(dbPath);
  } catch { return null; }
}

function getFlag(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
```

**Step 4: Run tests to verify they pass**

```bash
cd ~/src/context-mode && npm run build && npm test -- tests/core/cli.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
cd ~/src/context-mode
git add src/cli.ts
git commit -m "feat(cli): add search, index, stats, sources subcommands with --json and --session flags"
```

---

### Task 5: Update justfile to use new CLI

**Files:**
- Modify: `~/src/justfile` — replace JSON-RPC hack in `ctx-index` recipe

**Step 1: Verify CLI works end-to-end**

```bash
cd ~/src/context-mode && npm run build
node dist/cli.js kb-index --path /tmp/lm_batch1.txt --source "lyft/etl-test" --json
# Expected: {"source":"lyft/etl-test","totalChunks":N,...}
node dist/cli.js search --query "acxiom" --json | jq '.results[0].source'
```

**Step 2: Update justfile `ctx-index` recipe**

Replace the `ctx-index` recipe in `~/src/justfile`:

```just
# Index a repo directly into context-mode global KB: just ctx-index etl
[group('index')]
ctx-index repo:
    #!/usr/bin/env bash
    dir="{{src}}/{{repo}}"
    [[ ! -d "$dir" ]] && echo "❌ {{repo}} not found" && exit 1
    outfile="/tmp/idx_{{repo}}.txt"
    echo "Building file list for {{repo}}..."
    find "$dir" -type f \( -name '*.py' -o -name '*.md' -o -name '*.sh' -o -name '*.yaml' -o -name '*.yml' -o -name '*.ts' -o -name '*.tf' \) \
      | grep -v '__pycache__\|\.git\|node_modules\|\.venv\|venv\|\.terraform\|studio-env-vars' \
      | sort \
      | while read f; do echo "### FILE: $f"; cat "$f" 2>/dev/null; echo; done > "$outfile"
    files=$(grep -c '^### FILE:' "$outfile" || echo 0)
    echo "Indexing $files files into knowledge base as 'lyft/{{repo}}'..."
    context-mode kb-index --path "$outfile" --source "lyft/{{repo}}" --json \
      | python3 -c "import json,sys; r=json.load(sys.stdin); print(f'✓ {r[\"totalChunks\"]} sections indexed from lyft/{{repo}}')"
```

**Step 3: Test**

```bash
just --justfile ~/src/justfile ctx-index skills
```
Expected: `✓ N sections indexed from lyft/skills`

**Step 4: Commit**

```bash
cd ~/src
git add justfile
git commit -m "chore(justfile): use context-mode CLI for ctx-index instead of JSON-RPC hack"
```

---

### Task 6: Clean up MCP config — remove session suffix hack

**Files:**
- Modify: `~/.pi/agent/mcp.json`
- Modify: `~/.claude/settings.json`

**Step 1: Remove env var overrides**

```json
// ~/.pi/agent/mcp.json — remove CONTEXT_MODE_SESSION_SUFFIX and CLAUDE_PROJECT_DIR
{
  "mcpServers": {
    "context-mode": {
      "command": "/home/sagemaker-user/.nvm/versions/node/v24.15.0/bin/node",
      "args": ["/home/sagemaker-user/.local/lib/node_modules/context-mode/server.bundle.mjs"]
    }
  }
}
```

The global KB is now managed by `CONTEXT_MODE_KNOWLEDGE_DB` (defaulting to `~/.context-mode/knowledge.db`) — no cwd hacks needed.

**Step 2: Verify sessions still work**

Start pi, run:
```
mcp({ tool: "ctx_kb_search", args: '{"queries": ["acxiom schema"]}' })
```
Expected: results from `~/.context-mode/knowledge.db`

**Step 3: Commit**

```bash
# No git commit needed — these are config files, not in a repo
```

---

### Task 7: Build, bundle, and install local fork

**Files:**
- `~/src/context-mode/` — build output
- `~/.local/lib/node_modules/context-mode/` — installed package

**Step 1: Build**

```bash
cd ~/src/context-mode
npm install
npm run build && npm run bundle
```

**Step 2: Verify bundle**

```bash
node ~/src/context-mode/server.bundle.mjs --version 2>/dev/null | head -2
node ~/src/context-mode/cli.bundle.mjs --help 2>/dev/null | head -5
```

**Step 3: Install as local package**

```bash
# Point pi to local fork instead of npm
npm install -g ~/src/context-mode
# OR symlink
ln -sf ~/src/context-mode ~/.local/lib/node_modules/context-mode
```

**Step 4: Smoke test**

```bash
context-mode stats --json
context-mode kb-index --content "# Test\nHello" --source test --json
context-mode search --query "hello" --json | jq '.results[0].title'
```
Expected: all pass

**Step 5: Commit**

```bash
cd ~/src/context-mode
git add .
git commit -m "build: bundle with global KB and full CLI support"
git push origin main
```

---

## Verification Checklist

- [ ] `ctx_kb_index` MCP tool works in pi session
- [ ] `ctx_kb_search` MCP tool returns results from `~/.context-mode/knowledge.db`
- [ ] `ctx_search` still works as before (session DB unchanged)
- [ ] `context-mode search --query "..." --json` works from shell
- [ ] `context-mode kb-index --path file --source label` works from shell
- [ ] `s ctx-index etl` uses new CLI (no JSON-RPC)
- [ ] `s reindex` populates global KB for all core repos
- [ ] New pi session can immediately search previously indexed content
