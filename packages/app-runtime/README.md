# @olan-app/runtime

Backend runtime for Olan Apps (`server` in the manifest). Implements the `AppRuntime` interface
from the Phase 3 contract §15.2 (`docs/plans/2026-10-17-olan-apps-phase-3-contracts.md`) with two
engines, plus the process protocol the Platform service uses to talk to a separate runtime process.

`dist/` is committed (like `@olan-app/schema`); `src/dist.test.ts` fails when it is stale. Refresh
with `npm run build` in this package.

## Interface

```ts
import { createRuntime, forkRuntime, connectRuntime } from '@olan-app/runtime';

const runtime = await forkRuntime();            // production: separate child process
const result = await runtime.invoke(
  { installationId, digest, kind: 'function', name: 'summary', payload: args,
    context: { appId, identity: { actor: 'user', userId, permissions } },
    limits: { cpuMs: 1000, wallMs: 10_000, memoryMb: 64, concurrency: 4 } },
  () => loadServerJs(installationId),             // only called when the digest is new
  (installationId, method, argsJson) => hostBridge(installationId, method, argsJson),
);
// { ok: true, value, logs, cpuMs, wallMs } | { ok: false, error: { code, message }, logs, cpuMs, wallMs }
```

- `createRuntime({ engine: 'auto' | 'isolated-vm' | 'quickjs', onWarning?, onCatastrophicError? })`
  runs the engine in the current process. `auto` uses isolated-vm when the native module loads and
  otherwise falls back to QuickJS with `onWarning('isolated-vm prebuild not available on <platform>-<arch>; using QuickJS (slower)…')`.
- `forkRuntime({ engine?, maxOldSpaceMb?, entry?, onWarning?, onRestart? })` forks `dist/main.js`
  and returns a `RuntimeClient` (also an `AppRuntime`). The client restarts the child when it exits;
  invocations in flight at that moment resolve with `runtime_unavailable`.
- `connectRuntime({ url: 'tcp://host:port', token })` / `listenRuntime({ port, host?, token })`:
  separate-container mode (`OLAN_APP_RUNTIME_URL`, `OLAN_APP_RUNTIME_TOKEN`).
- `@olan-app/runtime/contract-suite`: `runContractSuite(label, factory)` (vitest) — the §15.2
  contract tests, run here against both engines in-process and over the fork transport.

Error codes: `cpu_limit`, `timeout`, `memory_limit`, `concurrency_limit`, `payload_too_large`,
`not_found`, `handler_error`, `bundle_error`, `runtime_unavailable`.

## Sandbox sessions

`createSandboxSession({ engine?, memoryMb, prelude, onCall })` (`src/session.ts`) gives hosts that
drive sandbox code themselves (the marketplace check runner renders UI bundles this way) a fresh
isolate or QuickJS instance with a string bridge, independent of the invocation model above:

- `prelude`: a function expression `(function (host) { … return { entry() {…} } })` evaluated before
  any other code; `host.call(name, data) → string | undefined` is answered synchronously by
  `onCall`, `host.fault(error)` lets catch blocks report a QuickJS out-of-memory/interrupt.
- `session.evaluate(source, { filename, timeoutMs })` runs a script; `session.call(name, args,
  { timeoutMs })` calls a prelude entry. Both resolve with `{ ok: true, value }` or `{ ok: false,
  reason: 'error' | 'timeout' | 'memory_limit' | 'disposed' }`; `timeout` and `memory_limit` dispose
  the sandbox. Microtasks run inside the entry and its budget.
- The session bootstrap removes the same engine globals as the backend bootstrap, installs
  `TextEncoder`/`TextDecoder`/`atob`/`btoa`, and blocks code generation from strings: `eval`,
  `Function` and the (async/generator) function constructors throw `EvalError: Code generation
  from strings disallowed for this context`. (Node's `--disallow-code-generation-from-strings` does
  not reach isolated-vm isolates, so this is done in the sandbox for both engines.)
- isolated-vm entries run on isolated-vm's threads (the host event loop stays free; `host.call` is
  a synchronous call back to it); QuickJS entries run on the host thread under the interrupt handler.

## Bundle and handler resolution

`dist/server.js` is an esbuild IIFE with `globalName: '__olanBackendModule'`; its `default` export
is the `defineBackend(...)` result (`$olanBackend: 1`). Resolution (§15.1):

| kind | handler | arguments |
|---|---|---|
| `function` | `functions[name]` | `(payload, context)` |
| `schedule` | `schedules[name]`, else `functions[fallback]` | `({ ...context, schedule, scheduledAt })`, fallback `(payload, context)` |
| `event` | `events[name]`, else `functions[fallback]` | `(event, context)` |
| `hook` | `hooks[name]`, else `functions[fallback]` | `(request, context)` |
| `migrate` | `migrate` | `(payload.fromVersion, context)` |

