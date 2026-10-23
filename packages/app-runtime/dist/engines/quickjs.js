/**
 * QuickJS-WASM engine (quickjs-emscripten, synchronous release build): one WebAssembly module
 * instance, runtime and context per installation, so installations do not share linear memory.
 *
 * Async host calls do not use asyncify: `__olan.call` returns an in-sandbox promise that the host
 * settles later (`settleHost`), and the host pumps the job queue after every entry. Every entry
 * into the VM is a "slice" whose duration is charged as CPU time; the interrupt handler asks the
 * core whether any running invocation is over its CPU or wall budget.
 */
import { newQuickJSWASMModule, RELEASE_SYNC, } from 'quickjs-emscripten';
import { BOOTSTRAP_SOURCE } from '../bootstrap.js';
import { BundleError } from '../core.js';
const STACK_BYTES = 1024 * 1024;
class QuickJsSandbox {
    runtime;
    context;
    hooks;
    cpuMs = 0;
    sliceStart = 0;
    depth = 0;
    disposed = false;
    faulted = null;
    pending = new Map();
    api;
    constructor(runtime, context, hooks) {
        this.runtime = runtime;
        this.context = context;
        this.hooks = hooks;
    }
    bootstrap() {
        const { context: vm, hooks } = this;
        const primitives = vm.newObject();
        const define = (name, fn) => {
            const handle = vm.newFunction(name, (...args) => {
                fn(...args);
            });
            vm.setProp(primitives, name, handle);
            handle.dispose();
        };
        define('host', (callId, hostCallId, method, argsJson) => hooks.host(vm.getNumber(callId), vm.getNumber(hostCallId), vm.getString(method), vm.getString(argsJson)));
        define('log', (callId, level, message) => hooks.log(vm.getNumber(callId), vm.getString(level), vm.getString(message)));
        define('timerSet', (callId, timerId, delayMs) => hooks.timerSet(vm.getNumber(callId), vm.getNumber(timerId), vm.getNumber(delayMs)));
        define('timerClear', (timerId) => hooks.timerClear(vm.getNumber(timerId)));
        define('done', (callId, envelope) => {
            const id = vm.getNumber(callId);
            const resolve = this.pending.get(id);
            this.pending.delete(id);
            resolve?.(vm.getString(envelope));
        });
        const api = this.slice(() => {
            const factory = vm.unwrapResult(vm.evalCode(BOOTSTRAP_SOURCE, 'olan-bootstrap.js'));
            const result = vm.unwrapResult(vm.callFunction(factory, vm.undefined, primitives));
            factory.dispose();
            return result;
        });
        primitives.dispose();
        this.api = {
            load: vm.getProp(api, 'load'),
            invoke: vm.getProp(api, 'invoke'),
            settleHost: vm.getProp(api, 'settleHost'),
            fireTimer: vm.getProp(api, 'fireTimer'),
        };
        api.dispose();
    }
    /** Runs `fn` inside the VM, then drains the job queue; the elapsed time is charged as CPU. */
    slice(fn) {
        const outermost = this.depth === 0;
        if (outermost)
            this.sliceStart = performance.now();
        this.depth++;
        try {
            const result = fn();
            if (outermost)
                this.drain();
            return result;
        }
        finally {
            this.depth--;
            if (outermost) {
                this.cpuMs += performance.now() - this.sliceStart;
                if (this.faulted !== null) {
                    const message = this.faulted;
                    setImmediate(() => this.hooks.fault(message));
                }
            }
        }
    }
    drain() {
        for (;;) {
            if (this.faulted !== null || this.disposed)
                return;
            const result = this.runtime.executePendingJobs();
            if (result.error) {
                this.recordFault(result.error);
                return;
            }
            const executed = result.value;
            if (executed <= 0)
                return;
        }
    }
    recordFault(handle) {
        let message = 'unknown error';
        try {
            const dumped = this.context.dump(handle);
            message = typeof dumped === 'object' && dumped !== null && 'message' in dumped ? String(dumped.message) : String(dumped);
        }
        catch { /* keep generic */ }
        try {
            handle.dispose();
        }
        catch { /* ignore */ }
        this.faulted ??= message;
    }
    callApi(fn, args) {
        const vm = this.context;
        const handles = args.map((arg) => (typeof arg === 'number' ? vm.newNumber(arg) : vm.newString(arg)));
        try {
            const result = vm.callFunction(fn, vm.undefined, ...handles);
            if (result.error) {
                this.recordFault(result.error);
                return null;
            }
            return result.value;
        }
        finally {
            for (const handle of handles)
                handle.dispose();
        }
    }
    async load(source, callId) {
        if (this.disposed)
            throw new BundleError('the sandbox was disposed');
        const vm = this.context;
        const problem = this.slice(() => {
            const evaluated = vm.evalCode(source, 'dist/server.js', { type: 'global' });
            if (evaluated.error) {
                const dumped = vm.dump(evaluated.error);
                evaluated.error.dispose();
                const message = typeof dumped === 'object' && dumped !== null && 'message' in dumped
                    ? `${dumped.name ?? 'Error'}: ${dumped.message}` : String(dumped);
                return `dist/server.js failed to load: ${message}`;
            }
            evaluated.value.dispose();
            const result = this.callApi(this.api.load, [callId]);
            if (!result)
                return `dist/server.js failed to load: ${this.faulted ?? 'unknown error'}`;
            const text = vm.getString(result);
            result.dispose();
            return text;
        });
        if (problem)
            throw new BundleError(problem);
    }
    invoke(callId, kind, name, fallback, payloadJson, contextJson) {
        if (this.disposed)
            return Promise.reject(new Error('the sandbox was disposed'));
        return new Promise((resolve, reject) => {
            this.pending.set(callId, (envelope) => {
                // QuickJS out-of-memory is a catchable InternalError and an interrupt inside an async
                // function rejects its promise: both are engine failures, not handler errors.
                if (envelope[0] === '0' && /"message":"(InternalError: )?out of memory"/.test(envelope))
                    reject(new Error('out of memory'));
                else if (envelope[0] === '0' && /"message":"(InternalError: )?interrupted"/.test(envelope))
                    reject(new Error('interrupted'));
                else
                    resolve(envelope);
            });
            this.slice(() => {
                const promise = this.callApi(this.api.invoke, [callId, kind, name, fallback, payloadJson, contextJson]);
                promise?.dispose();
            });
        });
    }
    settleHost(hostCallId, envelope) {
        if (this.disposed || this.faulted !== null)
            return;
        this.slice(() => this.callApi(this.api.settleHost, [hostCallId, envelope])?.dispose());
    }
    fireTimer(timerId) {
        if (this.disposed || this.faulted !== null)
            return;
        this.slice(() => this.callApi(this.api.fireTimer, [timerId])?.dispose());
    }
    cpuTimeMs() {
        return this.depth > 0 ? this.cpuMs + (performance.now() - this.sliceStart) : this.cpuMs;
    }
    dispose() {
        if (this.disposed)
            return;
        this.cpuMs = this.cpuTimeMs();
        this.disposed = true;
        for (const resolve of this.pending.values())
            resolve('0' + JSON.stringify({ code: 'runtime_unavailable', message: 'the sandbox was disposed' }));
        this.pending.clear();
        // The WebAssembly module belongs to this installation only. After an interrupt or OOM the
        // QuickJS heap may still hold objects, and freeing such a runtime trips QuickJS assertions
        // (an emscripten abort), so the whole module is dropped and garbage-collected instead.
    }
}
export function quickJsDriver() {
    return {
        name: 'quickjs',
        classifyFault: (message) => (/out of memory/i.test(message) ? 'memory_limit' : 'runtime_unavailable'),
        async createSandbox({ memoryMb, hooks }) {
            const module = await newQuickJSWASMModule(RELEASE_SYNC);
            const runtime = module.newRuntime();
            runtime.setMemoryLimit(memoryMb * 1024 * 1024);
            runtime.setMaxStackSize(STACK_BYTES);
            runtime.setInterruptHandler(() => hooks.shouldInterrupt());
            const context = runtime.newContext();
            const sandbox = new QuickJsSandbox(runtime, context, hooks);
            sandbox.bootstrap();
            return sandbox;
        },
    };
}
