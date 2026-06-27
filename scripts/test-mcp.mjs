#!/usr/bin/env node
/**
 * scripts/test-mcp.mjs
 *
 * Smoke-tests all 13 MCP tools over JSON-RPC stdio.
 * Exits 0 if every tool responds without isError:true.
 * Exits 1 on any failure.
 *
 * Usage:
 *   CONTEXT_MODE_KNOWLEDGE_DB=/tmp/test-mcp.db node scripts/test-mcp.mjs
 */
import { spawn }          from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath }  from "node:url";
import { dirname, join }  from "node:path";

const root     = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle   = join(root, "server.bundle.mjs");
const fixtures = join(root, "docs");          // real dir for index tests
const fixFile  = join(root, "docs", "bugs", "kb-index-directory-support.md");

// ─── spin up server ──────────────────────────────────────────────────────────
const server = spawn("node", [bundle], {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
});

const rl      = createInterface({ input: server.stdout });
const pending = new Map();
let   nextId  = 1;

function send(msg) {
  server.stdin.write(JSON.stringify(msg) + "\n");
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

rl.on("line", line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
server.stderr.on("data", () => {});

// ─── helpers ─────────────────────────────────────────────────────────────────
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const SKIP = "\x1b[33m~\x1b[0m";

let passed = 0, failed = 0;

async function check(label, fn) {
  try {
    const result = await fn();
    const text   = result?.content?.[0]?.text ?? JSON.stringify(result).slice(0, 120);
    const isErr  = result?.isError === true;
    if (isErr) {
      console.log(`${FAIL} ${label}\n    ERROR: ${text}`);
      failed++;
    } else {
      console.log(`${PASS} ${label}\n    ${text.split("\n")[0].slice(0, 100)}`);
      passed++;
    }
  } catch (e) {
    console.log(`${FAIL} ${label}\n    THREW: ${e.message}`);
    failed++;
  }
}

function tool(name, args) {
  return call("tools/call", { name, arguments: args });
}

// ─── main ────────────────────────────────────────────────────────────────────
async function run() {
  // initialize handshake
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities:    {},
    clientInfo:      { name: "test-mcp", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  console.log("\n\x1b[1m── MCP tool smoke tests ──────────────────────────────────────\x1b[0m\n");

  // ── ctx_execute ────────────────────────────────────────────────────────────
  await check("ctx_execute — javascript", () =>
    tool("ctx_execute", { language: "javascript", code: "console.log('hello from ctx_execute')" })
  );
  await check("ctx_execute — shell", () =>
    tool("ctx_execute", { language: "shell", code: "echo 'shell ok'" })
  );
  await check("ctx_execute — python", () =>
    tool("ctx_execute", { language: "python", code: "print('python ok')" })
  );

  // ── ctx_execute_file ───────────────────────────────────────────────────────
  await check("ctx_execute_file", () =>
    tool("ctx_execute_file", {
      path:     fixFile,
      language: "javascript",
      code:     "const lines = FILE_CONTENT.split('\\n').length; console.log('lines:', lines)",
    })
  );

  // ── ctx_index (session store) ──────────────────────────────────────────────
  await check("ctx_index — file", () =>
    tool("ctx_index", { path: fixFile, source: "test-index-file" })
  );
  await check("ctx_index — directory", () =>
    tool("ctx_index", { path: fixtures, source: "test-index-dir" })
  );
  await check("ctx_index — inline content", () =>
    tool("ctx_index", { content: "# Hello\nInline content for ctx_index.", source: "test-inline" })
  );

  // ── ctx_search (session store) ────────────────────────────────────────────
  await check("ctx_search", () =>
    tool("ctx_search", { queries: ["refusing to index not a regular file"], source: "test-index-file", limit: 2 })
  );

  // ── ctx_kb_index (global KB) ──────────────────────────────────────────────
  await check("ctx_kb_index — file", () =>
    tool("ctx_kb_index", { path: fixFile, source: "kb-file-test" })
  );
  await check("ctx_kb_index — directory", () =>
    tool("ctx_kb_index", { path: fixtures, source: "kb-dir-test" })
  );
  await check("ctx_kb_index — inline content", () =>
    tool("ctx_kb_index", { content: "# KB inline\nPersistent knowledge.", source: "kb-inline" })
  );

  // ── ctx_kb_search (global KB) ─────────────────────────────────────────────
  await check("ctx_kb_search", () =>
    tool("ctx_kb_search", { queries: ["refusing to index not a regular file"], source: "kb-file-test", limit: 2 })
  );

  // ── ctx_fetch_and_index ───────────────────────────────────────────────────
  await check("ctx_fetch_and_index", () =>
    tool("ctx_fetch_and_index", { url: "https://example.com", source: "test-fetch" })
  );

  // ── ctx_batch_execute ─────────────────────────────────────────────────────
  await check("ctx_batch_execute", () =>
    tool("ctx_batch_execute", {
      commands: [
        { label: "whoami", command: "echo batch-ok" },
        { label: "node-ver", command: "node --version" },
      ],
      queries: ["batch-ok"],
    })
  );

  // ── ctx_stats ─────────────────────────────────────────────────────────────
  await check("ctx_stats", () =>
    tool("ctx_stats", {})
  );

  // ── ctx_doctor ────────────────────────────────────────────────────────────
  await check("ctx_doctor", () =>
    tool("ctx_doctor", {})
  );

  // ── ctx_upgrade ───────────────────────────────────────────────────────────
  await check("ctx_upgrade", () =>
    tool("ctx_upgrade", {})
  );

  // ── ctx_purge (scoped to a fake session — safe, no real data) ─────────────
  await check("ctx_purge — cancel (confirm:false)", () =>
    tool("ctx_purge", { confirm: false })
  );

  // ── ctx_insight ───────────────────────────────────────────────────────────
  // Skipped in headless envs — the tool tries to open a browser/spawn a server.
  // We just verify it's registered (present in tools/list).
  await check("ctx_insight — registered in tools/list", async () => {
    const list = await call("tools/list", {});
    const found = list?.tools?.some(t => t.name === "ctx_insight");
    return { content: [{ type: "text", text: found ? "ctx_insight present in tools/list" : "NOT FOUND" }], isError: !found };
  });

  // ─── summary ──────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m── Results ───────────────────────────────────────────────────\x1b[0m`);
  console.log(`${PASS} passed: ${passed}   ${failed > 0 ? FAIL : ""}failed: ${failed}\n`);

  server.kill();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error("Fatal:", e.message);
  server.kill();
  process.exit(1);
});

setTimeout(() => {
  console.error("Timeout — server did not respond in 30s");
  server.kill();
  process.exit(1);
}, 30_000);
