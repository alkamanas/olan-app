/**
 * isolated-vm engine: one V8 isolate + context per installation.
 *
 * The bridge follows the spike: engine primitives are `ivm.Reference`s captured by the
 * bootstrap closure (`evalClosure` `$0…$3`), never stored on the global. CPU is enforced by the
 * core's watchdog on `isolate.cpuTime` (covers continuations after `await`), wall time and limit
 * kills by `isolate.dispose()`. Requires a host started with `--no-node-snapshot` (Node 20+).
 */
import { createRequire } from 'node:module';
import { BOOTSTRAP_SOURCE } from '../bootstrap.js';
import { BundleError } from '../core.js';
let cached = null;
/** Loads the native module once; returns the reason when no prebuild/binary is usable here. */
export function loadIsolatedVm() {
    if (cached)
        return cached;
    try {
        const require = createRequire(import.meta.url);
        const ivm = require('isolated-vm');
        if (typeof ivm?.Isolate !== 'function')
            throw new Error('isolated-vm did not export Isolate');
        cached = { ivm };
    }
    catch (error) {
        cached = { error: error instanceof Error ? error : new Error(String(error)) };
    }
    return cached;
}
const PRIMITIVES = `const P = {
  host: (callId, hostCallId, method, argsJson) => $0.applyIgnored(undefined, [callId, hostCallId, method, argsJson], { arguments: { copy: true } }),
  log: (callId, level, message) => $1.applyIgnored(undefined, [callId, level, message], { arguments: { copy: true } }),
  timerSet: (callId, timerId, delayMs) => $2.applyIgnored(undefined, [callId, timerId, delayMs], { arguments: { copy: true } }),
  timerClear: (timerId) => $3.applyIgnored(undefined, [timerId], { arguments: { copy: true } }),
};
return (${BOOTSTRAP_SOURCE})(P);`;
class IsolatedVmSandbox {
    isolate;
    context;
    api;
    references;
    lastCpuMs = 0;
    disposed = false;
    constructor(isolate, context, api, references) {
        this.isolate = isolate;
        this.context = context;
        this.api = api;
        this.references = references;
    }
    async load(source, callId) {
        let script;
        try {
            script = await this.isolate.compileScript(source, { filename: 'dist/server.js' });
        }
        catch (error) {
            throw new BundleError(`dist/server.js does not compile: ${error.message}`);
        }
        try {
            await script.run(this.context);
        }
        catch (error) {
            throw new BundleError(`dist/server.js threw while loading: ${error.message}`);
        }
        finally {
            script.release();
        }
        const problem = await this.api.load.apply(undefined, [callId], { arguments: { copy: true }, result: { copy: true } });
        if (problem)
            throw new BundleError(problem);
    }
    invoke(callId, kind, name, fallback, payloadJson, contextJson) {
        return this.api.invoke.apply(undefined, [callId, kind, name, fallback, payloadJson, contextJson], {
            arguments: { copy: true },
            result: { promise: true, copy: true },
        });
    }
    settleHost(hostCallId, envelope) {
        if (this.disposed)
            return;
        this.api.settleHost.apply(undefined, [hostCallId, envelope], { arguments: { copy: true } }).catch(() => undefined);
    }
    fireTimer(timerId) {
        if (this.disposed)
            return;
        this.api.fireTimer.apply(undefined, [timerId], { arguments: { copy: true } }).catch(() => undefined);
    }
    cpuTimeMs() {
        if (!this.disposed) {
            try {
                this.lastCpuMs = Number(this.isolate.cpuTime) / 1e6;
            }
            catch {
                // disposed by V8 (memory limit)
            }
        }
        return this.lastCpuMs;
    }
    dispose() {
        if (this.disposed)
            return;
        this.cpuTimeMs();
        this.disposed = true;
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
export function isolatedVmDriver(ivm, options) {
    return {
        name: 'isolated-vm',
        classifyFault: (message) => (/memory limit|out of memory|heap/i.test(message) ? 'memory_limit' : 'runtime_unavailable'),
        async createSandbox({ memoryMb, hooks }) {
            const isolate = new ivm.Isolate({
                memoryLimit: Math.max(8, memoryMb),
                onCatastrophicError: options.onCatastrophicError,
            });
            try {
                const context = await isolate.createContext();
                const primitives = [
                    new ivm.Reference((callId, hostCallId, method, argsJson) => hooks.host(callId, hostCallId, method, argsJson)),
                    new ivm.Reference((callId, level, message) => hooks.log(callId, level, message)),
                    new ivm.Reference((callId, timerId, delayMs) => hooks.timerSet(callId, timerId, delayMs)),
                    new ivm.Reference((timerId) => hooks.timerClear(timerId)),
                ];
                const api = await context.evalClosure(PRIMITIVES, primitives, { result: { reference: true } });
                const get = (name) => api.get(name, { reference: true });
                const [load, invoke, settleHost, fireTimer] = await Promise.all([get('load'), get('invoke'), get('settleHost'), get('fireTimer')]);
                api.release();
                return new IsolatedVmSandbox(isolate, context, { load, invoke, settleHost, fireTimer }, [...primitives, load, invoke, settleHost, fireTimer]);
            }
            catch (error) {
                try {
                    isolate.dispose();
                }
                catch { /* already disposed */ }
                throw error;
            }
        },
    };
}
