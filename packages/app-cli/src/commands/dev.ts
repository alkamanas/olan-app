import { spawn } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { context as esbuildContext, type BuildContext, type Plugin } from 'esbuild';
import { WebSocketServer, type WebSocket } from 'ws';
import { BACKEND_LIMITS, LOG_LEVELS, MANIFEST_FILE, defaultSettings, isSemver, jsonByteSize, requestedPermissions, type LogLevel } from '@olan-app/schema';
import type { JsonValue } from '@olan-app/sdk/protocol';

import { booleanFlag, integerFlag, stringFlag } from '../args';
import { buildBackend } from '../backend/build';
import { startDevBackend, type DevBackend, type DevBackendEvent, type DevBackendStatus } from '../backend/dev';
import { secretSettingKeys } from '../backend/harness';
import { backendEngineFlag, type BackendEngine } from '../backend/runner';
import { appBuildOptions, esbuildIssues } from '../bundle';
import type { Command } from '../command';
import { CliError, issue, type Issue } from '../errors';
import { createMockHost, defaultFixtures, DEFAULT_USER_ID, loadProjectFixtures, mergeFixtures, normalizeFixtures, type MockHost } from '../mock-server';
import { loadManifest, requireProjectDir } from '../project';
import { DEV_ISSUER_PORT, liveRemoteTransport, startDevIssuer, type DevIssuer } from '../remote-dev';
import { buildIdOf } from './build';
import { packDevBuild } from './pack';

export const DEFAULT_DEV_PORT = 5178;
export const DEFAULT_STUDIO_SERVER = 'http://localhost:3000';
export const DEFAULT_DEV_HOST = '127.0.0.1';
/** `POST /logs` limits (Phase 2 server contract §5, the same as the Studio pairing relay). */
export const MAX_LOG_ENTRIES = 100;
export const MAX_LOG_ENTRY_BYTES = 8 * 1024;

/** One app log line a host (the phone in direct mode) forwards to `POST /logs`. */
export interface DevLogEntry {
  level: LogLevel;
  args: JsonValue[];
  /** When the app logged it (ISO), as the host reports it. */
  at: string | null;
}

export type DevServerEvent =
  | { type: 'rebuilt'; buildId: string; durationMs: number }
  | { type: 'error'; errors: Issue[] }
  | { type: 'manifest' }
  | ({ type: 'log' } & DevLogEntry)
  /** `--remote live`: one forwarded `olan.remote.request` (`GET /items → 200 (12 ms)`). */
  | { type: 'remote'; message: string }
  | DevBackendEvent;

export interface DevServerStatus {
  appId: string | null;
  version: string | null;
  buildId: string | null;
  errors: Issue[];
  builtAt: string | null;
  /** The mock host's signed-in user: hosts running the app against `/rpc` send it as `context.user`. */
  user: { id: string };
  /** Manifest `server`: the local backend (engine, bundle hash, build errors, schedules, hooks), else null. */
  backend: DevBackendStatus | null;
}

export interface DevServer {
  /** `http://localhost:<port>`, or `http://<host>:<port>` when bound to one non-loopback address. */
  url: string;
  port: number;
  /** Address the server listens on (`--host`). */
  host: string;
  /** `http://<address>:<port>` for each LAN IPv4 address when listening on all interfaces (`0.0.0.0`). */
  lanUrls: string[];
  status(): DevServerStatus;
  /** `remote: 'live'`: the development issuer requests are signed by (list it in the app server's `issuers`), else null. */
  remoteIssuer: string | null;
  /** Resolves after the next build finishes (tests). */
  nextBuild(): Promise<DevServerStatus>;
  close(): Promise<void>;
}

