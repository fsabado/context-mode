# Execute cancellation design

**Date:** 2026-09-13
**Status:** Approved, pending implementation plan

## Problem

`ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute` spawn subprocesses via
`PolyglotExecutor` with no way to stop them once started, short of the
process's own timeout or byte cap. When an MCP client (e.g. pi) tries to
cancel an in-flight call — sending the standard MCP `notifications/cancelled`
notification — the tool handlers ignore it entirely: they're declared as
`async ({ ...args }) => {...}`, dropping the second callback argument
(`extra: RequestHandlerExtra`) that the `@modelcontextprotocol/sdk` (already a
dependency, v1.26+) provides. `extra.signal` is an `AbortSignal` that fires
exactly when the client cancels that request. Nothing in `executor.ts` ever
sees it, so the spawned subprocess runs to completion (or its own
timeout/cap) regardless of what the client wants.

Confirmed while investigating: pi's own tool-invocation harness
(`performToolInvocation` in `@earendil-works/pi-agent-core`) unconditionally
awaits the tool-call promise; interrupting (Esc) only flips a local
`AbortController` that's checked at specific gate checkpoints between
chunks, not preemptively. Whether pi's MCP client actually sends
`notifications/cancelled` on interrupt could not be confirmed from this
side (no MCP SDK or literal `tools/call`/`notifications/cancelled` strings
found anywhere in pi's shipped bundle). So this change makes context-mode
spec-correct and independently testable, but may not by itself unblock pi's
UI — that depends on pi's own client-side wiring, which is out of this
repo's control. The concrete test after shipping: run a long `ctx_execute`
in pi, hit Esc, check with `ps` whether the child process dies immediately.

## Scope

In scope: `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute` — the three
tools that spawn subprocesses via `PolyglotExecutor`.

Out of scope: `ctx_fetch_and_index`'s internal fetch subprocess (separate
tool, fixed 30s timeout, not a general "run arbitrary code" surface). A
future explicit `ctx_execute_stop`-style handle for already-backgrounded
runs (deferred — see "Known gaps" below).

## Design

### Data flow

```
MCP client (pi or any other host)
  → sends notifications/cancelled for the in-flight request
    → MCP SDK (already implements this) aborts extra.signal in the tool handler
      → handler passes extra.signal into executor.execute() / executeFile()
        → #spawn() listens for the signal's "abort" event → killTree(proc),
          the same kill path already used for timeout
          → resolves with { cancelled: true } instead of hanging until
            natural exit
```

### `src/types.ts`

Add `cancelled?: boolean` to `ExecResult`, alongside the existing
`timedOut`/`backgrounded` fields.

### `src/executor.ts`

- `ExecuteOptions` / `ExecuteFileOptions` gain `signal?: AbortSignal`.
- `execute()` and `executeFile()` thread `signal` down to `#spawn()`
  (and to `#compileAndRun()` for Rust).
- `#compileAndRun()`: pass `signal` into the `execFileSync` compile call
  (Node's `execFileSync` supports a `signal` option since 15.14+), so
  cancelling during `rustc` compilation works too, not just during the run
  phase.
- `#spawn()`:
  - If `signal` is already aborted before the process starts, skip spawning
    entirely and resolve immediately with a cancelled result.
  - Otherwise attach one `abort` listener on `signal` that calls the
    existing `killTree(proc)` and resolves
    `{ stdout, stderr, cancelled: true, timedOut: false, exitCode: 1 }`,
    flushing whatever `stdoutChunks`/`stderrChunks` were already
    accumulated (same partial-output behavior as the timeout path).
  - Reuse the existing `resolved` guard (already used to prevent the
    background-timeout race from double-resolving) so timeout, abort, and
    natural exit can't race into a double-resolve.
  - Remove the abort listener in the `close`/`error` handlers so it can't
    leak across calls or fire after the promise has settled.
  - If abort fires after the process has already been backgrounded
    (`resolved` already true — see "Known gaps"), still call `killTree` so
    the cancel isn't silently swallowed, even though the original response
    was already sent.

### `src/server.ts`

- `ctx_execute` and `ctx_execute_file` handlers: change signature from
  `async ({ ...args }) => {...}` to `async ({ ...args }, extra) => {...}`,
  pass `extra.signal` into the executor call.
- `ctx_batch_execute`:
  - `BatchExecutor.execute()` input type and `BatchRunOptions` gain
    `signal?: AbortSignal`.
  - `runBatchCommands()` threads the same `AbortSignal` object into every
    per-command `executor.execute()` call, in both the serial path and the
    parallel/pooled path. Because one `AbortSignal` can have multiple
    listeners, this means **one cancel kills every in-flight parallel
    command at once**, not just the first one — this must be the actual
    behavior, not "cancel first job only."
  - The tool handler passes `extra.signal` into `BatchRunOptions`.
- Response formatting for `result.cancelled`:
  - Always `isError: false` — cancellation is user-intentional, not a
    failure. This differs from the existing `timedOut`-with-no-output
    branch (which sets `isError: true`): a cancelled call should never look
    like a bug to retry.
  - If partial output exists: return it as a normal success body with a
    trailing note, mirroring the existing "timed out — partial output
    shown above" branch: `_(cancelled by user — partial output shown
    above)_`.
  - If no output at all: still `isError: false`, with a plain
    `Execution cancelled by user` body.

### Known gaps (explicitly deferred, not fixed by this change)

- A `background: true` run that has already returned its response is no
  longer reachable by a cancel notification for that request — MCP
  cancellation only applies to a request still in flight. Stopping an
  already-backgrounded process needs a separate explicit
  stop/kill-by-handle tool (previously discussed as "Approach B"),
  deliberately out of scope here.
- Whether this actually makes pi's Esc key responsive is unverified — see
  "Problem" above.

## Testing

- `tests/executor.test.ts` — new `describe("Cancellation")` block:
  - Abort before spawn → process never starts, resolves immediately with
    `cancelled: true`.
  - Abort mid-run → process killed, `cancelled: true`, partial
    stdout/stderr preserved.
  - Abort after natural completion → no-op, normal result unaffected, no
    double-resolve.
  - Abort during background mode → no crash, no double response, but the
    now-orphaned process is still killed.
  - Rust: abort during `rustc` compile → compile call aborts, no run
    phase started.
- Server/tool-handler level — one test using the MCP SDK's
  `InMemoryTransport` (real client + server pair in-process) that sends an
  actual `notifications/cancelled` for an in-flight `ctx_execute` call and
  asserts the response resolves quickly with the cancelled body, proving
  the full wire-level path rather than just the executor in isolation.
- `ctx_batch_execute` — one test with `concurrency > 1` confirming a single
  cancel kills all concurrently-running commands, not just one.

## Follow-up (not blocking this change)

- One-line entry in a new `release-notes-v*.md` when this ships, per
  existing repo convention.
- Revisit "Approach B" (explicit stop-by-handle tool for backgrounded
  runs) as a separate design if still needed after this ships.
