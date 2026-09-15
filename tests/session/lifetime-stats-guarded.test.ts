/**
 * getLifetimeStatsGuarded() / getMultiAdapterLifetimeStatsGuarded()
 *
 * These wrap getLifetimeStats()/getMultiAdapterLifetimeStats() with a
 * subprocess + hard timeout so a wedged native SQLite call (WAL-mode DB on
 * a network filesystem where locking hangs indefinitely — see
 * src/session/lifetime-scan-worker.ts docstring) can never freeze the
 * calling process. The dangerous path only activates for compiled/bundled
 * output (.js/.mjs); running from .ts source (this test, vitest, tsx, dev
 * mode) must behave IDENTICALLY to calling the raw functions directly —
 * verified here so a future change to the worker-detection heuristic can't
 * silently start spawning real subprocesses from unit tests again (it did,
 * transiently, during development of this fix).
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import {
  getLifetimeStats,
  getLifetimeStatsGuarded,
  getMultiAdapterLifetimeStats,
  getMultiAdapterLifetimeStatsGuarded,
} from "../../src/session/analytics.js";

function tmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const dirsToClean: string[] = [];
afterAll(() => {
  for (const dir of dirsToClean) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("getLifetimeStatsGuarded", () => {
  test("matches getLifetimeStats() exactly when run from .ts (no worker bundle to spawn)", () => {
    const sessionsDir = tmpDir("ctx-lifetime-guarded");
    dirsToClean.push(sessionsDir);
    const db = new SessionDB(join(sessionsDir, "abc123.db"));
    db.ensureSession("sess-1", "/tmp/project");
    db.insertEvent("sess-1", {
      type: "tool_call",
      category: "test",
      data: "{}",
      priority: 1,
      data_hash: "hash1",
    } as any, "PostToolUse", { projectDir: "/tmp/project", source: "workspace_root", confidence: 0.9 });
    db.close();

    const raw = getLifetimeStats({ sessionsDir });
    const guarded = getLifetimeStatsGuarded({ sessionsDir });
    expect(guarded).toEqual(raw);
  });

  test("returns the same empty shape as getLifetimeStats() for a directory with no DBs", () => {
    const sessionsDir = tmpDir("ctx-lifetime-guarded-empty");
    dirsToClean.push(sessionsDir);
    expect(getLifetimeStatsGuarded({ sessionsDir })).toEqual(getLifetimeStats({ sessionsDir }));
  });
});

describe("getMultiAdapterLifetimeStatsGuarded", () => {
  test("matches getMultiAdapterLifetimeStats() exactly when run from .ts (no worker bundle to spawn)", () => {
    const home = tmpDir("ctx-multi-adapter-guarded");
    dirsToClean.push(home);
    const raw = getMultiAdapterLifetimeStats({ home });
    const guarded = getMultiAdapterLifetimeStatsGuarded({ home });
    expect(guarded).toEqual(raw);
  });
});
