import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

/**
 * Detect if FTS5 is available in the current SQLite runtime.
 * Some CI environments (node:sqlite without FTS5) cannot create ContentStore.
 */
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

describe("getKbStore", () => {
  const testDb = join(tmpdir(), `test-knowledge-${process.pid}.db`);

  afterEach(async () => {
    const { _resetKbStore } = await import("../../src/server.js");
    _resetKbStore();
    for (const s of ["", "-wal", "-shm"]) {
      try { rmSync(testDb + s); } catch {}
    }
    delete process.env.CONTEXT_MODE_KNOWLEDGE_DB;
  });

  it("creates ContentStore at default path when env not set", async () => {
    if (!(await hasFts5())) {
      console.log("  [skip] FTS5 not available in this SQLite runtime");
      return;
    }
    delete process.env.CONTEXT_MODE_KNOWLEDGE_DB;
    const { getKbStore } = await import("../../src/server.js");
    const store = getKbStore();
    expect(store).not.toBeNull();
    store?.close();
  });

  it("creates ContentStore at specified path when env set", async () => {
    if (!(await hasFts5())) {
      console.log("  [skip] FTS5 not available in this SQLite runtime");
      return;
    }
    process.env.CONTEXT_MODE_KNOWLEDGE_DB = testDb;
    const { getKbStore } = await import("../../src/server.js");
    const store = getKbStore();
    expect(store).not.toBeNull();
    store?.close();
  });

  it("returns null gracefully when ContentStore init fails", async () => {
    // Use an invalid path that will fail on any platform
    process.env.CONTEXT_MODE_KNOWLEDGE_DB = "/dev/null/impossible/path/kb.db";
    const { getKbStore } = await import("../../src/server.js");
    const store = getKbStore();
    expect(store).toBeNull();
  });
});
