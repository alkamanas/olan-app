/**
 * `@olan-app/runtime` interface (Phase 3 contract §15.2). Both engines and the process client
 * implement {@link AppRuntime}; the Platform service only talks to this interface.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export type EngineName = 'isolated-vm' | 'quickjs';
export interface RuntimeLimits {
    /** CPU budget of one invocation, including continuations after `await` and timer callbacks. */
    cpuMs: number;
    /** Wall-clock budget of one invocation; the installation's sandbox is torn down when it runs out. */
    wallMs: number;
    /** Heap limit of the installation's isolate (QuickJS: runtime memory limit). */
    memoryMb: number;
    /** Simultaneous invocations per installation; more are rejected with `concurrency_limit`. */
    concurrency: number;
}
export type InvocationKind = 'function' | 'schedule' | 'event' | 'hook' | 'migrate';
export interface InvocationIdentity {
    actor: 'user' | 'app';
    userId: string | null;
    permissions: string[];
}
export interface InvocationRequest {
    installationId: string;
    /** sha256 of `dist/server.js`; the code is loaded once per digest. */
    digest: string;
    kind: InvocationKind;
    name: string;
    /** §15.1 handler resolution: the `functions` entry used when the kind-specific map has no `name`. */
    fallback?: string;
    /** args | event | hook request | `{ schedule, scheduledAt }` | `{ fromVersion }` */
    payload: JsonValue;
    context: {
        appId: string;
        identity: InvocationIdentity;
    };
    limits: RuntimeLimits;
}
export type LogLevel = 'log' | 'info' | 'warn' | 'error';
export interface LogLine {
    level: LogLevel;
    message: string;
    /** ISO timestamp taken on the host when the line arrived. */
    at: string;
}
export type InvocationErrorCode = 'cpu_limit' | 'timeout' | 'memory_limit' | 'concurrency_limit' | 'payload_too_large' | 'not_found' | 'handler_error' | 'bundle_error' | 'runtime_unavailable';
export type InvocationResult = {
    ok: true;
    value: JsonValue;
    logs: LogLine[];
    cpuMs: number;
    wallMs: number;
} | {
    ok: false;
    error: {
        code: InvocationErrorCode;
        message: string;
    };
    logs: LogLine[];
    cpuMs: number;
    wallMs: number;
};
/** The host side of `__olan.call(method, argsJson)`. Rejects with `{ code, message }`. */
export type HostCall = (installationId: string, method: string, argsJson: string) => Promise<string>;
export interface RuntimeStats {
    installations: number;
    engine: EngineName;
}
export interface AppRuntime {
    readonly engine: EngineName;
    /** `code` is only called when the installation has no sandbox for `request.digest` yet. */
    invoke(request: InvocationRequest, code: () => Promise<string>, host: HostCall): Promise<InvocationResult>;
    unload(installationId: string): Promise<void>;
    stats(): RuntimeStats;
    dispose(): Promise<void>;
}
export type EngineChoice = 'auto' | EngineName;
export interface CreateRuntimeOptions {
    engine?: EngineChoice;
    /** Non-fatal notices, e.g. falling back to QuickJS or a host started with `--expose-gc`. */
    onWarning?: (message: string) => void;
    /**
     * isolated-vm lost control of an isolate: the process must stop serving and exit.
     * Default: write the message to stderr and exit with code 70 (the client restarts the process).
     */
    onCatastrophicError?: (message: string) => void;
}
/** Argument and result size cap (§8.1). */
export declare const MAX_PAYLOAD_BYTES: number;
/** Console lines kept per invocation (§8.1); one truncation marker follows. */
export declare const MAX_LOG_LINES = 1000;
/** Bytes kept per console line. */
export declare const MAX_LOG_LINE_BYTES: number;
