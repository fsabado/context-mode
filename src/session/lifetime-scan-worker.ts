/**
 * Lifetime-scan worker — standalone entry point, bundled separately
 * (hooks/lifetime-scan.bundle.mjs).
 *
 * Why this exists: `getLifetimeStats()` / `getMultiAdapterLifetimeStats()`
 * open every SessionDB sidecar on disk (this project's + every other AI
 * tool's) with better-sqlite3, readonly. Those files are written in WAL
 * mode (db-base.ts applyWALPragmas — journal_mode=WAL + mmap). WAL mode
 * requires shared-memory (-shm) index access even for readonly readers,
 * and that access can block indefinitely on a network filesystem whose
 * locking isn't fully honored (observed: a `home` directory backed by an
 * NFS mount hung a scan for 90+ seconds with zero CPU movement — a
 * blocked synchronous native call, not a slow loop). Because that block
 * happens inside a synchronous C call, nothing in the SAME process/thread
 * can time it out — busy_timeout only governs SQLITE_BUSY retries, which
 * never fires here.
 *
 * The only mechanism that reliably survives a wedged synchronous native
 * call is OS-level process termination (SIGKILL always works, regardless
 * of what the process is blocked on). So the scan runs in a disposable
 * child process; the parent (see getLifetimeStatsGuarded /
 * getMultiAdapterLifetimeStatsGuarded in analytics.ts) enforces a hard
 * wall-clock timeout via child_process's own `timeout` option and treats
 * a kill/timeout exactly like any other best-effort scan failure — the
 * existing degrade-to-empty-stats behavior other callers already rely on.
 *
 * Contract: argv[2] is a base64-encoded JSON payload
 *   { kind: "lifetime" | "multi-adapter", opts: {...} }
 * (plain-data opts only — no functions; production callers never pass a
 * custom `loadDatabase`, so this is not a capability loss). Prints the
 * JSON-encoded result to stdout and exits 0, or exits 1 with no stdout
 * output on any failure. Never used by tests — tests call
 * getLifetimeStats()/getMultiAdapterLifetimeStats() directly in-process,
 * which this file does not change.
 */
import { getLifetimeStats, getMultiAdapterLifetimeStats } from "./analytics.js";
import type { RealUsageFilter } from "./analytics.js";

type Payload =
  | { kind: "lifetime"; opts?: { sessionsDir?: string; memoryRoot?: string } }
  | { kind: "multi-adapter"; opts?: { home?: string; filter?: RealUsageFilter } };

function main(): void {
  const raw = process.argv[2];
  if (!raw) {
    process.exit(1);
  }
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Payload;
  } catch {
    process.exit(1);
    return;
  }

  try {
    const result =
      payload.kind === "multi-adapter"
        ? getMultiAdapterLifetimeStats(payload.opts)
        : getLifetimeStats(payload.opts);
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

main();
