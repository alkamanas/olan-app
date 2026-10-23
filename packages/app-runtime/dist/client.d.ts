/**
 * Main-service side: {@link RuntimeClient} implements {@link AppRuntime} over a frame transport
 * to a separate app-runtime process. `forkRuntime` starts the child (`dist/main.js`) with a
 * scrubbed environment and safe V8 flags; `connectRuntime` talks to a separate container over
 * TCP with a shared token. The client restarts/reconnects when the runtime goes away; invocations
 * in flight at that moment resolve with `runtime_unavailable`.
 */
import { type ChildProcess } from 'node:child_process';
import { type Frame, type FrameTransport, type RuntimeIntrospection } from './protocol.js';
import type { AppRuntime, EngineChoice, EngineName, HostCall, InvocationRequest, InvocationResult, RuntimeStats } from './types.js';
/** The runtime process entry (`dist/main.js`), also when this module runs from `src/` in tests. */
export declare const RUNTIME_ENTRY: string;
/**
 * Child environment: only PATH, NODE_ENV, TZ, SystemRoot (Windows) and OLAN_APP_RUNTIME_*.
 * Database URLs, secrets and NODE_OPTIONS never reach the runtime process.
 */
export declare function buildChildEnv(parent?: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string>;
/**
 * `--no-node-snapshot --max-old-space-size=N` plus the inherited flags that are safe to keep.
 * `--expose-gc` (which would leak `gc` into every isolate), other `--expose-*`,
 * `--allow-natives-syntax`, `--js-flags`, inspector flags, and flags that change the entry
 * (`-e`/`--eval`, `-p`/`--print`, `--input-type`, `--test*`, `--watch*`) are always removed.
 */
export declare function buildExecArgv(options?: {
    maxOldSpaceMb?: number;
    inherited?: string[];
}): string[];
export interface RuntimeClientOptions {
    /** Opens a new transport (spawns the child or connects the socket). */
    connect: () => Promise<{
        transport: FrameTransport;
        child?: ChildProcess;
    }>;
    /** TCP: the client opens with `hello{token}`. Fork: the child sends hello first. */
    token?: string;
    onWarning?: (message: string) => void;
    /** Called when the runtime went away and the client starts a new one. */
    onRestart?: (reason: string) => void;
    /** How long `invoke` waits for a (re)started runtime before answering `runtime_unavailable`. */
    readyTimeoutMs?: number;
    handshakeTimeoutMs?: number;
}
interface Connection {
    transport: FrameTransport;
    child?: ChildProcess;
    engine: EngineName;
    pending: Map<number, PendingInvoke>;
    replies: Map<number, (frame: Frame) => void>;
}
interface PendingInvoke {
    request: InvocationRequest;
    code: () => Promise<string>;
    host: HostCall;
    resolve(result: InvocationResult): void;
}
export declare class RuntimeClient implements AppRuntime {
    private readonly options;
    private connection;
    private connecting;
    private engineName;
    private installations;
    private nextId;
    private disposed;
    private failures;
    constructor(options: RuntimeClientOptions);
    get engine(): EngineName;
    /** The forked child's pid (fork transport only). */
    get pid(): number | undefined;
    /** Connects (or reconnects) and resolves once the runtime said hello. */
    ready(): Promise<Connection>;
    private open;
    private handshake;
    private handle;
    private lost;
    invoke(request: InvocationRequest, code: () => Promise<string>, host: HostCall): Promise<InvocationResult>;
    private request;
    unload(installationId: string): Promise<void>;
    /** Engine, pid, execArgv, env keys (never values) and `typeof gc` of the runtime process. */
    introspect(): Promise<RuntimeIntrospection>;
    ping(): Promise<void>;
    stats(): RuntimeStats;
    dispose(): Promise<void>;
}
export interface ForkRuntimeOptions {
    /** Runtime entry; default {@link RUNTIME_ENTRY} (`dist/main.js`). */
    entry?: string;
    engine?: EngineChoice;
    /** Process-level heap cap of the child (`--max-old-space-size`). Default 1024. */
    maxOldSpaceMb?: number;
    /** Flags to inherit (default `process.execArgv`); filtered by {@link buildExecArgv}. */
    execArgv?: string[];
    /** Parent environment to scrub (default `process.env`). */
    parentEnv?: NodeJS.ProcessEnv;
    /** Extra `OLAN_APP_RUNTIME_*` variables for the child; other keys are ignored. */
    env?: Record<string, string>;
    onWarning?: (message: string) => void;
    onRestart?: (reason: string) => void;
}
/** Forks the app-runtime child and resolves once it said hello. */
export declare function forkRuntime(options?: ForkRuntimeOptions): Promise<RuntimeClient>;
export interface ConnectRuntimeOptions {
    /** `tcp://host:port` (`OLAN_APP_RUNTIME_URL`). */
    url: string;
    /** `OLAN_APP_RUNTIME_TOKEN`. */
    token: string;
    onWarning?: (message: string) => void;
    onRestart?: (reason: string) => void;
}
/** Connects to a separate app-runtime container (`listenRuntime`). */
export declare function connectRuntime(options: ConnectRuntimeOptions): Promise<RuntimeClient>;
export {};
