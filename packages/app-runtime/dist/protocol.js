export const PROTOCOL_VERSION = 1;
/** Largest accepted frame (bundles travel in `code` frames). */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const NEEDS_ID = new Set(['ping', 'pong', 'invoke', 'need_code', 'code', 'host', 'result', 'unload', 'ack', 'introspect', 'introspection']);
const TYPES = new Set([...NEEDS_ID, 'hello', 'warning', 'error', 'host_result']);
export class ProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProtocolError';
    }
}
export function encodeFrame(frame) {
    return JSON.stringify(frame);
}
export function decodeFrame(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new ProtocolError('frame is not JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ProtocolError('frame is not an object');
    const frame = value;
    if (typeof frame.type !== 'string' || !TYPES.has(frame.type))
        throw new ProtocolError(`unknown frame type ${String(frame.type)}`);
    if (NEEDS_ID.has(frame.type) && typeof frame.id !== 'number')
        throw new ProtocolError(`${frame.type} frame without id`);
    if ((frame.type === 'host' || frame.type === 'host_result') && typeof frame.callId !== 'number')
        throw new ProtocolError(`${frame.type} frame without callId`);
    return value;
}
class Listeners {
    frame = [];
    close = [];
    closed = false;
    emitFrame(frame) {
        for (const listener of this.frame)
            listener(frame);
    }
    emitClose(reason) {
        if (this.closed)
            return;
        this.closed = true;
        for (const listener of this.close)
            listener(reason);
    }
}
/** Newline-delimited JSON over a byte stream (TCP). */
export function streamTransport(stream) {
    const listeners = new Listeners();
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim()) {
                try {
                    listeners.emitFrame(decodeFrame(line));
                }
                catch (error) {
                    listeners.emitClose(`protocol error: ${error.message}`);
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
            if (!listeners.closed && stream.writable)
                stream.write(`${encodeFrame(frame)}\n`);
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
/** One frame (an encoded line) per IPC message: the child's `process` or a forked `ChildProcess`. */
export function ipcTransport(endpoint) {
    const listeners = new Listeners();
    endpoint.on('message', (message) => {
        if (typeof message !== 'string')
            return;
        try {
            listeners.emitFrame(decodeFrame(message));
        }
        catch (error) {
            listeners.emitClose(`protocol error: ${error.message}`);
        }
    });
    endpoint.on('disconnect', () => listeners.emitClose('ipc channel closed'));
    return {
        send(frame) {
            if (listeners.closed || endpoint.connected === false || !endpoint.send)
                return;
            try {
                endpoint.send(encodeFrame(frame));
            }
            catch {
                listeners.emitClose('ipc channel closed');
            }
        },
        onFrame(listener) { listeners.frame.push(listener); },
        onClose(listener) { listeners.close.push(listener); },
        close() {
            try {
                endpoint.disconnect?.();
            }
            catch { /* already closed */ }
            listeners.emitClose('closed');
        },
    };
}
