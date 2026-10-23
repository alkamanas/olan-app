/**
 * Sandbox sessions: evaluate code in a fresh isolate (isolated-vm) or QuickJS-WASM instance with a
 * string message bridge, for hosts that drive the sandbox themselves (the marketplace check runner
 * renders UI app bundles this way). Independent of the {@link AppRuntime} invocation model: no
 * installations, digests or backend handler resolution.
 *
 * A session is created with a `prelude`: a function expression evaluated after the session
 * bootstrap and before any other code. It receives `host` with one synchronous primitive,
 * `host.call(name, data) → string | undefined` (strings only, answered by `onCall` on the host),
 * plus `host.fault(error) → boolean` for catch blocks (true: an engine fault, stop handling it),
 * and returns an object of entry functions the host calls with {@link SandboxSession.call}. The
 * bootstrap first removes the engine globals that must never reach app code (as the backend
 * bootstrap does), installs `TextEncoder`/`TextDecoder`/`atob`/`btoa`, and blocks code generation
 * from strings: `eval`, `Function` and the function constructors reachable through prototypes throw
 * `EvalError: Code generation from strings disallowed for this context`, like a Node context
 * created with `codeGeneration: { strings: false }`. `host`, the engine primitive and the entry
 * object stay in closures: nothing is reachable from app code except what the prelude exposes.
 *
 * Every entry (`evaluate`, `call`) has a wall-time budget. When it runs out the sandbox is
 * disposed and the entry resolves with `timeout`; the memory limit disposes it with
 * `memory_limit`. Microtasks queued by an entry run inside the same entry (and budget).
 *
 * isolated-vm: entries run asynchronously on isolated-vm's thread pool (the host event loop stays
 * free); `host.call` is a synchronous call back into the host thread. QuickJS: entries run
 * synchronously on the host thread; the time budget is enforced with the interrupt handler.
 */
