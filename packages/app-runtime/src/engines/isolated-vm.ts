/**
 * isolated-vm engine: one V8 isolate + context per installation.
 *
 * The bridge follows the spike: engine primitives are `ivm.Reference`s captured by the
 * bootstrap closure (`evalClosure` `$0…$3`), never stored on the global. CPU is enforced by the
 * core's watchdog on `isolate.cpuTime` (covers continuations after `await`), wall time and limit
 * kills by `isolate.dispose()`. Requires a host started with `--no-node-snapshot` (Node 20+).
 */
import { createRequire } from 'node:module';
import type * as IvmModule from 'isolated-vm';
import { BOOTSTRAP_SOURCE } from '../bootstrap.js';
import { BundleError, type EngineDriver, type Sandbox, type SandboxOptions } from '../core.js';

type Ivm = typeof IvmModule;

let cached: { ivm: Ivm } | { error: Error } | null = null;

/** Loads the native module once; returns the reason when no prebuild/binary is usable here. */
export function loadIsolatedVm(): { ivm: Ivm } | { error: Error } {
  if (cached) return cached;
  try {
    const require = createRequire(import.meta.url);
    const ivm = require('isolated-vm') as Ivm;
    if (typeof ivm?.Isolate !== 'function') throw new Error('isolated-vm did not export Isolate');
    cached = { ivm };
  } catch (error) {
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

class IsolatedVmSandbox implements Sandbox {
  private lastCpuMs = 0;
  private disposed = false;

  constructor(
    private readonly isolate: IvmModule.Isolate,
    private readonly context: IvmModule.Context,
    private readonly api: {
      load: IvmModule.Reference;
      invoke: IvmModule.Reference;
      settleHost: IvmModule.Reference;
      fireTimer: IvmModule.Reference;
    },
    private readonly references: IvmModule.Reference[],
  ) {}

  async load(source: string, callId: number): Promise<void> {
    let script: IvmModule.Script;
    try {
      script = await this.isolate.compileScript(source, { filename: 'dist/server.js' });
    } catch (error) {
      throw new BundleError(`dist/server.js does not compile: ${(error as Error).message}`);
    }
    try {
      await script.run(this.context);
    } catch (error) {
      throw new BundleError(`dist/server.js threw while loading: ${(error as Error).message}`);
    } finally {
      script.release();
    }
    const problem = await this.api.load.apply(undefined, [callId], { arguments: { copy: true }, result: { copy: true } }) as string;
    if (problem) throw new BundleError(problem);
  }

  invoke(callId: number, kind: string, name: string, fallback: string, payloadJson: string, contextJson: string): Promise<string> {
    return this.api.invoke.apply(undefined, [callId, kind, name, fallback, payloadJson, contextJson], {
      arguments: { copy: true },
      result: { promise: true, copy: true },
    }) as Promise<string>;
  }

  settleHost(hostCallId: number, envelope: string): void {
    if (this.disposed) return;
    this.api.settleHost.apply(undefined, [hostCallId, envelope], { arguments: { copy: true } }).catch(() => undefined);
  }

  fireTimer(timerId: number): void {
    if (this.disposed) return;
    this.api.fireTimer.apply(undefined, [timerId], { arguments: { copy: true } }).catch(() => undefined);
  }

  cpuTimeMs(): number {
    if (!this.disposed) {
      try {
        this.lastCpuMs = Number(this.isolate.cpuTime) / 1e6;
      } catch {
        // disposed by V8 (memory limit)
      }
    }
    return this.lastCpuMs;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cpuTimeMs();
    this.disposed = true;
    for (const reference of this.references) {
      try { reference.release(); } catch { /* isolate gone */ }
    }
    try { this.context.release(); } catch { /* isolate gone */ }
    try { if (!this.isolate.isDisposed) this.isolate.dispose(); } catch { /* already disposed */ }
  }
}

export interface IsolatedVmDriverOptions {
  onCatastrophicError: (message: string) => void;
}

export function isolatedVmDriver(ivm: Ivm, options: IsolatedVmDriverOptions): EngineDriver {
  return {
    name: 'isolated-vm',
    classifyFault: (message) => (/memory limit|out of memory|heap/i.test(message) ? 'memory_limit' : 'runtime_unavailable'),
    async createSandbox({ memoryMb, hooks }: SandboxOptions): Promise<Sandbox> {
      const isolate = new ivm.Isolate({
        memoryLimit: Math.max(8, memoryMb),
        onCatastrophicError: options.onCatastrophicError,
      });
      try {
        const context = await isolate.createContext();
        const primitives = [
          new ivm.Reference((callId: number, hostCallId: number, method: string, argsJson: string) => hooks.host(callId, hostCallId, method, argsJson)),
          new ivm.Reference((callId: number, level: string, message: string) => hooks.log(callId, level, message)),
          new ivm.Reference((callId: number, timerId: number, delayMs: number) => hooks.timerSet(callId, timerId, delayMs)),
          new ivm.Reference((timerId: number) => hooks.timerClear(timerId)),
        ];
        const api = await context.evalClosure(PRIMITIVES, primitives, { result: { reference: true } }) as IvmModule.Reference;
        const get = (name: string) => api.get(name, { reference: true }) as Promise<IvmModule.Reference>;
        const [load, invoke, settleHost, fireTimer] = await Promise.all([get('load'), get('invoke'), get('settleHost'), get('fireTimer')]);
        api.release();
        return new IsolatedVmSandbox(isolate, context, { load, invoke, settleHost, fireTimer }, [...primitives, load, invoke, settleHost, fireTimer]);
      } catch (error) {
        try { isolate.dispose(); } catch { /* already disposed */ }
        throw error;
      }
    },
  };
}
