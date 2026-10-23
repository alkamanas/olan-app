import { newQuickJSWASMModule, RELEASE_SYNC } from 'quickjs-emscripten';
import { ENCODING_GLOBALS_SOURCE, FORBIDDEN_GLOBALS_SOURCE } from './bootstrap.js';
import { loadIsolatedVm } from './engines/isolated-vm.js';
import { hostExposesGc } from './runtime.js';
export const CODE_GENERATION_BLOCKED = 'Code generation from strings disallowed for this context';
/** Bridge name of `host.fault(error)`; intercepted by the session, never passed to `onCall`. */
const FAULT_CALL = '__olan_session_fault';
/**
 * Session bootstrap: `(function (call) { … return prelude(host); })`, where `call(name, data)` is
 * the engine primitive. `PRELUDE` is replaced with the caller's prelude source.
 */
const SESSION_BOOTSTRAP = String.raw `(function (call) {
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
function sessionSource(prelude) {
    const index = SESSION_BOOTSTRAP.lastIndexOf('(PRELUDE)');
    return `${SESSION_BOOTSTRAP.slice(0, index)}(${prelude})${SESSION_BOOTSTRAP.slice(index + '(PRELUDE)'.length)}`;
}
function messageOf(error) {
    if (error && typeof error === 'object' && 'message' in error)
        return String(error.message);
    try {
        return String(error);
    }
    catch {
        return 'unknown error';
    }
}
const budget = (timeoutMs) => Math.max(1, Math.ceil(Number.isFinite(timeoutMs) ? timeoutMs : 1));
// ---------------------------------------------------------------------------------------------
// isolated-vm
// ---------------------------------------------------------------------------------------------
class IsolatedVmSession {
    isolate;
    context;
    api;
    references;
    engine = 'isolated-vm';
    closed = false;
    entries = new Map();
    constructor(isolate, context, api, references) {
        this.isolate = isolate;
        this.context = context;
        this.api = api;
        this.references = references;
    }
    get disposed() {
        return this.closed || this.isolate.isDisposed;
    }
    fault(error) {
        if (this.isolate.isDisposed && !this.closed) {
            this.dispose();
            const message = messageOf(error);
            if (/memory limit/i.test(message))
                return { ok: false, reason: 'memory_limit', message };
            return { ok: false, reason: 'disposed', message };
        }
        if (this.closed)
            return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
        const message = messageOf(error);
        if (error instanceof Error && /^Script execution timed out\.?$/.test(message)) {
            this.dispose();
            return { ok: false, reason: 'timeout', message };
        }
        return { ok: false, reason: 'error', message, error };
    }
    async evaluate(source, options) {
        if (this.disposed)
            return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
        let script;
        try {
            script = await this.isolate.compileScript(source, { filename: options.filename });
        }
        catch (error) {
            // isolated-vm appends ` [file:line:column]` to compile errors; keep V8's own message.
            if (error instanceof Error)
                error.message = error.message.replace(/ \[[^\]]*:\d+:\d+\]$/, '');
            return this.fault(error);
        }
        try {
            await script.run(this.context, { timeout: budget(options.timeoutMs) });
            return { ok: true, value: undefined };
        }
        catch (error) {
            return this.fault(error);
        }
        finally {
            try {
                script.release();
            }
            catch { /* isolate gone */ }
        }
    }
    entry(name) {
        let found = this.entries.get(name);
        if (!found) {
            found = this.api.get(name, { reference: true });
            this.entries.set(name, found);
            found.then((reference) => this.references.push(reference), () => undefined);
        }
        return found;
    }
    async call(name, args, options) {
        if (this.disposed)
            return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
        try {
            const fn = await this.entry(name);
            if (fn.typeof !== 'function')
                return { ok: false, reason: 'error', message: `the prelude has no entry ${name}`, error: undefined };
            const value = await fn.apply(undefined, args, { arguments: { copy: true }, result: { copy: true }, timeout: budget(options.timeoutMs) });
            return { ok: true, value: value };
        }
        catch (error) {
            return this.fault(error);
        }
    }
    dispose() {
        if (this.closed)
            return;
        this.closed = true;
        for (const reference of this.references) {
            try {
                reference.release();
            }
            catch { /* isolate gone */ }
        }
        try {
            this.context.release();
        }
        catch { /* isolate gone */ }
        try {
            if (!this.isolate.isDisposed)
                this.isolate.dispose();
        }
        catch { /* already disposed */ }
    }
}
async function isolatedVmSession(ivm, options) {
    const isolate = new ivm.Isolate({
        memoryLimit: Math.max(8, options.memoryMb),
        onCatastrophicError: options.onCatastrophicError ?? defaultCatastrophe,
    });
    try {
        const context = await isolate.createContext();
        // isolated-vm faults are not catchable; host.fault never calls back there.
        const primitive = new ivm.Reference((name, data) => (name === FAULT_CALL ? undefined : options.onCall(String(name), String(data))));
        const api = await context.evalClosure(`const call = (name, data) => $0.applySync(undefined, [name, data], { arguments: { copy: true }, result: { copy: true } });