import type * as IvmModule from 'isolated-vm';
import { newQuickJSWASMModule, RELEASE_SYNC, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from 'quickjs-emscripten';
import { ENCODING_GLOBALS_SOURCE, FORBIDDEN_GLOBALS_SOURCE } from './bootstrap.js';
import { loadIsolatedVm } from './engines/isolated-vm.js';
import { hostExposesGc } from './runtime.js';
import type { EngineChoice, EngineName } from './types.js';

/** Values crossing the bridge as entry arguments and results. */
export type SessionValue = string | number | boolean | null;

export type SessionOutcome =
  | { ok: true; value: SessionValue | undefined }
  /** Sandbox code threw; `error` is the thrown value as copied out of the sandbox. */
  | { ok: false; reason: 'error'; message: string; error: unknown }
  /** The entry ran past its budget (the session is disposed), hit the memory limit, or the session was already disposed. */
  | { ok: false; reason: 'timeout' | 'memory_limit' | 'disposed'; message: string };

export interface SandboxSessionOptions {
  engine?: EngineChoice;
  /** Heap limit (isolated-vm isolate / QuickJS runtime memory limit). */
  memoryMb: number;
  /** Function expression `(function (host) { …; return { entry: function () {…} } })`. */
  prelude: string;
  /** Answers `host.call(name, data)` synchronously. Exceptions become sandbox exceptions. */
  onCall: (name: string, data: string) => string | undefined;
  onWarning?: (message: string) => void;
  /** isolated-vm lost control of an isolate. Default: stderr and exit code 70. */
  onCatastrophicError?: (message: string) => void;
}

export interface SandboxSession {
  readonly engine: EngineName;
  readonly disposed: boolean;
  /** Runs a classic script in the sandbox's global scope. */
  evaluate(source: string, options: { filename: string; timeoutMs: number }): Promise<SessionOutcome>;
  /** Calls an entry function returned by the prelude. */
  call(name: string, args: SessionValue[], options: { timeoutMs: number }): Promise<SessionOutcome>;
  dispose(): void;
}

export const CODE_GENERATION_BLOCKED = 'Code generation from strings disallowed for this context';

/** Bridge name of `host.fault(error)`; intercepted by the session, never passed to `onCall`. */
const FAULT_CALL = '__olan_session_fault';

/**
 * Session bootstrap: `(function (call) { … return prelude(host); })`, where `call(name, data)` is
 * the engine primitive. `PRELUDE` is replaced with the caller's prelude source.
 */
const SESSION_BOOTSTRAP = String.raw`(function (call) {
  'use strict';
  var G = globalThis;
  var defineProperty = Object.defineProperty, freeze = Object.freeze, getPrototypeOf = Object.getPrototypeOf;
  var ErrorCtor = Error, StringCtor = String, EvalErrorCtor = EvalError;

  function define(name, value) {
    defineProperty(G, name, { value: value, writable: true, configurable: true, enumerable: false });
  }

${FORBIDDEN_GLOBALS_SOURCE}

  // Code generation from strings: eval, Function and the constructors of (async) (generator)
  // functions throw like a context created with codeGeneration: { strings: false }.
  var blockedMessage = '${CODE_GENERATION_BLOCKED}';
  var FAULT_CALL = '${FAULT_CALL}';
  function blocker(name, prototype) {
    var stub = function () { throw new EvalErrorCtor(blockedMessage); };
    defineProperty(stub, 'name', { value: name });
    defineProperty(stub, 'prototype', { value: prototype, writable: false, configurable: false, enumerable: false });
    defineProperty(prototype, 'constructor', { value: stub, writable: false, configurable: false, enumerable: false });
    return stub;
  }
  var FunctionStub = blocker('Function', Function.prototype);
  blocker('GeneratorFunction', getPrototypeOf(function* () {}));
  blocker('AsyncFunction', getPrototypeOf(async function () {}));
  blocker('AsyncGeneratorFunction', getPrototypeOf(async function* () {}));
  define('Function', FunctionStub);
  var evalStub = function () { throw new EvalErrorCtor(blockedMessage); };
  defineProperty(evalStub, 'name', { value: 'eval' });
  define('eval', evalStub);

${ENCODING_GLOBALS_SOURCE}

  // QuickJS reports out-of-memory and interrupts as catchable InternalErrors. Prelude code that
  // catches errors passes them to host.fault(error), which tells the host and returns true.
  var InternalErrorCtor = typeof InternalError === 'function' ? InternalError : null;
  var host = freeze({
    call: function (name, data) {
      return call(StringCtor(name), data === undefined ? '' : StringCtor(data));
    },
    fault: function (error) {
      if (!InternalErrorCtor || !(error instanceof InternalErrorCtor)) return false;
      var message = error.message;
      if (message !== 'out of memory' && message !== 'interrupted') return false;
      call(FAULT_CALL, message);
      return true;
    },
  });
  return (PRELUDE)(host);
})`;

function sessionSource(prelude: string): string {
  const index = SESSION_BOOTSTRAP.lastIndexOf('(PRELUDE)');
  return `${SESSION_BOOTSTRAP.slice(0, index)}(${prelude})${SESSION_BOOTSTRAP.slice(index + '(PRELUDE)'.length)}`;
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

const budget = (timeoutMs: number) => Math.max(1, Math.ceil(Number.isFinite(timeoutMs) ? timeoutMs : 1));

// ---------------------------------------------------------------------------------------------
// isolated-vm
// ---------------------------------------------------------------------------------------------

class IsolatedVmSession implements SandboxSession {
  readonly engine = 'isolated-vm' as const;
  private closed = false;
  private readonly entries = new Map<string, Promise<IvmModule.Reference>>();

  constructor(
    private readonly isolate: IvmModule.Isolate,
    private readonly context: IvmModule.Context,
    private readonly api: IvmModule.Reference,
    private readonly references: IvmModule.Reference[],
  ) {}

  get disposed(): boolean {
    return this.closed || this.isolate.isDisposed;
  }

  private fault(error: unknown): SessionOutcome {
    if (this.isolate.isDisposed && !this.closed) {
      this.dispose();
      const message = messageOf(error);
      if (/memory limit/i.test(message)) return { ok: false, reason: 'memory_limit', message };
      return { ok: false, reason: 'disposed', message };
    }
    if (this.closed) return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
    const message = messageOf(error);
    if (error instanceof Error && /^Script execution timed out\.?$/.test(message)) {
      this.dispose();
      return { ok: false, reason: 'timeout', message };
    }
    return { ok: false, reason: 'error', message, error };
  }

  async evaluate(source: string, options: { filename: string; timeoutMs: number }): Promise<SessionOutcome> {
    if (this.disposed) return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
    let script: IvmModule.Script;
    try {
      script = await this.isolate.compileScript(source, { filename: options.filename });
    } catch (error) {
      // isolated-vm appends ` [file:line:column]` to compile errors; keep V8's own message.
      if (error instanceof Error) error.message = error.message.replace(/ \[[^\]]*:\d+:\d+\]$/, '');
      return this.fault(error);
    }
    try {
      await script.run(this.context, { timeout: budget(options.timeoutMs) });
      return { ok: true, value: undefined };
    } catch (error) {
      return this.fault(error);
    } finally {
      try { script.release(); } catch { /* isolate gone */ }
    }
  }

  private entry(name: string): Promise<IvmModule.Reference> {
    let found = this.entries.get(name);
    if (!found) {
      found = this.api.get(name, { reference: true }) as Promise<IvmModule.Reference>;
      this.entries.set(name, found);
      found.then((reference) => this.references.push(reference), () => undefined);
    }
    return found;
  }

  async call(name: string, args: SessionValue[], options: { timeoutMs: number }): Promise<SessionOutcome> {
    if (this.disposed) return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
    try {
      const fn = await this.entry(name);
      if (fn.typeof !== 'function') return { ok: false, reason: 'error', message: `the prelude has no entry ${name}`, error: undefined };
      const value = await fn.apply(undefined, args, { arguments: { copy: true }, result: { copy: true }, timeout: budget(options.timeoutMs) });
      return { ok: true, value: value as SessionValue | undefined };
    } catch (error) {
      return this.fault(error);
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reference of this.references) {
      try { reference.release(); } catch { /* isolate gone */ }
    }
    try { this.context.release(); } catch { /* isolate gone */ }
    try { if (!this.isolate.isDisposed) this.isolate.dispose(); } catch { /* already disposed */ }
  }
}

async function isolatedVmSession(ivm: typeof IvmModule, options: SandboxSessionOptions): Promise<SandboxSession> {
  const isolate = new ivm.Isolate({
    memoryLimit: Math.max(8, options.memoryMb),
    onCatastrophicError: options.onCatastrophicError ?? defaultCatastrophe,
  });
  try {
    const context = await isolate.createContext();
    // isolated-vm faults are not catchable; host.fault never calls back there.
    const primitive = new ivm.Reference((name: string, data: string) => (name === FAULT_CALL ? undefined : options.onCall(String(name), String(data))));
    const api = await context.evalClosure(
      `const call = (name, data) => $0.applySync(undefined, [name, data], { arguments: { copy: true }, result: { copy: true } });
return ${sessionSource(options.prelude)}(call);`,
      [primitive],
      { result: { reference: true } },
    ) as IvmModule.Reference;
    return new IsolatedVmSession(isolate, context, api, [primitive, api]);
  } catch (error) {
    try { isolate.dispose(); } catch { /* already disposed */ }
    throw error;
  }
}

function defaultCatastrophe(message: string): void {
  process.stderr.write(`[olan-app-runtime] isolated-vm catastrophic error, exiting: ${message}\n`);
  process.exit(70);
}

// ---------------------------------------------------------------------------------------------
// QuickJS
// ---------------------------------------------------------------------------------------------

const STACK_BYTES = 1024 * 1024;

class QuickJsSession implements SandboxSession {
  readonly engine = 'quickjs' as const;
  private closed = false;
  private deadline = Number.POSITIVE_INFINITY;
  /** Set when the interrupt handler stopped code: promise jobs swallow the interrupt as a rejection. */
  private interrupted = false;
  /** Out-of-memory or interrupt seen by prelude code (`host.fault`). */
  faulted: string | null = null;
  private api: QuickJSHandle | null = null;

  constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly vm: QuickJSContext,
  ) {
    runtime.setInterruptHandler(() => {
      if (Date.now() <= this.deadline) return false;
      this.interrupted = true;
      return true;
    });
  }

  get disposed(): boolean {
    return this.closed;
  }

  /** Dumps a thrown handle; classifies interrupts and out-of-memory as engine faults. */
  private fault(handle: QuickJSHandle): SessionOutcome {
    let dumped: unknown;
    try { dumped = this.vm.dump(handle); } catch { dumped = 'unknown error'; }
    try { handle.dispose(); } catch { /* ignore */ }
    const message = messageOf(dumped);
    if (/^(InternalError: )?interrupted$/.test(message)) {
      this.dispose();
      return { ok: false, reason: 'timeout', message: 'Script execution timed out.' };
    }
    if (/^(InternalError: )?out of memory$/.test(message)) {
      this.dispose();
      return { ok: false, reason: 'memory_limit', message };
    }
    return { ok: false, reason: 'error', message, error: dumped };
  }

  /** Runs `fn`, then the job queue, under one wall-time budget. */
  private slice(timeoutMs: number, fn: () => SessionOutcome): SessionOutcome {
    if (this.closed) return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
    this.deadline = Date.now() + budget(timeoutMs);
    try {
      const outcome = fn();
      if (outcome.ok === false && outcome.reason !== 'error') return outcome;
      for (;;) {
        if (this.closed) return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
        const jobs = this.runtime.executePendingJobs();
        if (jobs.error) {
          const fault = this.fault(jobs.error);
          if (fault.ok === false && fault.reason !== 'error') return fault;
          continue;
        }
        if (jobs.value <= 0) break;
      }
      if (this.interrupted || this.faulted === 'interrupted') {
        this.dispose();
        return { ok: false, reason: 'timeout', message: 'Script execution timed out.' };
      }
      if (this.faulted !== null) {
        this.dispose();
        return { ok: false, reason: 'memory_limit', message: this.faulted };
      }
      return outcome;
    } finally {
      this.deadline = Number.POSITIVE_INFINITY;
    }
  }

  init(source: string, primitive: QuickJSHandle): void {
    const outcome = this.slice(10_000, () => {
      const factory = this.vm.evalCode(source, 'olan-session.js', { type: 'global' });
      if (factory.error) return this.fault(factory.error);
      const result = this.vm.callFunction(factory.value, this.vm.undefined, primitive);
      factory.value.dispose();
      if (result.error) return this.fault(result.error);
      this.api = result.value;
      return { ok: true, value: undefined };
    });
    if (!outcome.ok) throw new Error(`the sandbox prelude failed: ${outcome.message}`);
  }

  evaluate(source: string, options: { filename: string; timeoutMs: number }): Promise<SessionOutcome> {
    return Promise.resolve(this.slice(options.timeoutMs, () => {
      const result = this.vm.evalCode(source, options.filename, { type: 'global' });
      if (result.error) return this.fault(result.error);
      result.value.dispose();
      return { ok: true, value: undefined };
    }));
  }

  call(name: string, args: SessionValue[], options: { timeoutMs: number }): Promise<SessionOutcome> {
    return Promise.resolve(this.slice(options.timeoutMs, () => {
      const vm = this.vm;
      const fn = vm.getProp(this.api!, name);
      try {
        if (vm.typeof(fn) !== 'function') return { ok: false, reason: 'error', message: `the prelude has no entry ${name}`, error: undefined };
        const handles = args.map((arg) => (typeof arg === 'string' ? vm.newString(arg) : typeof arg === 'number' ? vm.newNumber(arg) : arg === true ? vm.true : arg === false ? vm.false : vm.null));
        const result = vm.callFunction(fn, vm.undefined, ...handles);
        for (const handle of handles) if (handle.alive && handle !== vm.true && handle !== vm.false && handle !== vm.null) handle.dispose();
        if (result.error) return this.fault(result.error);
        const value = vm.dump(result.value) as unknown;
        result.value.dispose();
        return { ok: true, value: typeof value === 'object' && value !== null ? undefined : (value as SessionValue | undefined) };
      } finally {
        if (fn.alive) fn.dispose();
      }
    }));
  }

  dispose(): void {
    // As in the QuickJS engine: after an interrupt or OOM the heap may still hold objects and
    // freeing such a runtime trips QuickJS assertions, so the whole module (one per session) is
    // dropped and garbage-collected instead of freed.
    this.closed = true;
  }
}

