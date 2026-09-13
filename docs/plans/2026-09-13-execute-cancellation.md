# Execute Cancellation Implementation Plan

> **For Claude:** Use the `executing-plans` skill to implement this plan task-by-task.

**Goal:** Make `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute` honor MCP-native cancellation (`notifications/cancelled` → `extra.signal`) by killing the underlying subprocess instead of ignoring the signal and running to completion.

**Architecture:** Thread an optional `AbortSignal` from the MCP tool-callback's `extra` argument, through `PolyglotExecutor.execute()`/`executeFile()`, down into `#spawn()`, where an `abort` listener triggers the same `killTree()` path already used for timeout. Result gains a `cancelled?: boolean` field, formatted as a non-error, user-intentional-stop response — mirroring how `timedOut` is already surfaced today.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (already a dependency, v1.26+), `node:child_process`, vitest.

**Design doc:** `docs/plans/2026-09-13-execute-cancellation-design.md`

---

### Task 1: `ExecResult` gains `cancelled`

**Files:**
- Modify: `src/types.ts` (the `ExecResult` interface)

**Step 1: Edit the interface**

```ts
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** Process was detached and continues running in the background. */
  backgrounded?: boolean;
  /** Process was killed because the caller (MCP client) cancelled the request. */
  cancelled?: boolean;
}
```

**Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add cancelled field to ExecResult"
```

No test here — pure type addition, exercised by Task 2's tests.

---

### Task 2: `PolyglotExecutor#spawn()` kills on abort

**Files:**
- Modify: `src/executor.ts`
- Test: `tests/executor.test.ts`

**Step 1: Write the failing tests**

Add a new `describe` block after the existing `describe("Timeout Handling", ...)` block in `tests/executor.test.ts`:

```ts
describe("Cancellation", () => {
  test("abort before spawn — process never starts, resolves immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await executor.execute({
      language: "javascript",
      code: "console.log('should not run')",
      signal: ac.signal,
    });
    assert.equal(r.cancelled, true);
    assert.equal(r.stdout.trim(), "");
  });

  test("abort mid-run — process killed, partial output preserved", async () => {
    const ac = new AbortController();
    const promise = executor.execute({
      language: "javascript",
      code: `console.log("started"); while(true) {}`,
      signal: ac.signal,
    });
    // Give the process a moment to actually start and flush "started".
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await promise;
    assert.equal(r.cancelled, true);
    assert.equal(r.stdout.trim(), "started");
  }, 10_000);

  test("abort mid-run leaves no orphaned process", async () => {
    const ac = new AbortController();
    const promise = executor.execute({
      language: "javascript",
      code: `process.stdout.write(String(process.pid)); while(true) {}`,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await promise;
    const pid = parseInt(r.stdout.trim(), 10);
    assert.ok(pid > 0, `Expected valid PID in stdout, got: "${r.stdout}"`);
    await new Promise((r) => setTimeout(r, 200));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* ESRCH = good */ }
    assert.equal(alive, false, `Process ${pid} should be dead after abort kill`);
  }, 10_000);

  test("abort after natural completion is a no-op", async () => {
    const ac = new AbortController();
    const r = await executor.execute({
      language: "javascript",
      code: "console.log('done')",
      signal: ac.signal,
    });
    ac.abort(); // fires after the promise already settled — must not throw
    assert.equal(r.cancelled, undefined);
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout.trim(), "done");
  });

  test("Shell: abort mid-run kills sleep", async () => {
    const ac = new AbortController();
    const promise = executor.execute({
      language: "shell",
      code: "sleep 5",
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await promise;
    assert.equal(r.cancelled, true);
  }, 10_000);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/executor.test.ts -t Cancellation`
Expected: FAIL — `signal` is not a recognized option on `ExecuteOptions` (TS error) / `r.cancelled` is always `undefined`.

**Step 3: Implement**

In `src/executor.ts`, extend `ExecuteOptions`:

```ts
interface ExecuteOptions {
  language: Language;
  code: string;
  timeout?: number;
  /** Keep process running after timeout instead of killing it. */
  background?: boolean;
  /**
   * Issue #45 — per-call cwd override for the shell language. ...
   */
  cwd?: string;
  /**
   * Abort signal tied to the MCP request's lifetime. When the client
   * cancels the request (`notifications/cancelled`), the SDK fires this,
   * and the running subprocess is killed the same way a timeout kills it.
   */
  signal?: AbortSignal;
}
```

