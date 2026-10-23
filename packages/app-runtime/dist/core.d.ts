/**
 * Engine-neutral part of the runtime: installation registry (one sandbox per installation,
 * cached by digest), concurrency, payload caps, per-call CPU/wall enforcement, console capture
 * and timers. Engines only provide a {@link Sandbox}: load code, run the bootstrap API, report
 * cumulative CPU time and tear down.
 */
import { type AppRuntime, type EngineName, type HostCall, type InvocationRequest, type InvocationResult, type RuntimeStats } from './types.js';
/** Callbacks from a sandbox into the core (all fire-and-forget, strings and numbers only). */
export interface SandboxHooks {
    host(callId: number, hostCallId: number, method: string, argsJson: string): void;
    log(callId: number, level: string, message: string): void;
    timerSet(callId: number, timerId: number, delayMs: number): void;
    timerClear(timerId: number): void;
    /** Synchronous engines (QuickJS) ask this while code runs; true interrupts execution. */
    shouldInterrupt(): boolean;
    /** The engine failed outside an invocation's own promise (OOM in a job, interrupt). */
    fault(message: string): void;
}
export interface SandboxOptions {
    memoryMb: number;
    hooks: SandboxHooks;
}
export interface Sandbox {
    /** Evaluates the bundle and binds the backend definition; throws {@link BundleError}. */
    load(source: string, callId: number): Promise<void>;
    /** Resolves with the bootstrap envelope; rejects when the engine itself fails (disposed, OOM). */
    invoke(callId: number, kind: string, name: string, fallback: string, payloadJson: string, contextJson: string): Promise<string>;
    settleHost(hostCallId: number, envelope: string): void;
    fireTimer(timerId: number): void;
    /** Cumulative CPU time spent running this sandbox's code, in ms. */
    cpuTimeMs(): number;
    dispose(): void;
}
export interface EngineDriver {
    readonly name: EngineName;
    createSandbox(options: SandboxOptions): Promise<Sandbox>;
    /** Classifies an engine-level failure message (`memory_limit` or `runtime_unavailable`). */
    classifyFault(message: string): 'memory_limit' | 'runtime_unavailable';
}
export declare class BundleError extends Error {
    constructor(message: string);
}
export declare class SandboxRuntime implements AppRuntime {
    private readonly driver;
    readonly engine: EngineName;
    private readonly slots;
    private readonly retired;
    private readonly active;
    private nextCallId;
    private disposed;
    constructor(driver: EngineDriver);
    stats(): RuntimeStats;
    unload(installationId: string): Promise<void>;
    dispose(): Promise<void>;
    invoke(request: InvocationRequest, code: () => Promise<string>, host: HostCall): Promise<InvocationResult>;
    private run;
    /** The installation's sandbox for this digest, created (and loaded) when missing or stale. */
    private slotFor;
    private load;
    private hooksFor;
    private startWatchdog;
    private stopWatchdog;
    /** Calls that are over their CPU or wall budget. */
    private limitReasons;
    private enforce;
    private fault;
    /** Tears the sandbox down; calls in `reasons` get their code, the rest `runtime_unavailable`. */
    private kill;
    private finish;
}
