/**
 * `@olan-app/runtime`: Olan Apps backend runtime (Phase 3 contract §15).
 *
 * - `createRuntime({ engine })`: in-process engine (isolated-vm, or QuickJS-WASM as fallback).
 * - `forkRuntime()` / `connectRuntime()`: the main service's client for a separate runtime
 *   process (fork + IPC, or TCP + token). `serveRuntime` / `listenRuntime` are the runtime side;
 *   `dist/main.js` is the process entry.
 * - `createSandboxSession()`: a fresh isolate (or QuickJS instance) with a string bridge, for hosts
 *   that drive sandbox code themselves (the marketplace check runner).
 * - `@olan-app/runtime/contract-suite`: the engine contract tests (vitest).
 */
export * from './types.js';
export { createRuntime, hostExposesGc } from './runtime.js';
export { CODE_GENERATION_BLOCKED, createSandboxSession, resolveSessionEngine, } from './session.js';
export { buildChildEnv, buildExecArgv, connectRuntime, forkRuntime, RUNTIME_ENTRY, RuntimeClient, } from './client.js';
export { listenRuntime, serveRuntime } from './server.js';
export { decodeFrame, encodeFrame, ipcTransport, MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, streamTransport, } from './protocol.js';