export interface DevServerOptions {
  projectDir: string;
  /** 0 picks a free port. */
  port?: number;
  /** Listen address (default `127.0.0.1`; `0.0.0.0` lets a phone on the LAN connect). */
  host?: string;
  /** Backend engine (manifest `server`): `auto` (default; QuickJS where isolated-vm has no prebuild), `isolated-vm`, `quickjs`. */
  engine?: BackendEngine;
  /**
   * Who answers `olan.remote.request` on `/rpc`: `fixtures` (default, `fixtures/remote.json`) or
   * `live`: the app's own server at `remote.url`, signed by the development issuer
   * (`http://127.0.0.1:<issuerPort>`, your development key).
   */
  remote?: 'fixtures' | 'live';
  /** Port of the development issuer for `remote: 'live'` (default 5180). */
  issuerPort?: number;
  /** For the development key (`remote: 'live'`); default `process.env`. */
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: DevServerEvent) => void;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const ALL_INTERFACES = new Set(['0.0.0.0', '::']);

/** Non-internal IPv4 addresses of this machine (private ranges first). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
  }
  const isPrivate = (address: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return [...new Set(out)].sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

/**
 * Validates a `POST /logs` body: `{ entries: [{ level, args, at? }] }`, at most
 * `MAX_LOG_ENTRIES` entries of at most `MAX_LOG_ENTRY_BYTES` (UTF-8 JSON) each.
 */
export function parseLogEntries(body: unknown): { ok: true; entries: DevLogEntry[] } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { entries?: unknown }).entries)) {
    return { ok: false, message: 'The body must be { entries: [{ level, args, at }] }' };
  }
  const entries = (body as { entries: unknown[] }).entries;
  if (entries.length > MAX_LOG_ENTRIES) return { ok: false, message: `At most ${MAX_LOG_ENTRIES} entries per request` };
  const out: DevLogEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const value = entry as { level?: unknown; args?: unknown; at?: unknown } | null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, message: `entries[${index}] must be an object` };
    if (!(LOG_LEVELS as readonly unknown[]).includes(value.level)) return { ok: false, message: `entries[${index}].level must be one of ${LOG_LEVELS.join(', ')}` };
    if (!Array.isArray(value.args)) return { ok: false, message: `entries[${index}].args must be an array` };
    if (value.at !== undefined && value.at !== null && typeof value.at !== 'string') return { ok: false, message: `entries[${index}].at must be an ISO time` };
    if (jsonByteSize(value as JsonValue) > MAX_LOG_ENTRY_BYTES) return { ok: false, message: `entries[${index}] is larger than ${MAX_LOG_ENTRY_BYTES / 1024} KiB` };
    out.push({ level: value.level as LogLevel, args: value.args as JsonValue[], at: typeof value.at === 'string' ? value.at : null });
  }
  return { ok: true, entries: out };
}

/**
 * Terminal lines for backend events: `''` to stay quiet, `null` when `event` is not a backend event.
 * Each invocation prints its result and its console lines (`[backend log] …`).
 */
export function formatBackendEvent(event: DevServerEvent): string | null {
  switch (event.type) {
    case 'backend-built':
      return `backend rebuilt ${event.sha256.slice(0, 12)}`;
    case 'backend-error':
      return `backend build failed:\n${event.errors.map((item) => `  ${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.message}`).join('\n')}`;
    case 'backend-warning':
      return `backend warning: ${event.message}`;
    case 'backend-invocation': {
      const head = `backend ${event.kind} ${event.name}: ${event.ok ? 'ok' : `${event.error?.code} ${event.error?.message ?? ''}`} (${Math.round(event.wallMs)} ms)`;
      return [head, ...event.logs.map((line) => `  [backend ${line.level}] ${line.message}`)].join('\n');
    }
    default:
      return null;
  }
}

/** One log line for the terminal. */
export function formatLogEntry(entry: DevLogEntry): string {
  const args = entry.args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
  return `[app ${entry.level}]${entry.at ? ` ${entry.at}` : ''} ${args}`;
}