In `execute()`, thread `signal` through to `#spawn()` and to `#compileAndRun()`:

```ts
  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout, background = false, cwd: cwdOverride, signal } = opts;
    const tmpDir = mkdtempSync(join(OS_TMPDIR, ".ctx-mode-"));

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const cmd = buildCommand(this.#runtimes, language, filePath);

      // Rust: compile then run
      if (cmd[0] === "__rust_compile_run__") {
        return await this.#compileAndRun(filePath, tmpDir, timeout, signal);
      }

      const cwd = language === "shell"
        ? (cwdOverride ?? this.#projectRoot)
        : tmpDir;
      const result = await this.#spawn(cmd, cwd, tmpDir, timeout, background, signal);

      // Skip tmpDir cleanup if process was backgrounded — it may still need files
      if (!result.backgrounded) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
      }

      return result;
    } catch (err) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      throw err;
    }
  }
```

Update `#spawn()`'s signature and body — add the `signal` parameter and the abort-handling logic. Full new body:

```ts
  async #spawn(
    cmd: string[],
    cwd: string,
    sandboxTmpDir: string,
    timeout: number | undefined,
    background = false,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    // Abort fired before we even got here — don't spawn at all.
    if (signal?.aborted) {
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false, cancelled: true };
    }

    return new Promise((res) => {
      const needsShell = isWin && ["tsx", "ts-node", "elixir", "bun", "dotnet-script"].includes(cmd[0]);

      let spawnCmd = cmd[0];
      let spawnArgs: string[];
      if (isWin && cmd.length === 2 && cmd[1]) {
        const posixPath = cmd[1].replace(/\\/g, "/");
        spawnArgs = [posixPath];
      } else {
        spawnArgs = isWin
          ? cmd.slice(1).map(a => a.replace(/\\/g, "/"))
          : cmd.slice(1);
      }

      const commonOpts = {
        cwd,
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
        env: this.#buildSafeEnv(sandboxTmpDir),
        detached: !isWin,
        ...buildSpawnOptions(process.platform),
      };

      let proc: ReturnType<typeof spawn>;
      if (needsShell) {
        const fullCmd = [spawnCmd, ...spawnArgs]
          .map(a => /\s/.test(a) ? JSON.stringify(a) : a)
          .join(" ");
        proc = spawn(fullCmd, [], { ...commonOpts, shell: true });
      } else {
        proc = spawn(spawnCmd, spawnArgs, { ...commonOpts, shell: false });
      }

      let timedOut = false;
      let cancelled = false;
      let resolved = false;

      const timer: NodeJS.Timeout | undefined = timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        if (background) {
          resolved = true;
          if (proc.pid) this.#backgroundedPids.add(proc.pid);
          proc.unref();
          proc.stdout!.destroy();
          proc.stderr!.destroy();
          const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
          const rawStderr = Buffer.concat(stderrChunks).toString("utf-8");
          res({
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: 0,
            timedOut: true,
            backgrounded: true,
          });
        } else {
          killTree(proc);
        }
      }, timeout);

      const onAbort = () => {
        cancelled = true;
        if (background && proc.pid) {
          // Already detached/answered — still kill it, just don't resolve again.
          killTree(proc);
          return;
        }
        killTree(proc);
      };
      signal?.addEventListener("abort", onAbort);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let capExceeded = false;

      proc.stdout!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.#hardCapBytes) {
          stdoutChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.#hardCapBytes) {
          stderrChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.on("close", (exitCode) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (resolved) return; // Already resolved by background timeout
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (capExceeded) {
          rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB — process killed]`;
        }

        res({
          stdout: rawStdout,
          stderr: rawStderr,
          exitCode: timedOut || cancelled ? 1 : (exitCode ?? 1),
          timedOut,
          ...(cancelled ? { cancelled: true } : {}),
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (resolved) return; // Already resolved by background timeout
        res({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
          ...(cancelled ? { cancelled: true } : {}),
        });
      });
    });
  }
```

Notes on this diff:
- `cancelled` is a local `let` (like `timedOut`), only set when `onAbort` fires — the `close`/`error` handlers read it, same shape as the existing `timedOut` variable.
- The `resolved` guard is untouched — abort never sets `resolved = true` itself, it just kills the process and lets the *existing* `close`/`error` handler resolve the promise normally (now carrying `cancelled: true`). This keeps the timeout-vs-abort-vs-natural-exit race trivially safe: whichever fires the process's real `close` event first is what resolves; a redundant `killTree` call (e.g. abort after timeout already killed it) is harmless — `killTree` already swallows "already dead" errors.
- `signal.removeEventListener` in both `close` and `error` prevents leaking the listener onto the caller-owned `AbortSignal` object across calls.

**Step 4: Update `#compileAndRun` for Rust**