return ${sessionSource(options.prelude)}(call);`, [primitive], { result: { reference: true } });
        return new IsolatedVmSession(isolate, context, api, [primitive, api]);
    }
    catch (error) {
        try {
            isolate.dispose();
        }
        catch { /* already disposed */ }
        throw error;
    }
}
function defaultCatastrophe(message) {
    process.stderr.write(`[olan-app-runtime] isolated-vm catastrophic error, exiting: ${message}\n`);
    process.exit(70);
}
// ---------------------------------------------------------------------------------------------
// QuickJS
// ---------------------------------------------------------------------------------------------
const STACK_BYTES = 1024 * 1024;
class QuickJsSession {
    runtime;
    vm;
    engine = 'quickjs';
    closed = false;
    deadline = Number.POSITIVE_INFINITY;
    /** Set when the interrupt handler stopped code: promise jobs swallow the interrupt as a rejection. */
    interrupted = false;
    /** Out-of-memory or interrupt seen by prelude code (`host.fault`). */
    faulted = null;
    api = null;
    constructor(runtime, vm) {
        this.runtime = runtime;
        this.vm = vm;
        runtime.setInterruptHandler(() => {
            if (Date.now() <= this.deadline)
                return false;
            this.interrupted = true;
            return true;
        });
    }
    get disposed() {
        return this.closed;
    }
    /** Dumps a thrown handle; classifies interrupts and out-of-memory as engine faults. */
    fault(handle) {
        let dumped;
        try {
            dumped = this.vm.dump(handle);
        }
        catch {
            dumped = 'unknown error';
        }
        try {
            handle.dispose();
        }
        catch { /* ignore */ }
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
    slice(timeoutMs, fn) {
        if (this.closed)
            return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
        this.deadline = Date.now() + budget(timeoutMs);
        try {
            const outcome = fn();
            if (outcome.ok === false && outcome.reason !== 'error')
                return outcome;
            for (;;) {
                if (this.closed)
                    return { ok: false, reason: 'disposed', message: 'the sandbox was disposed' };
                const jobs = this.runtime.executePendingJobs();
                if (jobs.error) {
                    const fault = this.fault(jobs.error);
                    if (fault.ok === false && fault.reason !== 'error')
                        return fault;
                    continue;
                }
                if (jobs.value <= 0)
                    break;
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
        }
        finally {
            this.deadline = Number.POSITIVE_INFINITY;
        }
    }
    init(source, primitive) {
        const outcome = this.slice(10_000, () => {
            const factory = this.vm.evalCode(source, 'olan-session.js', { type: 'global' });
            if (factory.error)
                return this.fault(factory.error);
            const result = this.vm.callFunction(factory.value, this.vm.undefined, primitive);
            factory.value.dispose();
            if (result.error)
                return this.fault(result.error);
            this.api = result.value;
            return { ok: true, value: undefined };
        });
        if (!outcome.ok)
            throw new Error(`the sandbox prelude failed: ${outcome.message}`);
    }
    evaluate(source, options) {
        return Promise.resolve(this.slice(options.timeoutMs, () => {
            const result = this.vm.evalCode(source, options.filename, { type: 'global' });
            if (result.error)
                return this.fault(result.error);
            result.value.dispose();
            return { ok: true, value: undefined };
        }));
    }
    call(name, args, options) {
        return Promise.resolve(this.slice(options.timeoutMs, () => {
            const vm = this.vm;
            const fn = vm.getProp(this.api, name);
            try {
                if (vm.typeof(fn) !== 'function')
                    return { ok: false, reason: 'error', message: `the prelude has no entry ${name}`, error: undefined };
                const handles = args.map((arg) => (typeof arg === 'string' ? vm.newString(arg) : typeof arg === 'number' ? vm.newNumber(arg) : arg === true ? vm.true : arg === false ? vm.false : vm.null));
                const result = vm.callFunction(fn, vm.undefined, ...handles);
                for (const handle of handles)
                    if (handle.alive && handle !== vm.true && handle !== vm.false && handle !== vm.null)
                        handle.dispose();
                if (result.error)
                    return this.fault(result.error);
                const value = vm.dump(result.value);
                result.value.dispose();
                return { ok: true, value: typeof value === 'object' && value !== null ? undefined : value };
            }
            finally {
                if (fn.alive)
                    fn.dispose();
            }
        }));
    }
    dispose() {
        // As in the QuickJS engine: after an interrupt or OOM the heap may still hold objects and
        // freeing such a runtime trips QuickJS assertions, so the whole module (one per session) is
        // dropped and garbage-collected instead of freed.
        this.closed = true;
    }
}
async function quickJsSession(options) {
    const module = await newQuickJSWASMModule(RELEASE_SYNC);
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(Math.max(8, options.memoryMb) * 1024 * 1024);
    runtime.setMaxStackSize(STACK_BYTES);
    const vm = runtime.newContext();
    const session = new QuickJsSession(runtime, vm);
    const primitive = vm.newFunction('call', (name, data) => {
        const callName = vm.getString(name);
        if (callName === FAULT_CALL) {
            session.faulted ??= vm.getString(data);
            return vm.undefined;
        }
        const answer = options.onCall(callName, vm.getString(data));
        return typeof answer === 'string' ? vm.newString(answer) : vm.undefined;
    });
    try {
        session.init(sessionSource(options.prelude), primitive);
    }
    finally {
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
export async function createSandboxSession(options) {
    const choice = options.engine ?? 'auto';
    if (choice === 'quickjs')
        return quickJsSession(options);
    const loaded = loadIsolatedVm();
    if ('error' in loaded) {
        if (choice === 'isolated-vm')
            throw new Error(`isolated-vm is not available on ${process.platform}-${process.arch}: ${loaded.error.message}`);
        options.onWarning?.(`isolated-vm prebuild not available on ${process.platform}-${process.arch}; using QuickJS (slower). Reason: ${loaded.error.message}`);
        return quickJsSession(options);
    }
    if (hostExposesGc()) {
        options.onWarning?.('this process runs with --expose-gc; V8 would expose gc to sandbox code. The bootstrap hides it, but run without --expose-gc.');
    }
    return isolatedVmSession(loaded.ivm, options);
}
/** The engine `createSandboxSession({ engine })` would use here. */
export function resolveSessionEngine(choice = 'auto') {
    if (choice !== 'auto')
        return choice;
    return 'error' in loadIsolatedVm() ? 'quickjs' : 'isolated-vm';
}
