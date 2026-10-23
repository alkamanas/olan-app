/**
 * Main-service side: {@link RuntimeClient} implements {@link AppRuntime} over a frame transport
 * to a separate app-runtime process. `forkRuntime` starts the child (`dist/main.js`) with a
 * scrubbed environment and safe V8 flags; `connectRuntime` talks to a separate container over
 * TCP with a shared token. The client restarts/reconnects when the runtime goes away; invocations
 * in flight at that moment resolve with `runtime_unavailable`.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { connect as connectTcp } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcTransport, PROTOCOL_VERSION, streamTransport, type Frame, type FrameTransport, type RuntimeIntrospection } from './protocol.js';
import type { AppRuntime, EngineChoice, EngineName, HostCall, InvocationRequest, InvocationResult, RuntimeStats } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The runtime process entry (`dist/main.js`), also when this module runs from `src/` in tests. */
export const RUNTIME_ENTRY = basename(here) === 'src' ? join(here, '..', 'dist', 'main.js') : join(here, 'main.js');

const ENV_ALLOWED = new Set(['PATH', 'NODE_ENV', 'TZ', 'SYSTEMROOT']);
const ENV_PREFIX = 'OLAN_APP_RUNTIME_';
/** Only meaningful to the main service or the TCP listener; never handed to a forked child. */
const ENV_PARENT_ONLY = new Set(['OLAN_APP_RUNTIME_TOKEN', 'OLAN_APP_RUNTIME_URL']);

/**
 * Child environment: only PATH, NODE_ENV, TZ, SystemRoot (Windows) and OLAN_APP_RUNTIME_*.
 * Database URLs, secrets and NODE_OPTIONS never reach the runtime process.
 */
export function buildChildEnv(parent: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (ENV_ALLOWED.has(upper) || (upper.startsWith(ENV_PREFIX) && !ENV_PARENT_ONLY.has(upper))) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key.toUpperCase().startsWith(ENV_PREFIX)) env[key] = value;
  }
  return env;
}

/** V8/Node flags that change what code inside isolates can reach, or that cannot be shared. */
const UNSAFE_FLAG = /^--(?:expose[-_]|allow[-_]natives[-_]syntax|js[-_]flags|v8[-_]options|inspect|debug|max[-_]old[-_]space[-_]size|no[-_]node[-_]snapshot|experimental[-_]vm[-_]modules)/;
/** Flags that replace the child's entry (a parent started with `node -e …` would re-run itself). */
const ENTRY_FLAG = /^(?:-e|-p|-pe|--eval|--print|--input[-_]type|--test|--test[-_].*|--watch|--watch[-_].*)(?:=|$)/;
/** Flags whose value may follow as a separate argument. */
const VALUE_FLAG = /^(?:-e|-p|-pe|--eval|--print|--input[-_]type|--js[-_]flags|--v8[-_]options|--max[-_]old[-_]space[-_]size|--watch[-_]path|--test[-_](?:name[-_]pattern|skip[-_]pattern|reporter|reporter[-_]destination|concurrency|timeout|shard))$/;

/**
 * `--no-node-snapshot --max-old-space-size=N` plus the inherited flags that are safe to keep.
 * `--expose-gc` (which would leak `gc` into every isolate), other `--expose-*`,
 * `--allow-natives-syntax`, `--js-flags`, inspector flags, and flags that change the entry
 * (`-e`/`--eval`, `-p`/`--print`, `--input-type`, `--test*`, `--watch*`) are always removed.
 */
export function buildExecArgv(options: { maxOldSpaceMb?: number; inherited?: string[] } = {}): string[] {
  const inherited = options.inherited ?? process.execArgv;
  const kept: string[] = [];
  for (let i = 0; i < inherited.length; i++) {
    const arg = inherited[i]!;
    if (/expose[-_]gc/.test(arg) || UNSAFE_FLAG.test(arg) || ENTRY_FLAG.test(arg)) {
      // `--js-flags --expose-gc` / `-e <script>` style: drop the separate value too.
      if (VALUE_FLAG.test(arg) && i + 1 < inherited.length) {
        const next = inherited[i + 1]!;
        if (/^-(?:e|p|pe)$|^--(?:eval|print)$/.test(arg) || !next.startsWith('-')) i++;
      }
      continue;
    }
    kept.push(arg);
  }
  return ['--no-node-snapshot', `--max-old-space-size=${options.maxOldSpaceMb ?? 1024}`, ...kept];
}