```ts
  async #compileAndRun(
    srcPath: string,
    cwd: string,
    timeout: number | undefined,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const binSuffix = isWin ? ".exe" : "";
    const binPath = srcPath.replace(/\.rs$/, "") + binSuffix;

    if (signal?.aborted) {
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false, cancelled: true };
    }

    try {
      execFileSync("rustc", [srcPath, "-o", binPath], {
        cwd,
        timeout: timeout === undefined ? 60_000 : Math.min(timeout, 60_000),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
    } catch (err: unknown) {
      if (signal?.aborted) {
        return { stdout: "", stderr: "", exitCode: 1, timedOut: false, cancelled: true };
      }
      const message = err instanceof Error ? (err as any).stderr || err.message : String(err);
      return {
        stdout: "",
        stderr: `Compilation failed:\n${message}`,
        exitCode: 1,
        timedOut: false,
      };
    }

    return this.#spawn([binPath], cwd, cwd, timeout, false, signal);
  }
```

`execFileSync`'s `signal` option (Node ≥15.14) kills the compiler process and throws on abort; checking `signal?.aborted` in the catch block (rather than inspecting the thrown error's `code`/`name`, which vary by platform/Node version) makes this deterministic and cheap.

**Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/executor.test.ts -t Cancellation`
Expected: PASS (5 tests)

**Step 6: Run the full executor suite to check for regressions**

Run: `npx vitest run tests/executor.test.ts`
Expected: PASS (all existing + new tests)

**Step 7: Commit**

```bash
git add src/executor.ts tests/executor.test.ts
git commit -m "feat: kill subprocess on AbortSignal in PolyglotExecutor"
```

---

### Task 3: `executeFile()` accepts and forwards `signal`

**Files:**
- Modify: `src/executor.ts`
- Test: `tests/executor.test.ts`

**Step 1: Write the failing test**

Add to the existing `describe("execute_file (FILE_CONTENT)", ...)` block (or a new `describe` right after it):

```ts
describe("execute_file cancellation", () => {
  test("abort mid-run kills the process, executeFile reports cancelled", async () => {
    const tmpFile = join(tmpdir(), `cm-cancel-test-${Date.now()}.txt`);
    writeFileSync(tmpFile, "hello");
    const ac = new AbortController();
    const promise = executor.executeFile({
      path: tmpFile,
      language: "javascript",
      code: `console.log("started"); while(true) {}`,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await promise;
    assert.equal(r.cancelled, true);
    assert.equal(r.stdout.trim(), "started");
    rmSync(tmpFile, { force: true });
  }, 10_000);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/executor.test.ts -t "execute_file cancellation"`
Expected: FAIL — `signal` not on `ExecuteFileOptions` / TS error.

**Step 3: Implement**

`ExecuteFileOptions` already `extends ExecuteOptions`, so it inherits `signal` for free once Task 2 lands — no interface change needed. Only `executeFile()`'s body needs the destructure updated:

```ts
  async executeFile(opts: ExecuteFileOptions): Promise<ExecResult> {
    const { path: filePath, language, code, timeout, signal } = opts;
    const absolutePath = resolve(this.#projectRoot, filePath);
    const wrappedCode = this.#wrapWithFileContent(
      absolutePath,
      language,
      code,
    );
    return this.execute({ language, code: wrappedCode, timeout, signal });
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/executor.test.ts -t "execute_file cancellation"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/executor.ts tests/executor.test.ts
git commit -m "feat: forward AbortSignal through executeFile"
```

---

### Task 4: Wire `extra.signal` into the `ctx_execute` tool handler

**Files:**
- Modify: `src/server.ts`

**Step 1: Write the failing test**

Add to `tests/core/server.test.ts`, near other `ctx_execute`-adjacent tests (search the file for an existing `describe` covering `ctx_execute` response shaping to place this alongside; if none exists, add a new top-level `describe`):

```ts
describe("ctx_execute cancellation (in-memory MCP)", () => {
  test("cancelling an in-flight ctx_execute call kills the process and returns cancelled body", async () => {
    process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { server } = await import("../../src/server.js");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverTransport);
    const client = new Client({ name: "cancel-probe", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const ac = new AbortController();
    const callPromise = client.callTool(
      { name: "ctx_execute", arguments: { language: "javascript", code: "while(true) {}" } },
      undefined,
      { signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();

    const result = await callPromise as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain("cancel");

    await client.close();
  }, 15_000);
});
```

Note: `McpServer` import above is unused in this specific test (the real singleton `server` is reused instead) — keep it out if the linter complains; it's listed only because the sibling #637 test imports it for a different purpose. Only import what's used:

```ts
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { server } = await import("../../src/server.js");
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/server.test.ts -t "ctx_execute cancellation"`
Expected: FAIL — timeout waiting for `callPromise` to resolve (it hangs until the infinite loop's natural non-completion / test timeout), because the handler doesn't read `extra.signal` yet.

**Step 3: Implement**

In `src/server.ts`, change the `ctx_execute` handler signature and the `executor.execute()` call:

```ts
  async ({ language, code, timeout, background, intent }, extra) => {
    // Security: deny-only firewall
    if (language === "shell") {
      const denied = checkDenyPolicy(code, "execute");
      if (denied) return denied;
    } else {
      const denied = checkNonShellDenyPolicy(code, language, "execute");
      if (denied) return denied;
    }

    try {
      // For JS/TS: wrap in async IIFE with fetch + http/https interceptors to track network bytes
      let instrumentedCode = code;
      // ... (unchanged code that builds instrumentedCode) ...

      const result = await executor.execute({ language, code: instrumentedCode, timeout, background, signal: extra.signal });
```

(Only the callback's argument list and the one `executor.execute({...})` call change — everything else in the handler body is untouched.)

Add a `cancelled` branch immediately before the existing `if (result.timedOut) { ... }` block:

```ts
      if (result.cancelled) {
        const partialOutput = result.stdout?.trim();
        return trackResponse("ctx_execute", {
          content: [
            {
              type: "text" as const,
              text: partialOutput
                ? `${echo}${partialOutput}\n\n_(cancelled by user — partial output shown above)_`
                : `${echo}Execution cancelled by user`,
            },
          ],
        });
      }

      if (result.timedOut) {
        // ... unchanged ...
```

(`isError` is omitted entirely — defaults to `false`/absent, same as the existing success-shaped responses elsewhere in this handler.)

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/server.test.ts -t "ctx_execute cancellation"`
Expected: PASS

**Step 5: Run the full server test file for regressions**

Run: `npx vitest run tests/core/server.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/server.ts tests/core/server.test.ts
git commit -m "feat: honor MCP cancellation in ctx_execute"
```

---

### Task 5: Wire `extra.signal` into the `ctx_execute_file` tool handler

**Files:**
- Modify: `src/server.ts`

**Step 1: Write the failing test**

Same pattern as Task 4, targeting `ctx_execute_file`. Add to `tests/core/server.test.ts`:

```ts
describe("ctx_execute_file cancellation (in-memory MCP)", () => {
  test("cancelling an in-flight ctx_execute_file call kills the process", async () => {
    process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { server } = await import("../../src/server.js");

    const tmpFile = join(tmpdir(), `cm-cancel-file-test-${Date.now()}.txt`);
    writeFileSync(tmpFile, "hello");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverTransport);
    const client = new Client({ name: "cancel-file-probe", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const ac = new AbortController();
    const callPromise = client.callTool(
      { name: "ctx_execute_file", arguments: { path: tmpFile, language: "javascript", code: "while(true) {}" } },
      undefined,
      { signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();

    const result = await callPromise as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain("cancel");

    await client.close();
    rmSync(tmpFile, { force: true });
  }, 15_000);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/server.test.ts -t "ctx_execute_file cancellation"`
Expected: FAIL (hangs / times out)

**Step 3: Implement**

Same shape of change as Task 4, applied to the `ctx_execute_file` handler:

```ts
  async ({ path, language, code, timeout, intent }, extra) => {
    // Security: check file path against Read deny patterns
    const pathDenied = checkFilePathDenyPolicy(path, "ctx_execute_file");
    if (pathDenied) return pathDenied;

    // Security: check code parameter against Bash deny patterns
    if (language === "shell") {
      const codeDenied = checkDenyPolicy(code, "execute_file");
      if (codeDenied) return codeDenied;
    } else {
      const codeDenied = checkNonShellDenyPolicy(code, language, "execute_file");
      if (codeDenied) return codeDenied;
    }

    try {
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout,
        signal: extra.signal,
      });

      // Echo path + executed source code before stdout for audit/debug
      // (Issues #717 + #736).
      const echo = buildExecuteEcho(language, code, path);

      if (result.cancelled) {
        const partialOutput = result.stdout?.trim();
        return trackResponse("ctx_execute_file", {
          content: [
            {
              type: "text" as const,
              text: partialOutput
                ? `${echo}${partialOutput}\n\n_(cancelled by user — partial output shown above)_`
                : `${echo}Execution cancelled by user`,
            },
          ],
        });
      }

      // ... rest of the existing handler body (timedOut / exitCode handling) unchanged ...
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/server.test.ts -t "ctx_execute_file cancellation"`
Expected: PASS

**Step 5: Run the full server test file for regressions**

Run: `npx vitest run tests/core/server.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/server.ts tests/core/server.test.ts
git commit -m "feat: honor MCP cancellation in ctx_execute_file"
```

---

### Task 6: Wire `signal` through `ctx_batch_execute`

**Files:**
- Modify: `src/server.ts`

**Step 1: Write the failing test**

Add to `tests/core/server.test.ts`:

```ts
describe("ctx_batch_execute cancellation (in-memory MCP)", () => {
  test("cancelling kills all in-flight parallel commands", async () => {
    process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { server } = await import("../../src/server.js");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverTransport);
    const client = new Client({ name: "cancel-batch-probe", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const ac = new AbortController();
    const callPromise = client.callTool(
      {
        name: "ctx_batch_execute",
        arguments: {
          commands: [
            { label: "a", command: "echo started-a; sleep 5" },
            { label: "b", command: "echo started-b; sleep 5" },
          ],
          queries: ["placeholder"],
          concurrency: 2,
        },
      },
      undefined,
      { signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();

    const result = await callPromise as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain("cancel");

    await client.close();
  }, 15_000);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/server.test.ts -t "ctx_batch_execute cancellation"`
Expected: FAIL (hangs — both `sleep 5` commands run to completion)

**Step 3: Implement**

In `src/server.ts`:

1. Extend `BatchRunOptions` and the private `BatchExecutor` interface:

```ts
export interface BatchRunOptions {
  timeout: number | undefined;
  concurrency: number;
  nodeOptsPrefix: string;
  onFsBytes?: (bytes: number) => void;
  /** Abort signal tied to the MCP request's lifetime — kills every in-flight command. */
  signal?: AbortSignal;
}

interface BatchExecutor {
  execute(input: { language: "shell"; code: string; timeout: number | undefined; signal?: AbortSignal }): Promise<{ stdout: string; timedOut?: boolean; cancelled?: boolean }>;
}
```

2. Add a `cancelled` field to `BatchRunResult`:

```ts
export interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
  cancelled: boolean;
}
```

3. In `runBatchCommands()`, destructure `signal` and thread it into both paths, tracking a `cancelled` flag alongside the existing `timedOut` one:

Serial path — inside the `for` loop, pass `signal` and check `result.cancelled` the same way `result.timedOut` is already checked:

```ts
export async function runBatchCommands(
  commands: BatchCommand[],
  opts: BatchRunOptions,
  executor: BatchExecutor,
): Promise<BatchRunResult> {
  const { timeout, concurrency, nodeOptsPrefix, onFsBytes, signal } = opts;

  if (concurrency <= 1) {
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    let cancelled = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined;
      if (timeout !== undefined) {
        const elapsed = Date.now() - startTime;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout: perCmdTimeout,
        signal,
      });
      outputs.push(formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes));
      if (result.cancelled) {
        cancelled = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — cancelled by user)\n`);
        }
        break;
      }
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut, cancelled };
  }

  // Parallel path — delegated to the shared runPool primitive.
  const jobs: PoolJob<{ output: string; timedOut: boolean; cancelled: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout,
        signal,
      });
      const formatted = formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes);
      const output = result.cancelled
        ? formatted.replace(/\n$/, "") + `\n(cancelled by user)\n`
        : result.timedOut
        ? formatted.replace(/\n$/, "") + `\n(timed out after ${timeout ?? "?"}ms)\n`
        : formatted;
      return { output, timedOut: !!result.timedOut, cancelled: !!result.cancelled };
    },
  }));

  const { settled } = await runPool(jobs, { concurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  let cancelled = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs[i] = r.value.output;
      if (r.value.timedOut) timedOut = true;
      if (r.value.cancelled) cancelled = true;
    } else {
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut, cancelled };
}
```

Since `signal` is the *same* `AbortSignal` object passed into every parallel job's `executor.execute()` call, one client-side cancel kills every concurrently-running command at once — each job attaches its own `abort` listener (Task 2) to the same signal.

4. In the `ctx_batch_execute` tool handler: accept `extra`, pass `extra.signal` into `BatchRunOptions`, destructure `cancelled` from the result, and add an early-return branch mirroring the existing all-timed-out-no-output branch:

```ts
  async ({ commands, queries, timeout, concurrency, query_scope }, extra) => {
    // Security: check each command against deny patterns
    for (const cmd of commands) {
      const denied = checkDenyPolicy(cmd.command, "batch_execute");
      if (denied) return denied;
    }

    try {
      const nodeOptsPrefix = buildBatchNodeOptionsPrefix(runtimes.shell, CM_FS_PRELOAD);

      const { outputs: perCommandOutputs, timedOut, cancelled } = await runBatchCommands(
        commands,
        {
          timeout,
          concurrency,
          nodeOptsPrefix,
          onFsBytes: (bytes) => { sessionStats.bytesSandboxed += bytes; },
          signal: extra.signal,
        },
        executor,
      );

      if (cancelled && perCommandOutputs.length === 0) {
        return trackResponse("ctx_batch_execute", {
          content: [
            {
              type: "text" as const,
              text: `Batch cancelled by user. No output captured.`,
            },
          ],
        });
      }

      const stdout = perCommandOutputs.join("\n");
      const totalBytes = Buffer.byteLength(stdout);
      const totalLines = stdout.split("\n").length;

      if (timedOut && perCommandOutputs.length === 0) {
        return trackResponse("ctx_batch_execute", {
          content: [
            {
              type: "text" as const,
              text: `Batch timed out after ${timeout}ms. No output captured.`,
            },
          ],
          isError: true,
        });
      }

      // ... rest of the handler body unchanged (indexing, commandsInventory, output, final return) ...
```

Note the cancelled early-return has no `isError: true` (unlike the timed-out one) — same "user intent, not a failure" reasoning as Tasks 4/5, and it's placed *before* the timedOut check since a cancel can race a timeout but should win the messaging.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/server.test.ts -t "ctx_batch_execute cancellation"`
Expected: PASS

**Step 5: Run the full server test file for regressions**

Run: `npx vitest run tests/core/server.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/server.ts tests/core/server.test.ts
git commit -m "feat: honor MCP cancellation in ctx_batch_execute, kill all parallel commands on one cancel"
```

---

### Task 7: Full regression pass + release note

**Files:**
- Modify: a new `release-notes-v<next-version>.md` (check `package.json` for the current version first; bump per existing repo convention)

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all tests, including every test added in Tasks 2–6)

**Step 2: Add a release note**

Check `package.json`'s current `version` field, and copy the format of the most recent `release-notes-v*.md` file in the repo root. Add a short entry, e.g.:

```markdown
## ctx_execute / ctx_execute_file / ctx_batch_execute now honor MCP cancellation

Cancelling an in-flight MCP request (`notifications/cancelled`) now kills the
underlying sandboxed subprocess immediately instead of letting it run to
completion. Applies to `ctx_execute`, `ctx_execute_file`, and
`ctx_batch_execute` (including every concurrently-running command in a
parallel batch).
```

**Step 3: Commit**

```bash
git add release-notes-v<next-version>.md
git commit -m "docs: release notes for execute cancellation"
```

---

## Manual verification (not automated — do this after merging)

The unit/integration tests above prove context-mode is now spec-correct.
Whether this actually unblocks pi's Esc key is a separate, unverified
question (see design doc). After this ships:

1. Run pi interactively with this build of context-mode.
2. Start a long `ctx_execute` (e.g. `sleep 60`).
3. Press Esc.
4. Check with `ps aux | grep <sleep pid>` whether the child process dies
   immediately.

If it doesn't, the remaining gap is in pi's own MCP client / tool-invocation
harness, not in context-mode — revisit "Approach B" (explicit stop-by-handle
tool) from the design doc as a workaround, or file the gap against pi.
