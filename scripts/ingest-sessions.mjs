#!/usr/bin/env node
/**
 * scripts/ingest-sessions.mjs
 *
 * Converts pi session JSONL files into searchable markdown and indexes them
 * into the global KB via `kb-index --content`.
 *
 * Each JSONL file is one session. Lines are Anthropic message format:
 *   { type: "message", message: { role: "user"|"assistant"|"toolResult", content: [...] } }
 *
 * Only user + assistant text blocks are extracted. Tool calls, tool results,
 * thinking blocks, and system lines are skipped — they're noise for search.
 *
 * Output per session (markdown, passed as --content to kb-index):
 *   # Session 2026-05-20 05:19 — /path/to/cwd
 *   ## User
 *   <text>
 *   ## Assistant
 *   <text>
 *   ...
 *
 * Usage:
 *   node scripts/ingest-sessions.mjs [sessions-dir] [--db <path>] [--source <label>] [--dry-run] [--since <date>] [--reindex]
 *
 * Defaults:
 *   sessions-dir  ~/studio/pi/sessions
 *   --db          ~/studio/pi/.sessions.kb.db
 *   --source      pi/sessions
 *   --since       (none — index all)
 *   --reindex     off by default — skips source labels already in KB (incremental)
 *                 pass --reindex to force re-index all files
 */

import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CLI = join(scriptDir, "..", "cli.bundle.mjs");

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(name);

const sessionsDir = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--db" && args[args.indexOf(a) - 1] !== "--source" && args[args.indexOf(a) - 1] !== "--since") ??
  join(homedir(), "studio", "pi", "sessions");
const db     = flag("--db")     ?? join(homedir(), "studio", "pi", ".sessions.kb.db");
const source = flag("--source") ?? "pi/sessions";
const since  = flag("--since")  ? new Date(flag("--since")) : null;
const dryRun = hasFlag("--dry-run");

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTimestamp(filename) {
  // e.g. 2026-05-20T05-19-59-636Z_019e43d3-...jsonl
  const m = basename(filename).match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  if (!m) return null;
  return new Date(m[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3") + "Z");
}

function extractMarkdown(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  let cwd = "";
  const turns = [];

  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }

    // Session metadata line — grab cwd
    if (record.type === "session" && record.cwd) {
      cwd = record.cwd;
      continue;
    }

    if (record.type !== "message") continue;
    const msg = record.message;
    if (!msg?.role || !msg?.content) continue;
    if (msg.role === "toolResult") continue; // skip tool output noise

    const textBlocks = (Array.isArray(msg.content) ? msg.content : [])
      .filter(b => b.type === "text" && typeof b.text === "string" && b.text.trim())
      .map(b => b.text.trim());

    if (textBlocks.length === 0) continue;

    turns.push({ role: msg.role, text: textBlocks.join("\n\n") });
  }

  if (turns.length === 0) return null;

  const ts = parseTimestamp(filePath);
  const dateStr = ts
    ? ts.toISOString().replace("T", " ").slice(0, 16)
    : "unknown";
  const cwdShort = cwd.replace(homedir(), "~");

  const lines_out = [`# Session ${dateStr} — ${cwdShort || "unknown"}`];
  for (const { role, text } of turns) {
    const label = role === "user" ? "## User" : "## Assistant";
    lines_out.push(`\n${label}\n\n${text}`);
  }

  return lines_out.join("\n");
}

// ── Load existing indexed sources for incremental skip ─────────────────────

const skipExisting = !hasFlag("--reindex");
let existingSources = new Set();
if (skipExisting) {
  const r = spawnSync("node", [CLI, "sources"], {
    env: { ...process.env, CONTEXT_MODE_KNOWLEDGE_DB: db },
    encoding: "utf8",
  });
  if (r.status === 0) {
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      existingSources.add(line.split(" (")[0].trim());
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const files = readdirSync(sessionsDir)
  .filter(f => f.endsWith(".jsonl"))
  .map(f => join(sessionsDir, f))
  .filter(f => {
    if (!since) return true;
    const ts = parseTimestamp(f);
    return ts && ts >= since;
  })
  .sort(); // chronological

console.log(`\n\x1b[1m── Pi session ingestion ──────────────────────────────────────\x1b[0m`);
console.log(`Sessions dir : ${sessionsDir}`);
console.log(`KB           : ${db}`);
console.log(`Source label : ${source}`);
console.log(`Files        : ${files.length}${since ? ` (since ${since.toISOString().slice(0,10)})` : ""}`);
console.log(`Incremental  : ${skipExisting ? `yes — ${existingSources.size} sources already indexed` : "no (--reindex)"}`);
if (dryRun) console.log(`\x1b[33mDry run — no indexing\x1b[0m`);
console.log();

let indexed = 0, skipped = 0, failed = 0, totalChunks = 0;

for (const file of files) {
  const name = basename(file);
  let markdown;
  try {
    markdown = extractMarkdown(file);
  } catch (e) {
    console.log(`\x1b[31m✗\x1b[0m ${name} — parse error: ${e.message}`);
    failed++;
    continue;
  }

  if (!markdown) {
    skipped++;
    continue;
  }

  const ts = parseTimestamp(file);
  const sessionSource = `${source}:${ts ? ts.toISOString().slice(0,10) : name}`;

  // Incremental: skip if source label already in KB (sessions are immutable)
  if (skipExisting && existingSources.has(sessionSource)) {
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`\x1b[33m~\x1b[0m ${name} — ${markdown.length} chars (dry run)`);
    indexed++;
    continue;
  }

  // For large content, write to a temp file and use --path (avoids E2BIG on --content args)
  const useFile = markdown.length > 100_000;
  let tmpFile = null;
  let spawnArgs;
  if (useFile) {
    tmpFile = join(tmpdir(), `ctx-session-${process.pid}-${Date.now()}.md`);
    writeFileSync(tmpFile, markdown, "utf-8");
    spawnArgs = [CLI, "kb-index", "--path", tmpFile, "--source", sessionSource];
  } else {
    spawnArgs = [CLI, "kb-index", "--content", markdown, "--source", sessionSource];
  }

  const r = spawnSync("node", spawnArgs, {
    env: { ...process.env, CONTEXT_MODE_KNOWLEDGE_DB: db },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });

  if (tmpFile) { try { unlinkSync(tmpFile); } catch {} }

  if (r.status !== 0) {
    console.log(`\x1b[31m✗\x1b[0m ${name} — ${r.stderr?.trim() || r.error?.message || r.stdout?.trim() || "unknown error"}`);
    failed++;
    continue;
  }

  // Parse chunk count from output: "Indexed N sections..."
  const m = r.stdout.match(/Indexed (\d+) sections/);
  const chunks = m ? parseInt(m[1], 10) : 0;
  totalChunks += chunks;
  console.log(`\x1b[32m✓\x1b[0m ${name.slice(0, 30)}… — ${chunks} chunks`);
  indexed++;
}

// Final stats
const statsR = dryRun ? null : spawnSync("node", [CLI, "stats"], {
  env: { ...process.env, CONTEXT_MODE_KNOWLEDGE_DB: db },
  encoding: "utf8",
});

console.log(`\n\x1b[1m── Results ───────────────────────────────────────────────────\x1b[0m`);
console.log(`Indexed : ${indexed}  Skipped : ${skipped}  Failed : ${failed}`);
console.log(`Chunks  : ${totalChunks}`);
if (statsR?.stdout) console.log(`KB stats: ${statsR.stdout.trim()}`);
