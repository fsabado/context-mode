# context-mode v1.0.169 — MCP cancellation for ctx_execute / ctx_execute_file / ctx_batch_execute

## TL;DR

Cancelling an in-flight MCP request (`notifications/cancelled`) now kills the
underlying sandboxed subprocess immediately instead of letting it run to
completion. Applies to `ctx_execute`, `ctx_execute_file`, and
`ctx_batch_execute` — including every concurrently-running command in a
parallel (`concurrency > 1`) batch, which are all killed together on a single
cancel.

Cancellation is treated as user-intentional, not a failure: the response is
never marked `isError`, and shows whatever partial output was captured before
the kill, mirroring how timeouts already surface partial output today.

## Fixed alongside this

`wrapToolHandler` — the internal wrapper installed over every
`server.registerTool()` call for storage-error recovery and native-plugin-host
suppression — was silently dropping the MCP SDK's second callback argument
(`RequestHandlerExtra`, which carries the cancellation `AbortSignal`) for
**every** registered tool, not just the three above. This is now forwarded
through.

Because at least one host (the OpenCode native plugin bridge) invokes
registered tool handlers with a single argument by design, all `extra` access
added by this change uses optional chaining (`extra?.signal`) rather than
assuming a `RequestHandlerExtra` is always present.

## Known gap

A `background: true` run that has already returned its response is no longer
reachable by a cancel notification for that original request — MCP
cancellation only applies to a request still in flight. Stopping an
already-backgrounded process still needs a separate explicit
stop-by-handle tool; not part of this release.

See `docs/plans/2026-09-13-execute-cancellation-design.md` for the full design
rationale, including the caveat that this makes context-mode spec-correct
independent of any given MCP client's own cancellation behavior.
