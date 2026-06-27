#!/usr/bin/env node
/**
 * scripts/test-cli.mjs
 *
 * Smoke-tests all CLI subcommands exposed by runKbCmd() and the legacy
 * index/search commands. Runs against cli.bundle.mjs with a temp DB.
 *
 * Subcommands tested:
 *   kb-index  --path <file>    index a single file
 *   kb-index  --path <dir>     index a directory  (the dir-routing fix)
 *   kb-index  --content        index inline content
 *   kb-index  --json           JSON output shape
 *   index     <file>           legacy positional index (session DB)
 *   kb-search --query          search global KB
 *   search    <query>          legacy positional search (session DB)
 *   stats                      global KB stats
 *   sources                    list indexed sources
 *
 * Exits 0 if every check passes, 1 on any failure.
 *
 * Usage:
 *   node scripts/test-cli.mjs
 */
import { spawnSync }    from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir }        from "node:os";

const root    = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle  = join(root, "cli.bundle.mjs");
const fixFile = join(root, "docs", "bugs", "kb-index-directory-support.md");
const docsDir = join(root, "docs");

// temp DB per run
const db = join(tmpdir(), `ctx-cli-test-${process.pid}.db`);

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let passed = 0, failed = 0;

function cli(...args) {
  return spawnSync("node", [bundle, ...args], {
    env: { ...process.env, CONTEXT_MODE_KNOWLEDGE_DB: db },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function check(label, fn) {
  try {
    const { ok, detail } = fn();
    if (ok) {
      console.log(`${PASS} ${label}\n    ${String(detail).split("\n")[0].slice(0, 100)}`);
      passed++;
    } else {
      console.log(`${FAIL} ${label}\n    ${String(detail).slice(0, 200)}`);
      failed++;
    }
  } catch (e) {
    console.log(`${FAIL} ${label}\n    THREW: ${e.message}`);
    failed++;
  }
}

function expectOk(r, pattern) {
  if (r.status !== 0) return { ok: false, detail: `exit ${r.status}: ${r.stderr || r.stdout}` };
  if (pattern && !pattern.test(r.stdout)) return { ok: false, detail: `pattern ${pattern} not in: ${r.stdout}` };
  return { ok: true, detail: r.stdout.trim() };
}

function expectJson(r, keys) {
  if (r.status !== 0) return { ok: false, detail: `exit ${r.status}: ${r.stderr || r.stdout}` };
  let obj;
  try { obj = JSON.parse(r.stdout); } catch { return { ok: false, detail: `not JSON: ${r.stdout}` }; }
  const missing = keys.filter(k => !(k in obj));
  if (missing.length) return { ok: false, detail: `missing keys ${missing}: ${r.stdout}` };
  return { ok: true, detail: r.stdout.trim() };
}

console.log("\n\x1b[1m── CLI subcommand smoke tests ────────────────────────────────\x1b[0m\n");

// ── kb-index: file ────────────────────────────────────────────────────────────
check("kb-index --path <file>", () =>
  expectOk(cli("kb-index", "--path", fixFile, "--source", "cli-file"), /Indexed \d+ sections/)
);

// ── kb-index: directory (the dir-routing fix) ─────────────────────────────────
check("kb-index --path <dir>  (directory routing fix)", () =>
  expectOk(cli("kb-index", "--path", docsDir, "--source", "cli-dir"), /Indexed \d+ chunks from \d+ files/)
);

// ── kb-index: inline --content ────────────────────────────────────────────────
check("kb-index --content (inline)", () =>
  expectOk(
    cli("kb-index", "--content", "# Inline test\nSome content.", "--source", "cli-inline"),
    /Indexed \d+ sections/
  )
);

// ── kb-index: --json file ─────────────────────────────────────────────────────
check("kb-index --path <file> --json  (JSON output)", () =>
  expectJson(
    cli("kb-index", "--path", fixFile, "--source", "cli-json", "--json"),
    ["source", "totalChunks", "codeChunks", "sourceId"]
  )
);

// ── kb-index: --json directory ────────────────────────────────────────────────
check("kb-index --path <dir> --json  (JSON output)", () =>
  expectJson(
    cli("kb-index", "--path", docsDir, "--source", "cli-dir-json", "--json"),
    ["source", "totalChunks", "filesIndexed"]
  )
);

// ── kb-index: missing --source → exit 1 ──────────────────────────────────────
check("kb-index missing --source → exit 1", () => {
  const r = cli("kb-index", "--path", fixFile);
  return { ok: r.status !== 0, detail: `exit ${r.status}: ${r.stderr}` };
});

// ── kb-index: missing --path and --content → exit 1 ──────────────────────────
check("kb-index missing --path/--content → exit 1", () => {
  const r = cli("kb-index", "--source", "no-input");
  return { ok: r.status !== 0, detail: `exit ${r.status}: ${r.stderr}` };
});

// ── kb-search ─────────────────────────────────────────────────────────────────
check("kb-search --query (hits indexed content)", () =>
  expectOk(
    cli("kb-search", "--query", "refusing to index not a regular file"),
    /refusing to index/
  )
);

// ── kb-search: source scoped ──────────────────────────────────────────────────
check("kb-search --source (scoped to source)", () =>
  expectOk(
    cli("kb-search", "--query", "refusing to index", "--source", "cli-file"),
    /cli-file/
  )
);

// ── kb-search: missing --query → exit 1 ──────────────────────────────────────
check("kb-search missing --query → exit 1", () => {
  const r = cli("kb-search");
  return { ok: r.status !== 0, detail: `exit ${r.status}: ${r.stderr}` };
});

// ── search (alias) ────────────────────────────────────────────────────────────
check("search <query>  (alias for kb-search)", () =>
  expectOk(
    cli("search", "--query", "kb-index directory"),
    /\[/)
);

// ── stats ─────────────────────────────────────────────────────────────────────
check("stats  (shows sources + chunks)", () =>
  expectOk(cli("stats"), /Sources: \d+  Chunks: \d+/)
);

// ── sources ──────────────────────────────────────────────────────────────────
check("sources  (lists indexed source labels)", () =>
  expectOk(cli("sources"), /cli-(file|dir|inline|json)/)
);

// ── index <path> (legacy positional, session DB) ──────────────────────────────
// Legacy command uses a different DB (session-scoped, not CONTEXT_MODE_KNOWLEDGE_DB)
check("index <file>  (legacy positional command)", () => {
  const r = spawnSync("node", [bundle, "index", fixFile, "--source", "legacy-file"], {
    env: { ...process.env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { ok: r.status === 0, detail: r.stdout.trim() || r.stderr };
});

// ── legacy: index <dir> ───────────────────────────────────────────────────────
check("index <dir>   (legacy positional, directory)", () => {
  const r = spawnSync("node", [bundle, "index", docsDir, "--source", "legacy-dir"], {
    env: { ...process.env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { ok: r.status === 0, detail: r.stdout.trim() || r.stderr };
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m── Results ───────────────────────────────────────────────────\x1b[0m`);
console.log(`${PASS} passed: ${passed}   ${failed > 0 ? FAIL : ""}failed: ${failed}\n`);

// cleanup temp DB
try { rmSync(db, { force: true }); rmSync(db + "-wal", { force: true }); rmSync(db + "-shm", { force: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
