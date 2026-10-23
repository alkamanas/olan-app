import type { EngineChoice, EngineName } from './types.js';
/** Values crossing the bridge as entry arguments and results. */
export type SessionValue = string | number | boolean | null;
export type SessionOutcome = {
    ok: true;
    value: SessionValue | undefined;
}
/** Sandbox code threw; `error` is the thrown value as copied out of the sandbox. */
 | {
    ok: false;
    reason: 'error';
    message: string;
    error: unknown;
}
/** The entry ran past its budget (the session is disposed), hit the memory limit, or the session was already disposed. */
 | {
    ok: false;
    reason: 'timeout' | 'memory_limit' | 'disposed';
    message: string;
};
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
    evaluate(source: string, options: {
        filename: string;
        timeoutMs: number;
    }): Promise<SessionOutcome>;
    /** Calls an entry function returned by the prelude. */
    call(name: string, args: SessionValue[], options: {
        timeoutMs: number;
    }): Promise<SessionOutcome>;
    dispose(): void;
}
export declare const CODE_GENERATION_BLOCKED = "Code generation from strings disallowed for this context";
/**
 * Creates a sandbox session. `auto` prefers isolated-vm and falls back to QuickJS with a warning
 * when the native module cannot be loaded here. isolated-vm needs a host started with
 * `--no-node-snapshot` and never with `--expose-gc`.
 */
export declare function createSandboxSession(options: SandboxSessionOptions): Promise<SandboxSession>;
/** The engine `createSandboxSession({ engine })` would use here. */
export declare function resolveSessionEngine(choice?: EngineChoice): EngineName;