function send(response: ServerResponse, status: number, body: string | Uint8Array, type: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    // Chromium's Private Network Access preflight for https pages calling localhost.
    'access-control-allow-private-network': 'true',
    ...headers,
  });
  response.end(body);
}

const sendJson = (response: ServerResponse, status: number, value: unknown) => send(response, status, JSON.stringify(value), 'application/json; charset=utf-8');

async function readBody(request: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The `olan-app dev` server (contract §7): esbuild watch mode over `src/**`, served on
 * 127.0.0.1 (or `--host`), CORS `*`.
 *
 * - `GET /manifest` → `olan-app.json` (parsed; 422 with issues when invalid)
 * - `GET /app.js` → the latest successful bundle (`startRuntime(workerTransport(), app)`)
 * - `GET /package` → that build packed and signed with the development key (`application/octet-stream`,
 *   `<id>-<version>.olanapp`; Studio's "Bu kurumda dene" uploads it); 503 while the build fails.
 *   `?version=1.2.0-dev.3` packs and signs the manifest under that version (the `nextVersion` an Olan
 *   server's `409 version_exists` names); `olan-app.json` on disk is not changed
 * - `GET /status` → `{ appId, version, buildId, errors, builtAt, user: { id } }` (`user`: the mock's signed-in user)
 * - `GET /fixtures` → the mock data (defaults + `fixtures/*.json`)
 * - `POST /rpc` `{ method, params, permissions? }` → the mock host's answer (local mock server)
 * - `POST /logs` `{ entries: [{ level, args, at }] }` (≤ 100, ≤ 8 KiB each) → 204; `onEvent({ type: 'log', … })`
 * - WebSocket `/ws` → `{ type: 'rebuilt', buildId }`, `{ type: 'error', errors }`, `{ type: 'manifest' }`
 *
 * With a manifest `server` (Phase 3 §15.4) the backend runs locally in `@olan-app/runtime` on the
 * same mock host (`/rpc` `backend.call` reaches it) and every invocation's console lines are
 * reported (`onEvent({ type: 'backend-invocation', … })`):
 * - `GET /backend` → `{ engine, sha256, errors, schedules, hooks, events }`
 * - `POST /backend/call` `{ name, args?, permissions? }` → `{ ok, value | error, logs, cpuMs, wallMs }`
 *   (`result`: alias of `value`)
 * - `POST /backend/schedules/<name>/run` → "run schedule now" (`{ ok, value | error, logs, cpuMs, wallMs }`)
 * - `POST /backend/events/<type>` `{ data? }` → delivers the event (sample data from the fixtures)
 * - `POST /hooks/<name>` (raw body ≤ 1 MiB) → the hook's verification, function and answer (202 after 10 s)
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const { projectDir } = options;
  // `--remote live`: the development issuer runs for the whole session (its JWKS must stay reachable).
  let liveIssuer: DevIssuer | null = null;
  if (options.remote === 'live') {
    const manifest = loadManifest(projectDir).manifest;
    if (!manifest?.remote) {
      throw new CliError(issue('dev.remote_missing', '--remote live needs "remote": { "url", "jwksUrl", "requests": true } in olan-app.json', { file: MANIFEST_FILE, hint: 'Add "remote" (remote-requests.md), or run dev without --remote live to answer from fixtures/remote.json.' }));
    }
    liveIssuer = await startDevIssuer({ env: options.env ?? process.env, port: options.issuerPort ?? DEV_ISSUER_PORT });
  }
  let code: Uint8Array | null = null;
  let state: DevServerStatus = { appId: null, version: null, buildId: null, errors: [], builtAt: null, user: { id: DEFAULT_USER_ID }, backend: null };
  let backend: DevBackend | null = null;
  let waiters: ((status: DevServerStatus) => void)[] = [];
  const sockets = new Set<WebSocket>();
  let mockHost: MockHost | null = null;

  const readManifestState = () => {
    const loaded = loadManifest(projectDir);
    state = { ...state, appId: loaded.manifest?.id ?? (loaded.raw as { id?: string } | null)?.id ?? null, version: loaded.manifest?.version ?? null };
    mockHost = null; // permissions or settings may have changed
    return loaded;
  };
  readManifestState();

  const broadcast = (message: unknown) => {
    const text = JSON.stringify(message);
    for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(text);
  };

  const buildOptions = appBuildOptions({ projectDir, mode: 'production', minify: false });
  let started = performance.now();
  const reporter: Plugin = {
    name: 'olan-dev-reporter',
    setup(build) {
      build.onStart(() => {
        started = performance.now();
      });
      build.onEnd((result) => {
        if (result.errors.length > 0) {
          state = { ...state, errors: esbuildIssues(projectDir, result.errors) };
          broadcast({ type: 'error', errors: state.errors });
          options.onEvent?.({ type: 'error', errors: state.errors });
        } else {
          code = result.outputFiles?.[0]?.contents ?? new Uint8Array();
          const buildId = buildIdOf(code);
          state = { ...state, buildId, errors: [], builtAt: new Date().toISOString() };
          broadcast({ type: 'rebuilt', buildId });
          options.onEvent?.({ type: 'rebuilt', buildId, durationMs: Math.round(performance.now() - started) });
        }
        const pending = waiters;
        waiters = [];
        for (const resolveWaiter of pending) resolveWaiter(state);
      });
    },
  };
  const ctx: BuildContext = await esbuildContext({ ...buildOptions, plugins: [...(buildOptions.plugins ?? []), reporter] }).catch(async (error: unknown) => {
    await liveIssuer?.close();
    throw error;
  });
  const firstBuild = new Promise<DevServerStatus>((resolveFirst) => waiters.push(resolveFirst));
  await ctx.watch();
  await firstBuild;

  const startBackend = async () => {
    if (backend || !loadManifest(projectDir).manifest?.server) return;
    backend = await startDevBackend({
      projectDir,
      engine: options.engine,
      manifest: () => loadManifest(projectDir).manifest,
      host: () => host(),
      onEvent: (event) => {
        broadcast(event.type === 'backend-invocation' ? { type: 'backend', kind: event.kind, name: event.name, ok: event.ok } : { type: event.type });
        options.onEvent?.(event);
      },
    });
  };
  try {
    await startBackend();
  } catch (error) {
    await ctx.dispose();
    throw error;
  }

  let manifestTimer: NodeJS.Timeout | null = null;
  const watchers: FSWatcher[] = [];
  const onManifestChange = () => {
    if (manifestTimer) clearTimeout(manifestTimer);
    manifestTimer = setTimeout(() => {
      readManifestState();
      broadcast({ type: 'manifest' });
      options.onEvent?.({ type: 'manifest' });
      void ctx.rebuild().catch(() => undefined);
      void (backend ? backend.rebuild() : startBackend()).catch(() => undefined);
    }, 50);
  };
  try {
    watchers.push(watch(join(projectDir, MANIFEST_FILE), onManifestChange));
  } catch {
    // The manifest may be recreated; esbuild still watches the sources.
  }

  const host = () => {
    if (mockHost) return mockHost;
    const loaded = loadManifest(projectDir);
    const fixtures = mergeFixtures(defaultFixtures(), loadProjectFixtures(projectDir));
    mockHost = createMockHost({
      fixtures: { ...fixtures, settings: { ...(loaded.manifest ? defaultSettings(loaded.manifest) : {}), ...(fixtures.settings ?? {}) } },
      // Implied permissions (`remote`, `ai:tools`) are effective permissions too, as on the host.
      permissions: loaded.manifest ? requestedPermissions(loaded.manifest) : [],
      data: loaded.manifest?.data ?? null,
      appId: loaded.manifest?.id,
      ...(loaded.manifest?.name ? { appName: loaded.manifest.name } : {}),
      remote: loaded.manifest?.remote !== undefined,
      remoteUrl: loaded.manifest?.remote?.url ?? null,
      remoteRequests: loaded.manifest?.remote?.requests === true,
      // Phase 3 §15.1: secret settings of apps with `server` reach only the backend.
      secretSettings: loaded.manifest?.server ? secretSettingKeys(loaded.manifest) : [],
      ...(liveIssuer && loaded.manifest?.remote ? { remoteTransport: liveRemoteTransport(liveIssuer, loaded.manifest.remote.url, (message) => options.onEvent?.({ type: 'remote', message })) } : {}),
      backend: (name, args, caller) => (backend ? backend.call(name, args, caller) : Promise.resolve({ ok: false, error: { code: 'backend_unavailable', message: 'The app has no backend ("server")' } })),
    });
    return mockHost;
  };

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'OPTIONS') return send(response, 204, '', 'text/plain');
    try {
      if (request.method === 'GET' && url.pathname === '/manifest') {
        const loaded = loadManifest(projectDir);
        if (!loaded.manifest) return sendJson(response, 422, { error: 'manifest_invalid', issues: loaded.issues });
        return sendJson(response, 200, loaded.manifest);
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        if (!code) return sendJson(response, 503, { error: 'build_failed', errors: state.errors });
        return send(response, 200, code, 'application/javascript; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/package') {
        // `?version=`: the `-dev.N` the Olan server named for a changed build (signed into the package; olan-app.json stays as it is).
        const version = url.searchParams.get('version') || undefined;
        if (version !== undefined && !isSemver(version)) return sendJson(response, 400, { error: 'version_invalid', message: `"${version}" is not a semver version` });
        if (!code) return sendJson(response, 503, { error: 'build_failed', errors: state.errors });
        const loaded = loadManifest(projectDir);
        if (!loaded.manifest) return sendJson(response, 422, { error: 'manifest_invalid', issues: loaded.issues });
        let server: Uint8Array | undefined;
        if (loaded.manifest.server) {
          try {
            server = Buffer.from((await buildBackend(projectDir, loaded.manifest, { write: false })).code);
          } catch (error) {
            if (error instanceof CliError) return sendJson(response, 503, { error: 'build_failed', errors: error.issues });
            throw error;
          }
        }
        const packed = packDevBuild(projectDir, loaded.manifest, { entry: code, ...(server ? { server } : {}), ...(version ? { version } : {}) }, options.env ?? process.env);
        return send(response, 200, packed.bytes, 'application/octet-stream', {
          'content-disposition': `attachment; filename="${packed.fileName}"`,
          'x-olan-package-sha256': packed.sha256,
          'x-olan-signing-key': packed.keyFingerprint,
          'access-control-expose-headers': 'content-disposition, x-olan-package-sha256, x-olan-signing-key',
        });
      }
      if (request.method === 'GET' && (url.pathname === '/status' || url.pathname === '/')) return sendJson(response, 200, { ...state, backend: backend?.status() ?? null });
      const backendRoute = /^\/(?:backend\/(call|schedules\/([^/]+)\/run|events\/([^/]+))|hooks\/([^/]+))$/.exec(url.pathname);
      if (url.pathname === '/backend' || backendRoute) {
        if (!backend) return sendJson(response, 404, { error: 'backend_unavailable', message: 'olan-app.json declares no "server"' });
        if (request.method === 'GET' && url.pathname === '/backend') return sendJson(response, 200, backend.status());
        if (request.method !== 'POST' || !backendRoute) return sendJson(response, 405, { error: 'method_not_allowed' });
        const [, action, schedule, eventType, hookName] = backendRoute;
        let raw: string;
        try {
          raw = await readBody(request, BACKEND_LIMITS.hookBodyBytes + 1);
        } catch {
          return sendJson(response, 413, { error: 'payload_too_large' });
        }
        try {
          if (hookName) {
            const answer = await backend.hook(decodeURIComponent(hookName), { method: 'POST', headers: request.headers, body: raw, query: Object.fromEntries(url.searchParams) });
            response.writeHead(answer.status, { 'access-control-allow-origin': '*', ...answer.headers });
            return response.end(answer.body);
          }
          const body = raw ? (JSON.parse(raw) as { name?: unknown; args?: JsonValue; permissions?: unknown; data?: JsonValue }) : {};
          if (action === 'call') {
            if (typeof body.name !== 'string') return sendJson(response, 400, { error: 'invalid_request', message: 'The body must be { name, args? }' });
            const mock = host();
            const permissions = Array.isArray(body.permissions) ? body.permissions.filter((item): item is string => typeof item === 'string') : mock.permissions;
            const outcome = await backend.invokeFunction(body.name, body.args ?? null, { userId: mock.userId, permissions });
            // The same shape as the schedule and event routes; `result` stays as an alias of `value`.
            return sendJson(response, 200, outcome.ok ? { ...outcome, result: outcome.value } : outcome);
          }
          const outcome = schedule ? await backend.runSchedule(decodeURIComponent(schedule)) : await backend.emit(decodeURIComponent(eventType!), body.data);
          return sendJson(response, 200, outcome);
        } catch (error) {
          return sendJson(response, 400, { error: 'invalid_request', message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (request.method === 'GET' && url.pathname === '/fixtures') {
        const fixtures = normalizeFixtures(mergeFixtures(defaultFixtures(), loadProjectFixtures(projectDir)));
        const manifest = loadManifest(projectDir).manifest;
        for (const key of manifest?.server ? secretSettingKeys(manifest) : []) if (key in fixtures.settings) fixtures.settings[key] = null;
        return sendJson(response, 200, fixtures);
      }
      if (request.method === 'POST' && url.pathname === '/logs') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(request));
        } catch {
          return sendJson(response, 400, { error: 'invalid_request', message: 'The body is not JSON' });
        }
        const parsed = parseLogEntries(body);
        if (!parsed.ok) return sendJson(response, 400, { error: 'invalid_request', message: parsed.message });
        for (const entry of parsed.entries) options.onEvent?.({ type: 'log', ...entry });
        return send(response, 204, '', 'text/plain');
      }
      if (request.method === 'POST' && url.pathname === '/rpc') {
        const body = JSON.parse(await readBody(request)) as { method?: unknown; params?: unknown; permissions?: unknown };
        if (typeof body.method !== 'string') return sendJson(response, 400, { error: 'invalid_request' });
        const mock = host();
        if (Array.isArray(body.permissions)) mock.permissions = body.permissions.filter((item): item is string => typeof item === 'string');
        return sendJson(response, 200, await mock.handle(body.method, (body.params ?? {}) as JsonValue));
      }
      return sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof CliError) return sendJson(response, 422, { error: 'invalid', issues: error.issues });
      return sendJson(response, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const listenHost = options.host ?? DEFAULT_DEV_HOST;
  const server: Server = createServer((request, response) => void handler(request, response));
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify(state.errors.length ? { type: 'error', errors: state.errors } : { type: 'rebuilt', buildId: state.buildId }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      rejectListen(
        error.code === 'EADDRINUSE'
          ? new CliError(issue('dev.port_in_use', `Port ${options.port ?? DEFAULT_DEV_PORT} is in use`, { hint: 'Stop the other dev server or pass --port <n>.' }))
          : error,
      );
    });
    server.listen(options.port ?? DEFAULT_DEV_PORT, listenHost, () => resolveListen());
  }).catch(async (error) => {
    await ctx.dispose();
    for (const watcher of watchers) watcher.close();
    await liveIssuer?.close();
    throw error;
  });
  const port = (server.address() as AddressInfo).port;

  const lanUrls = ALL_INTERFACES.has(listenHost) ? lanAddresses().map((address) => `http://${address}:${port}`) : [];
  const named = !LOOPBACK.has(listenHost) && !ALL_INTERFACES.has(listenHost);
  return {
    url: named ? `http://${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${port}` : `http://localhost:${port}`,
    port,
    host: listenHost,
    lanUrls,
    status: () => ({ ...state, backend: backend?.status() ?? null }),
    remoteIssuer: liveIssuer?.issuer ?? null,
    nextBuild: () => new Promise((resolveNext) => waiters.push(resolveNext)),
    async close() {
      if (manifestTimer) clearTimeout(manifestTimer);
      await backend?.close();
      for (const watcher of watchers) watcher.close();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await ctx.dispose();
      await liveIssuer?.close();
    },
  };
}

/** `--host`: an IPv4/IPv6 literal or `localhost`; anything else is a usage error. */
function devHostFlag(value: string | undefined): string {
  if (value === undefined) return DEFAULT_DEV_HOST;
  const host = value.trim();
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[0-9a-fA-F:]+$/.test(host)) return host;
  throw new CliError(issue('cli.invalid_option', `--host must be an IP address (e.g. 127.0.0.1 or 0.0.0.0), not "${value}"`));
}

function openBrowser(url: string): void {
  try {
    const [command, args] =
      process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(command as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // Printing the URL is enough.
  }
}

/** How often `olan-app dev` checks that the process that started it still runs. */
const PARENT_CHECK_MS = 2000;

/** Whether a process with this id runs (signal 0 only checks; EPERM means it exists). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const devCommand: Command = {
  name: 'dev',
  summary: 'Watch, rebuild and serve the app to Olan Studio (Geliştirme sunucuları)',
  usage: 'olan-app dev [--port 5178] [--host 127.0.0.1] [--server http://localhost:3000] [--open] [--engine auto|isolated-vm|quickjs] [--remote fixtures|live] [--issuer-port 5180] [--detach]',
  options: [
    '--port <n>      Port (default 5178)',
    '--host <addr>   Listen address (default 127.0.0.1); 0.0.0.0 lets a phone on your network connect directly',
    '                and prints the LAN addresses (use it only on a trusted network)',
    '--server <url>  Olan web address for --open (default http://localhost:3000)',
    '--open          Open Studio with this dev server',
    '--engine <name> Backend engine (manifest "server"): auto (default; falls back to QuickJS where isolated-vm',
    '                has no prebuild), isolated-vm or quickjs',
    '--remote <mode> Who answers olan.remote.request: fixtures (default: fixtures/remote.json) or live (the app',
    '                server at remote.url, signed by the development issuer http://127.0.0.1:5180)',
    '--issuer-port <n> Port of that issuer with --remote live (default 5180; list it in the server issuers)',
    '--detach        Keep running after the process that started it exits (default: stop with it)',
    '                Stop: Ctrl+C (also in Windows Terminal/PowerShell), closing the terminal, or ending the parent process',
  ],
  spec: { strings: ['port', 'server', 'host', 'engine', 'remote', 'issuer-port'], booleans: ['open', 'detach'] },
  async run(args, context) {
    const projectDir = requireProjectDir(context.cwd);
    const server = (stringFlag(args, 'server') ?? context.env.OLAN_SERVER ?? DEFAULT_STUDIO_SERVER).replace(/\/+$/, '');
    // The first build is part of the result; events are streamed (one JSON object per line with
    // --json) only after the start-up envelope.
    let started = false;
    const early: string[] = [];
    const remoteMode = stringFlag(args, 'remote') ?? 'fixtures';
    if (remoteMode !== 'fixtures' && remoteMode !== 'live') throw new CliError(issue('cli.invalid_option', `--remote must be fixtures or live, not "${remoteMode}"`));
    const dev = await startDevServer({
      remote: remoteMode,
      issuerPort: integerFlag(args, 'issuer-port', DEV_ISSUER_PORT, 0, 65535),
      env: context.env,
      projectDir,
      port: integerFlag(args, 'port', DEFAULT_DEV_PORT, 0, 65535),
      host: devHostFlag(stringFlag(args, 'host')),
      engine: backendEngineFlag(stringFlag(args, 'engine')),
      onEvent: (event) => {
        // Engine warnings (the QuickJS fallback) arrive while starting: show them with the banner.
        if (!started && event.type === 'backend-warning') early.push(event.message);
        if (!started) return;
        const backendLine = formatBackendEvent(event);
        if (context.json) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        } else if (event.type === 'rebuilt') {
          context.log(`rebuilt ${event.buildId} (${event.durationMs} ms)`);
        } else if (backendLine !== null) {
          if (backendLine) context.log(backendLine);
        } else if (event.type === 'log') {
          context.log(formatLogEntry(event));
        } else if (event.type === 'remote') {
          context.log(event.message);
        } else if (event.type === 'error') {
          context.log(`build failed:\n${event.errors.map((item) => `  ${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.message}`).join('\n')}`);
        } else {
          context.log('olan-app.json changed');
        }
      },
    });
    const studioUrl = `${server}/studio?dev=${encodeURIComponent(dev.url)}`;
    if (booleanFlag(args, 'open')) openBrowser(studioUrl);
    const wait = new Promise<void>((resolveWait) => {
      let parentTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        if (parentTimer) clearInterval(parentTimer);
        void dev.close().then(resolveWait);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      // A closed terminal on Windows does not stop child processes: without this the server would
      // keep its port after the shell (or the agent) that started it is gone. `--detach` keeps it.
      if (!booleanFlag(args, 'detach')) {
        const parent = process.ppid;
        if (parent > 1) parentTimer = setInterval(() => {
          if (!processAlive(parent)) {
            context.log('The process that started olan-app dev exited; stopping.');
            stop();
          }
        }, PARENT_CHECK_MS);
      }
    });
    const status = dev.status();
    queueMicrotask(() => {
      started = true;
    });
    const backendStatus = status.backend;
    return {
      result: { url: dev.url, port: dev.port, host: dev.host, lanUrls: dev.lanUrls, ws: `${dev.url.replace(/^http/, 'ws')}/ws`, studio: studioUrl, remote: remoteMode, remoteIssuer: dev.remoteIssuer, ...status },
      warnings: [...status.errors, ...(backendStatus?.errors ?? []), ...early.map((message) => issue('backend.engine', message))],
      human: [
        `Dev server: ${dev.url}  (build ${status.buildId ?? 'failed'})`,
        ...(backendStatus
          ? [
              `Backend: ${backendStatus.engine ?? 'not started'}${backendStatus.sha256 ? ` (dist/server.js ${backendStatus.sha256.slice(0, 12)})` : ' (build failed)'}`,
              ...early.map((message) => `  warning: ${message}`),
              ...backendStatus.schedules.map((name) => `  run schedule now: curl -X POST ${dev.url}/backend/schedules/${name}/run`),
              ...backendStatus.hooks.map((name) => `  hook: POST ${dev.url}/hooks/${name}`),
            ]
          : []),
        remoteMode === 'live'
          ? `olan.remote.request → ${loadManifest(projectDir).manifest?.remote?.url ?? 'remote.url'}/requests, signed by ${dev.remoteIssuer} (list it in the app server's issuers)`
          : 'olan.remote.request → fixtures/remote.json (--remote live: your app server at remote.url)',
        `Studio → Geliştirme sunucuları → bu adresi girin: ${dev.url}`,
        ...(dev.lanUrls.length
          ? [`On your network (phone, direct mode): ${dev.lanUrls.join('  ')}`, 'Anyone on this network can reach the dev server and its mock data; stop it on untrusted networks.']
          : ALL_INTERFACES.has(dev.host)
            ? ['Listening on all interfaces, but no LAN address was found.']
            : []),
        `Or open: ${studioUrl}`,
        'Ctrl+C to stop.',
      ],
      wait,
    };
  },
};
