/**
 * Runtime side of the process protocol: answers frames from the main service with an
 * in-process {@link AppRuntime}. Used by the forked child (`dist/main.js`) and by the separate
 * container mode (`listenRuntime`, TCP + shared token).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { PROTOCOL_VERSION, streamTransport, type Frame, type FrameTransport, type RuntimeIntrospection } from './protocol.js';
import { createRuntime } from './runtime.js';
import type { AppRuntime, EngineChoice, InvocationRequest, InvocationResult } from './types.js';

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

function tokensMatch(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(actual).digest();
  return timingSafeEqual(a, b);
}

function positive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Rejects malformed requests from the wire before they reach the engine. */
function requestProblem(request: InvocationRequest | undefined): string | null {
  if (!request || typeof request !== 'object') return 'missing request';
  if (typeof request.installationId !== 'string' || !request.installationId) return 'installationId must be a non-empty string';
  if (typeof request.digest !== 'string' || !request.digest) return 'digest must be a non-empty string';
  if (!['function', 'schedule', 'event', 'hook', 'migrate'].includes(request.kind)) return 'unknown invocation kind';
  if (typeof request.name !== 'string') return 'name must be a string';
  if (request.fallback !== undefined && typeof request.fallback !== 'string') return 'fallback must be a string';
  if (!request.context || typeof request.context.appId !== 'string' || typeof request.context.identity !== 'object' || request.context.identity === null) return 'invalid context';
  const limits = request.limits;
  if (!limits || !positive(limits.cpuMs) || !positive(limits.wallMs) || !positive(limits.memoryMb) || !positive(limits.concurrency)) return 'invalid limits';
  return null;
}

function introspection(runtime: AppRuntime): RuntimeIntrospection {
  return {
    pid: process.pid,
    node: process.version,
    engine: runtime.engine,
    execArgv: [...process.execArgv],
    envKeys: Object.keys(process.env).sort(),
    gc: typeof (globalThis as { gc?: unknown }).gc,
  };
}

export function serveRuntime({ transport, runtime, token, warnings = [] }: ServeRuntimeOptions): RuntimeSession {
  const codeWaiters = new Map<number, { resolve(source: string): void; reject(error: Error): void }>();
  const hostWaiters = new Map<number, { resolve(value: string): void; reject(error: { code: string; message: string }): void }>();
  let nextCallId = 0;
  let open = token === undefined;
  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((resolve) => { resolveClosed = resolve; });

  const hello = () => {
    for (const message of warnings) transport.send({ type: 'warning', message });
    transport.send({ type: 'hello', protocol: PROTOCOL_VERSION, engine: runtime.engine, pid: process.pid });
  };

  const invoke = (id: number, request: InvocationRequest) => {
    const problem = requestProblem(request);
    const run: Promise<InvocationResult> = problem
      ? Promise.resolve({ ok: false, error: { code: 'runtime_unavailable', message: `invalid request: ${problem}` }, logs: [], cpuMs: 0, wallMs: 0 })
      : runtime.invoke(
        request,
        () => new Promise<string>((resolve, reject) => {
          codeWaiters.set(id, { resolve, reject });
          transport.send({ type: 'need_code', id, digest: request.digest });
        }),
        (_installationId, method, args) => new Promise<string>((resolve, reject) => {
          const callId = ++nextCallId;
          hostWaiters.set(callId, { resolve, reject });
          transport.send({ type: 'host', id, callId, method, args });
        }),
      );
    run.then((result) => transport.send({ type: 'result', id, result, installations: runtime.stats().installations }));
  };

  const handle = (frame: Frame) => {
    if (!open) {
      if (frame.type === 'hello' && token !== undefined && tokensMatch(token, frame.token)) {
        open = true;
        hello();
      } else {
        transport.send({ type: 'error', message: 'handshake failed' });
        transport.close();
      }
      return;
    }
    switch (frame.type) {
      case 'invoke':
        invoke(frame.id, frame.request);
        break;
      case 'code': {
        const waiter = codeWaiters.get(frame.id);
        codeWaiters.delete(frame.id);
        if (!waiter) break;
        if (typeof frame.source === 'string') waiter.resolve(frame.source);
        else waiter.reject(new Error(frame.error ?? 'no code'));
        break;
      }
      case 'host_result': {
        const waiter = hostWaiters.get(frame.callId);
        hostWaiters.delete(frame.callId);
        if (!waiter) break;
        if (frame.ok) waiter.resolve(String(frame.value));
        else waiter.reject({ code: String(frame.error?.code ?? 'host_error'), message: String(frame.error?.message ?? '') });
        break;
      }
      case 'unload':
        runtime.unload(frame.installationId).then(() => transport.send({ type: 'ack', id: frame.id, installations: runtime.stats().installations }));
        break;
      case 'ping':
        transport.send({ type: 'pong', id: frame.id });
        break;
      case 'introspect':
        transport.send({ type: 'introspection', id: frame.id, info: introspection(runtime) });
        break;
      default:
        break;
    }
  };

  transport.onFrame(handle);
  transport.onClose((reason) => {
    for (const waiter of codeWaiters.values()) waiter.reject(new Error(`connection closed: ${reason}`));
    for (const waiter of hostWaiters.values()) waiter.reject({ code: 'runtime_unavailable', message: `connection closed: ${reason}` });
    codeWaiters.clear();
    hostWaiters.clear();
    resolveClosed(reason);
  });
  if (open) hello();

  return {
    closed,
    warn(message) { transport.send({ type: 'warning', message }); },
    close() { transport.close(); },
  };
}

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
export async function listenRuntime(options: ListenRuntimeOptions): Promise<RuntimeListener> {
  if (typeof options.token !== 'string' || options.token.length < 16) throw new Error('listenRuntime: token must be at least 16 characters');
  const warnings: string[] = [];
  const runtime = options.runtime ?? await createRuntime({
    engine: options.engine ?? 'auto',
    onWarning: (message) => { warnings.push(message); options.onWarning?.(message); },
  });
  const sessions = new Set<RuntimeSession>();
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    const session = serveRuntime({ transport: streamTransport(socket), runtime, token: options.token, warnings });
    sessions.add(session);
    session.closed.then(() => sessions.delete(session));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    runtime,
    server,
    async close() {
      for (const session of sessions) session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!options.runtime) await runtime.dispose();
    },
  };
}