Missing handler → `not_found` (also for `migrate` when the bundle has none). `context` is
`{ installationId, appId, identity, signal }`; `signal` is a never-aborting stub because the
sandbox is torn down at the wall deadline.

## Engines

One sandbox per installation, cached by digest (a new digest or memory limit gets a new sandbox;
running calls finish on the old one).

- **isolated-vm** (primary): one isolate + context per installation. Host needs
  `--no-node-snapshot`. CPU is enforced by a watchdog on `isolate.cpuTime` (covers code after
  `await` and in timers), wall time and limit kills by `isolate.dispose()`.
- **QuickJS** (`quickjs-emscripten`, sync release build): one WebAssembly module instance per
  installation (no shared linear memory). No asyncify: `__olan.call` returns an in-sandbox promise
  the host settles later; the job queue is drained after every entry. CPU = time spent inside the
  VM, enforced with the interrupt handler. ~10–30× slower on CPU-bound code.

## Sandbox surface

App code sees ES builtins plus `console` (`log/info/warn/error/debug`), `setTimeout`,
`clearTimeout`, `queueMicrotask`, `TextEncoder`/`TextDecoder` (UTF-8), `atob`/`btoa` and a frozen
`__olan` with a single `call(method, argsJson): Promise<string>`. Host errors reject with an
`Error` carrying `.code` and `.message`. Not available: `gc`, `process`, `require`, `fetch`,
`setInterval`, `URL`, `WebAssembly` (its memory is not counted by the isolate limit), `Atomics`,
any isolated-vm `Reference`. Only strings cross the bridge.

Decision (2026-10-18): `WebAssembly` and `Atomics` stay disabled in both engines. `WebAssembly.Memory`
is allocated outside the isolate heap limit and `Atomics.wait` blocks the isolate thread without
using CPU time, so neither limit would hold. `bootstrap.ts` removes them and the contract suite
checks that app code sees `undefined`.

## Limits

Per invocation: `cpuMs`, `wallMs`, `memoryMb` (isolate heap / QuickJS runtime limit),
`concurrency` per installation, payload and result ≤ 256 KiB. `cpu_limit`, `timeout` and
`memory_limit` discard the installation's sandbox (other calls running in it at that moment get
`runtime_unavailable`); the next call reloads the code. Other installations and the process stay up.
Timers only fire while their invocation runs: a timer due after the wall deadline is never armed
and pending timers are cancelled when the invocation ends. Console: ≤ 1000 lines per call, ≤ 4 KiB
per line, then one truncation marker. The caller (Platform service) owns defaults and Olan ceilings.

## Process model and protocol

`node --no-node-snapshot dist/main.js` (forked) or with `OLAN_APP_RUNTIME_LISTEN=[host:]port` and
`OLAN_APP_RUNTIME_TOKEN` (container). `OLAN_APP_RUNTIME_ENGINE` selects the engine.

`forkRuntime` builds the child with `buildExecArgv` (`--no-node-snapshot`,
`--max-old-space-size=N`, inherited flags minus `--expose-*`, `--allow-natives-syntax`,
`--js-flags`, inspector flags) and `buildChildEnv` (only `PATH`, `NODE_ENV`, `TZ`, `SystemRoot`,
`OLAN_APP_RUNTIME_*`; `NODE_OPTIONS`, database URLs and secrets never reach it; on Windows libuv
adds its own required variables such as `TEMP` and `USERNAME`).

Frames (`src/protocol.ts`, one JSON object per line over TCP, one per IPC message when forked):
`invoke{id, request}` → `need_code{id, digest}` ↔ `code{id, source | error}`;
`host{id, callId, method, args}` ↔ `host_result{callId, ok, value | error}`;
`result{id, result, installations}`; plus `hello`, `warning`, `error`, `ping`/`pong`,
`unload`/`ack`, `introspect`/`introspection` (pid, execArgv, env keys — never values — and `typeof gc`).

## `--expose-gc` warning

V8 flags are process-wide: a host started with `--expose-gc` exposes `gc` inside every isolated-vm
isolate. `dist/main.js` refuses to start with it (exit 78), `buildExecArgv` strips it, the bootstrap
hides `gc` as a second line, and the tests assert `typeof gc === 'undefined'` in app code of a
child forked from a parent with `--expose-gc` in `execArgv` and `NODE_OPTIONS`.

## Dependencies

`quickjs-emscripten` 0.32.0 (MIT; pulls `quickjs-emscripten-core` and the `@jitl/quickjs-*` 0.32.0
variant packages, MIT). `isolated-vm` ^7.0.1 (ISC) is optional: when it has no prebuild for the
platform (darwin-x64, win32-arm64) install continues and `auto` uses QuickJS. Docker images that
run `npm ci --ignore-scripts` need `npm rebuild isolated-vm`.
