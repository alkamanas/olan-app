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

export const PROTOCOL_VERSION = 1;
/** Largest accepted frame (bundles travel in `code` frames). */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface RuntimeIntrospection {
  pid: number;
  node: string;
  engine: EngineName;
  execArgv: string[];
  envKeys: string[];
  gc: string;
}

export type Frame =
  | { type: 'hello'; protocol: number; engine?: EngineName; token?: string; pid?: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'ping'; id: number }
  | { type: 'pong'; id: number }
  | { type: 'invoke'; id: number; request: InvocationRequest }
  | { type: 'need_code'; id: number; digest: string }
  | { type: 'code'; id: number; source?: string; error?: string }
  | { type: 'host'; id: number; callId: number; method: string; args: string }
  | { type: 'host_result'; callId: number; ok: true; value: string }
  | { type: 'host_result'; callId: number; ok: false; error: { code: string; message: string } }
  | { type: 'result'; id: number; result: InvocationResult; installations: number }
  | { type: 'unload'; id: number; installationId: string }
  | { type: 'ack'; id: number; installations: number }
  | { type: 'introspect'; id: number }
  | { type: 'introspection'; id: number; info: RuntimeIntrospection };

export type FrameType = Frame['type'];

const NEEDS_ID = new Set<FrameType>(['ping', 'pong', 'invoke', 'need_code', 'code', 'host', 'result', 'unload', 'ack', 'introspect', 'introspection']);
const TYPES = new Set<FrameType>([...NEEDS_ID, 'hello', 'warning', 'error', 'host_result']);

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(line: string): Frame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError('frame is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProtocolError('frame is not an object');
  const frame = value as { type?: unknown; id?: unknown; callId?: unknown };
  if (typeof frame.type !== 'string' || !TYPES.has(frame.type as FrameType)) throw new ProtocolError(`unknown frame type ${String(frame.type)}`);
  if (NEEDS_ID.has(frame.type as FrameType) && typeof frame.id !== 'number') throw new ProtocolError(`${frame.type} frame without id`);
  if ((frame.type === 'host' || frame.type === 'host_result') && typeof frame.callId !== 'number') throw new ProtocolError(`${frame.type} frame without callId`);
  return value as Frame;
}

/** A bidirectional frame channel (child IPC or a TCP socket). */
export interface FrameTransport {
  send(frame: Frame): void;
  onFrame(listener: (frame: Frame) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

class Listeners {
  readonly frame: ((frame: Frame) => void)[] = [];
  readonly close: ((reason: string) => void)[] = [];
  closed = false;

  emitFrame(frame: Frame) {
    for (const listener of this.frame) listener(frame);
  }

  emitClose(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.close) listener(reason);
  }
}

/** Newline-delimited JSON over a byte stream (TCP). */
export function streamTransport(stream: Duplex): FrameTransport {
  const listeners = new Listeners();
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          listeners.emitFrame(decodeFrame(line));
        } catch (error) {
          listeners.emitClose(`protocol error: ${(error as Error).message}`);
          stream.destroy();
          return;
        }
      }
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      listeners.emitClose('frame too large');
      stream.destroy();
    }
  });
  stream.on('close', () => listeners.emitClose('connection closed'));
  stream.on('error', (error) => listeners.emitClose(`connection error: ${error.message}`));
  return {
    send(frame) {
      if (!listeners.closed && stream.writable) stream.write(`${encodeFrame(frame)}\n`);
    },
    onFrame(listener) { listeners.frame.push(listener); },
    onClose(listener) { listeners.close.push(listener); },
    close() {
      stream.end();
      stream.destroy();
      listeners.emitClose('closed');
    },
  };
}

interface IpcEndpoint {
  send?: (message: string) => boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  disconnect?: () => void;
  connected?: boolean;
}

/** One frame (an encoded line) per IPC message: the child's `process` or a forked `ChildProcess`. */
export function ipcTransport(endpoint: IpcEndpoint): FrameTransport {
  const listeners = new Listeners();
  endpoint.on('message', (message) => {
    if (typeof message !== 'string') return;
    try {
      listeners.emitFrame(decodeFrame(message));
    } catch (error) {
      listeners.emitClose(`protocol error: ${(error as Error).message}`);
    }
  });
  endpoint.on('disconnect', () => listeners.emitClose('ipc channel closed'));
  return {
    send(frame) {
      if (listeners.closed || endpoint.connected === false || !endpoint.send) return;
      try {
        endpoint.send(encodeFrame(frame));
      } catch {
        listeners.emitClose('ipc channel closed');
      }
    },
    onFrame(listener) { listeners.frame.push(listener); },
    onClose(listener) { listeners.close.push(listener); },
    close() {
      try { endpoint.disconnect?.(); } catch { /* already closed */ }
      listeners.emitClose('closed');
    },
  };
}
