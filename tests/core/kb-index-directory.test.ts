/**
 * Tests for kb-index / index directory routing fix.
 * Bug: runKbCmd() always called store.index() — threw on directories.
 * Fix: detect isDirectory() and route to store.indexDirectory() instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const cliSrc = readFileSync(join(import.meta.dirname, "../../src/cli.ts"), "utf8");

// ── static checks ────────────────────────────────────────────────────────────

describe("kb-index directory routing — static", () => {
  it("runKbCmd branches on isDirectory() before calling store.index()", () => {
    // The fix must check statSync(...).isDirectory() inside runKbCmd
    const runKbSection = cliSrc.slice(cliSrc.indexOf("function runKbCmd("));
    expect(runKbSection).toContain("isDirectory()");
  });

  it("runKbCmd calls indexDirectory when path is a directory", () => {
    const runKbSection = cliSrc.slice(cliSrc.indexOf("function runKbCmd("));
    expect(runKbSection).toContain("indexDirectory");
  });

  it("isDirectory() check precedes store.index() call inside the kb-index branch", () => {
    const runKbSection = cliSrc.slice(cliSrc.indexOf("function runKbCmd("));
    const idxDir = runKbSection.indexOf("indexDirectory");
    const idxFile = runKbSection.indexOf("store.index(");
    // indexDirectory must appear before store.index() in the source
    expect(idxDir).toBeGreaterThan(-1);
    expect(idxFile).toBeGreaterThan(-1);
    expect(idxDir).toBeLessThan(idxFile);
  });
});

// ── integration: ContentStore.indexDirectory wires correctly ─────────────────

async function hasFts5(): Promise<boolean> {
  try {
    const { ContentStore } = await import("../../src/store.js");
    const store = new ContentStore(":memory:");
    store.close();
    return true;
  } catch {
    return false;
  }
}

describe("kb-index directory routing — integration", () => {
  it("ContentStore.indexDirectory indexes files from a temp directory", async () => {
    if (!(await hasFts5())) {
      console.log("  [skip] FTS5 not available in this SQLite runtime");
      return;
    }

    const { ContentStore } = await import("../../src/store.js");

    // create a small tmp dir with two markdown files
    const dir = join(tmpdir(), `ctx-mode-test-dir-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "# Alpha\nSome content about alpha.");
    writeFileSync(join(dir, "b.md"), "# Beta\nSome content about beta.");

    const db = join(tmpdir(), `ctx-mode-kb-dir-${process.pid}.db`);
    const store = new ContentStore(db);

    try {
      const result = store.indexDirectory({ path: dir, source: "test-dir" });
      expect(result.filesIndexed).toBeGreaterThanOrEqual(2);
      expect(result.totalChunks).toBeGreaterThan(0);
      expect(result.label).toBe("test-dir");
    } finally {
      store.close();
      for (const s of ["", "-wal", "-shm"]) {
        try { rmSync(db + s); } catch {}
      }
      try { rmSync(dir, { recursive: true }); } catch {}
    }
  });
});
