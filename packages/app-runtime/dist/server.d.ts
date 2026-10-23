import { type Server } from 'node:net';
import { type FrameTransport } from './protocol.js';
import type { AppRuntime, EngineChoice } from './types.js';
export interface ServeRuntimeOptions {
    transport: FrameTransport;
    runtime: AppRuntime;
    /** When set the peer must open with `hello{token}` (TCP); otherwise hello is sent at once (fork). */
    token?: string;
    /** Sent as `warning` frames before the hello (e.g. the QuickJS fallback notice). */
    warnings?: string[];
}
export interface RuntimeSession {
    readonly closed: Promise<string>;
    /** Sends a `warning` frame to the main service. */
    warn(message: string): void;
    close(): void;
}
export declare function serveRuntime({ transport, runtime, token, warnings }: ServeRuntimeOptions): RuntimeSession;
export interface ListenRuntimeOptions {
    port: number;
    /** Default `127.0.0.1`; use `0.0.0.0` inside a dedicated container. */
    host?: string;
    /** Shared secret (`OLAN_APP_RUNTIME_TOKEN`), at least 16 characters. */
    token: string;
    engine?: EngineChoice;
    runtime?: AppRuntime;
    onWarning?: (message: string) => void;
}
export interface RuntimeListener {
    readonly port: number;
    readonly runtime: AppRuntime;
    readonly server: Server;
    close(): Promise<void>;
}
/** Separate-container mode: serves the protocol on TCP; every connection must present the token. */
export declare function listenRuntime(options: ListenRuntimeOptions): Promise<RuntimeListener>;
