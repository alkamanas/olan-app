/**
 * app-runtime process protocol (§15.2 "Süreç protokolü"): one JSON frame per line.
 *
 *   main → runtime   invoke{id, request}        runtime → main   need_code{id, digest}
 *   main → runtime   code{id, source | error}   runtime → main   host{id, callId, method, args}
 *   main → runtime   host_result{callId, ok, value | error}
 *   runtime → main   result{id, result, installations}
 *
 * plus hello (handshake; carries the token over TCP and the engine back), warning, ping/pong,
 * unload/ack and introspect/introspection (env keys, execArgv, `typeof gc`; never env values).
 */
import type { Duplex } from 'node:stream';
import type { EngineName, InvocationRequest, InvocationResult } from './types.js';
export declare const PROTOCOL_VERSION = 1;
/** Largest accepted frame (bundles travel in `code` frames). */
export declare const MAX_FRAME_BYTES: number;
export interface RuntimeIntrospection {
    pid: number;
    node: string;
    engine: EngineName;
    execArgv: string[];
    envKeys: string[];
    gc: string;
}
export type Frame = {
    type: 'hello';
    protocol: number;
    engine?: EngineName;
    token?: string;
    pid?: number;
} | {
    type: 'warning';
    message: string;
} | {
    type: 'error';
    message: string;
} | {
    type: 'ping';
    id: number;
} | {
    type: 'pong';
    id: number;
} | {
    type: 'invoke';
    id: number;
    request: InvocationRequest;
} | {
    type: 'need_code';
    id: number;
    digest: string;
} | {
    type: 'code';
    id: number;
    source?: string;
    error?: string;
} | {
    type: 'host';
    id: number;
    callId: number;
    method: string;
    args: string;
} | {
    type: 'host_result';
    callId: number;
    ok: true;
    value: string;
} | {
    type: 'host_result';
    callId: number;
    ok: false;
    error: {
        code: string;
        message: string;
    };
} | {
    type: 'result';
    id: number;
    result: InvocationResult;
    installations: number;
} | {
    type: 'unload';
    id: number;
    installationId: string;
} | {
    type: 'ack';
    id: number;
    installations: number;
} | {
    type: 'introspect';
    id: number;
} | {
    type: 'introspection';
    id: number;
    info: RuntimeIntrospection;
};
export type FrameType = Frame['type'];
export declare class ProtocolError extends Error {
    constructor(message: string);
}
export declare function encodeFrame(frame: Frame): string;
export declare function decodeFrame(line: string): Frame;
/** A bidirectional frame channel (child IPC or a TCP socket). */
export interface FrameTransport {
    send(frame: Frame): void;
    onFrame(listener: (frame: Frame) => void): void;
    onClose(listener: (reason: string) => void): void;
    close(): void;
}
/** Newline-delimited JSON over a byte stream (TCP). */
export declare function streamTransport(stream: Duplex): FrameTransport;
interface IpcEndpoint {
    send?: (message: string) => boolean;
    on(event: 'message', listener: (message: unknown) => void): unknown;
    on(event: 'disconnect', listener: () => void): unknown;
    disconnect?: () => void;
    connected?: boolean;
}
/** One frame (an encoded line) per IPC message: the child's `process` or a forked `ChildProcess`. */
export declare function ipcTransport(endpoint: IpcEndpoint): FrameTransport;
export {};