export interface RuntimeClientOptions {
  /** Opens a new transport (spawns the child or connects the socket). */
  connect: () => Promise<{ transport: FrameTransport; child?: ChildProcess }>;
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

const unavailable = (message: string): InvocationResult => ({
  ok: false, error: { code: 'runtime_unavailable', message }, logs: [], cpuMs: 0, wallMs: 0,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RuntimeClient implements AppRuntime {
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private engineName: EngineName | null = null;
  private installations = 0;
  private nextId = 0;
  private disposed = false;
  private failures = 0;

  constructor(private readonly options: RuntimeClientOptions) {}

  get engine(): EngineName {
    if (!this.engineName) throw new Error('RuntimeClient: not connected yet (use forkRuntime/connectRuntime)');
    return this.engineName;
  }

  /** The forked child's pid (fork transport only). */
  get pid(): number | undefined {
    return this.connection?.child?.pid;
  }

  /** Connects (or reconnects) and resolves once the runtime said hello. */
  ready(): Promise<Connection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.disposed) return Promise.reject(new Error('the runtime client was disposed'));
    this.connecting ??= this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open(): Promise<Connection> {
    for (;;) {
      if (this.disposed) throw new Error('the runtime client was disposed');
      try {
        const connection = await this.handshake();
        this.failures = 0;
        this.connection = connection;
        return connection;
      } catch (error) {
        this.failures++;
        this.options.onWarning?.(`app runtime start failed (attempt ${this.failures}): ${(error as Error).message}`);
        if (this.failures >= 3 && this.engineName === null) throw error;
        await sleep(Math.min(5000, 100 * 2 ** Math.min(this.failures, 6)));
      }
    }
  }

  private async handshake(): Promise<Connection> {
    const { transport, child } = await this.options.connect();
    return new Promise<Connection>((resolve, reject) => {
      let connection: Connection | null = null;
      const timer = setTimeout(() => {
        reject(new Error('the app runtime did not answer the handshake'));
        transport.close();
        child?.kill();
      }, this.options.handshakeTimeoutMs ?? 15_000);
      transport.onFrame((frame) => {
        if (!connection) {
          if (frame.type === 'warning') this.options.onWarning?.(frame.message);
          else if (frame.type === 'hello' && frame.engine) {
            clearTimeout(timer);
            connection = { transport, child, engine: frame.engine, pending: new Map(), replies: new Map() };
            this.engineName = frame.engine;
            resolve(connection);
          } else if (frame.type === 'error') {
            clearTimeout(timer);
            reject(new Error(`app runtime refused the connection: ${frame.message}`));
            transport.close();
          }
          return;
        }
        this.handle(connection, frame);
      });
      transport.onClose((reason) => {
        clearTimeout(timer);
        if (!connection) {
          reject(new Error(`app runtime closed during the handshake: ${reason}`));
          return;
        }
        this.lost(connection, reason);
      });
      if (this.options.token !== undefined) transport.send({ type: 'hello', protocol: PROTOCOL_VERSION, token: this.options.token });
    });
  }

  private handle(connection: Connection, frame: Frame) {
    switch (frame.type) {
      case 'warning':
        this.options.onWarning?.(frame.message);
        break;
      case 'need_code': {
        const pending = connection.pending.get(frame.id);
        if (!pending) break;
        Promise.resolve().then(pending.code).then(
          (source) => connection.transport.send({ type: 'code', id: frame.id, source }),
          (error: unknown) => connection.transport.send({ type: 'code', id: frame.id, error: error instanceof Error ? error.message : String(error) }),
        );
        break;
      }
      case 'host': {
        const pending = connection.pending.get(frame.id);
        if (!pending) {
          connection.transport.send({ type: 'host_result', callId: frame.callId, ok: false, error: { code: 'runtime_unavailable', message: 'unknown invocation' } });
          break;
        }
        Promise.resolve().then(() => pending.host(pending.request.installationId, frame.method, frame.args)).then(
          (value) => connection.transport.send({ type: 'host_result', callId: frame.callId, ok: true, value: String(value) }),
          (error: unknown) => {
            const record = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown };
            connection.transport.send({
              type: 'host_result', callId: frame.callId, ok: false,
              error: { code: typeof record.code === 'string' ? record.code : 'host_error', message: typeof record.message === 'string' ? record.message : String(error) },
            });
          },
        );
        break;
      }
      case 'result': {
        const pending = connection.pending.get(frame.id);
        connection.pending.delete(frame.id);
        this.installations = frame.installations;
        pending?.resolve(frame.result);
        break;
      }
      case 'ack':
      case 'pong':
      case 'introspection': {
        if (frame.type === 'ack') this.installations = frame.installations;
        const reply = connection.replies.get(frame.id);
        connection.replies.delete(frame.id);
        reply?.(frame);
        break;
      }
      default:
        break;
    }
  }

  private lost(connection: Connection, reason: string) {
    if (this.connection === connection) this.connection = null;
    for (const pending of connection.pending.values()) pending.resolve(unavailable(`the app runtime went away: ${reason}`));
    connection.pending.clear();
    connection.replies.clear();
    this.installations = 0;
    if (connection.child && connection.child.exitCode === null) connection.child.kill();
    if (this.disposed) return;
    this.options.onRestart?.(reason);
    // Restart eagerly so the next invocation does not pay the start-up.
    setTimeout(() => { if (!this.disposed && !this.connection) this.ready().catch(() => undefined); }, 50).unref();
  }

  async invoke(request: InvocationRequest, code: () => Promise<string>, host: HostCall): Promise<InvocationResult> {
    let connection: Connection;
    try {
      const timeout = this.options.readyTimeoutMs ?? 10_000;
      // Fast path: no timer at all when already connected. Otherwise the timer is cleared as soon
      // as the race settles, so an idle client never keeps the parent process alive.
      if (this.connection) connection = this.connection;
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          connection = await Promise.race([
            this.ready(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`the app runtime is not ready after ${timeout} ms`)), timeout);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      return unavailable((error as Error).message);
    }
    const id = ++this.nextId;
    return new Promise<InvocationResult>((resolve) => {
      connection.pending.set(id, { request, code, host, resolve });
      connection.transport.send({ type: 'invoke', id, request });
    });
  }

  private async request<T extends Frame>(build: (id: number) => Frame): Promise<T> {
    const connection = await this.ready();
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.replies.delete(id);
        reject(new Error('the app runtime did not answer'));
      }, 10_000);
      connection.replies.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame as T);
      });
      connection.transport.send(build(id));
    });
  }

  async unload(installationId: string): Promise<void> {
    if (!this.connection) return;
    await this.request((id) => ({ type: 'unload', id, installationId }));
  }

  /** Engine, pid, execArgv, env keys (never values) and `typeof gc` of the runtime process. */
  async introspect(): Promise<RuntimeIntrospection> {
    const frame = await this.request<Extract<Frame, { type: 'introspection' }>>((id) => ({ type: 'introspect', id }));
    return frame.info;
  }

  async ping(): Promise<void> {
    await this.request((id) => ({ type: 'ping', id }));
  }

  stats(): RuntimeStats {
    return { installations: this.installations, engine: this.engine };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    for (const pending of connection.pending.values()) pending.resolve(unavailable('the runtime client was disposed'));
    connection.pending.clear();
    const child = connection.child;
    const exited = child && child.exitCode === null
      ? new Promise<void>((resolve) => child.once('exit', () => resolve()))
      : Promise.resolve();
    connection.transport.close();
    child?.kill();
    await exited;
  }
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
export async function forkRuntime(options: ForkRuntimeOptions = {}): Promise<RuntimeClient> {
  const client = new RuntimeClient({
    onWarning: options.onWarning,
    onRestart: options.onRestart,
    connect: async () => {
      const extra: Record<string, string> = { ...options.env };
      if (options.engine) extra.OLAN_APP_RUNTIME_ENGINE = options.engine;
      const child = fork(options.entry ?? RUNTIME_ENTRY, [], {
        execArgv: buildExecArgv({ maxOldSpaceMb: options.maxOldSpaceMb, inherited: options.execArgv }),
        env: buildChildEnv(options.parentEnv ?? process.env, extra),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'json',
      });
      const transport = ipcTransport(child);
      child.once('exit', () => transport.close());
      child.once('error', () => transport.close());
      return { transport, child };
    },
  });
  await client.ready();
  return client;
}

export interface ConnectRuntimeOptions {
  /** `tcp://host:port` (`OLAN_APP_RUNTIME_URL`). */
  url: string;
  /** `OLAN_APP_RUNTIME_TOKEN`. */
  token: string;
  onWarning?: (message: string) => void;
  onRestart?: (reason: string) => void;
}

/** Connects to a separate app-runtime container (`listenRuntime`). */
export async function connectRuntime(options: ConnectRuntimeOptions): Promise<RuntimeClient> {
  const url = new URL(options.url);
  if (url.protocol !== 'tcp:' || !url.port) throw new Error(`connectRuntime: expected tcp://host:port, got ${options.url}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  const client = new RuntimeClient({
    token: options.token,
    onWarning: options.onWarning,
    onRestart: options.onRestart,
    connect: () => new Promise((resolve, reject) => {
      const socket = connectTcp({ host, port });
      socket.once('connect', () => {
        socket.off('error', reject);
        socket.setNoDelay(true);
        resolve({ transport: streamTransport(socket) });
      });
      socket.once('error', reject);
    }),
  });
  await client.ready();
  return client;
}