async function quickJsSession(options: SandboxSessionOptions): Promise<SandboxSession> {
  const module = await newQuickJSWASMModule(RELEASE_SYNC);
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(Math.max(8, options.memoryMb) * 1024 * 1024);
  runtime.setMaxStackSize(STACK_BYTES);
  const vm = runtime.newContext();
  const session = new QuickJsSession(runtime, vm);
  const primitive = vm.newFunction('call', (name, data) => {
    const callName = vm.getString(name!);
    if (callName === FAULT_CALL) {
      session.faulted ??= vm.getString(data!);
      return vm.undefined;
    }
    const answer = options.onCall(callName, vm.getString(data!));
    return typeof answer === 'string' ? vm.newString(answer) : vm.undefined;
  });
  try {
    session.init(sessionSource(options.prelude), primitive);
  } finally {
    primitive.dispose();
  }
  return session;
}

// ---------------------------------------------------------------------------------------------

/**
 * Creates a sandbox session. `auto` prefers isolated-vm and falls back to QuickJS with a warning
 * when the native module cannot be loaded here. isolated-vm needs a host started with
 * `--no-node-snapshot` and never with `--expose-gc`.
 */
export async function createSandboxSession(options: SandboxSessionOptions): Promise<SandboxSession> {
  const choice = options.engine ?? 'auto';
  if (choice === 'quickjs') return quickJsSession(options);
  const loaded = loadIsolatedVm();
  if ('error' in loaded) {
    if (choice === 'isolated-vm') throw new Error(`isolated-vm is not available on ${process.platform}-${process.arch}: ${loaded.error.message}`);
    options.onWarning?.(`isolated-vm prebuild not available on ${process.platform}-${process.arch}; using QuickJS (slower). Reason: ${loaded.error.message}`);
    return quickJsSession(options);
  }
  if (hostExposesGc()) {
    options.onWarning?.('this process runs with --expose-gc; V8 would expose gc to sandbox code. The bootstrap hides it, but run without --expose-gc.');
  }
  return isolatedVmSession(loaded.ivm, options);
}

/** The engine `createSandboxSession({ engine })` would use here. */
export function resolveSessionEngine(choice: EngineChoice = 'auto'): EngineName {
  if (choice !== 'auto') return choice;
  return 'error' in loadIsolatedVm() ? 'quickjs' : 'isolated-vm';
}
