import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { BACKEND_LIMITS, EVENT_DATA_VERSION, backendCallable, eventDefinition, type EventType, type OlanAppManifest } from '@olan-app/schema';
import type { AppRuntime, EngineName, JsonValue, LogLine } from '@olan-app/runtime';
import { verifyHookSignature } from '@olan-app/sdk/server';

import { CliError, type Issue } from '../errors';
import type { MockHost, RpcOutcome } from '../mock-server';
import { sampleEventData } from '../remote-dev';
import { buildBackend } from './build';
import { hookResponse, normalizeHeaders, type HookResponse } from './hooks';
import { createBackendRunner, DEV_BACKEND_INSTALLATION, notCallable, openBackendRuntime, type BackendEngine, type BackendInvokeInput, type BackendOutcome } from './runner';

/** A backend invocation finished in `olan-app dev` (its console lines go to the terminal). */
export interface DevBackendInvocation {
  kind: BackendInvokeInput['kind'];
  name: string;
  ok: boolean;
  error?: { code: string; runtimeCode: string; message: string };
  logs: LogLine[];
  wallMs: number;
}

export type DevBackendEvent =
  | { type: 'backend-built'; sha256: string; bytes: number }
  | { type: 'backend-error'; errors: Issue[] }
  | { type: 'backend-warning'; message: string }
  | ({ type: 'backend-invocation' } & DevBackendInvocation);

export interface DevBackendStatus {
  engine: EngineName | null;
  /** SHA-256 of the current bundle (the runtime's digest), or null before the first good build. */
  sha256: string | null;
  errors: Issue[];
  schedules: string[];
  hooks: string[];
  events: string[];
}

export interface DevBackend {
  status(): DevBackendStatus;
  /** `olan.backend.call` for the dev host's `POST /rpc` `backend.call` (`{ ok, result | error }`). */
  call(name: string, args: JsonValue, caller: { userId: string | null; permissions: string[] }): Promise<RpcOutcome>;
  /** The same call with its console lines and timings (`POST /backend/call`). */
  invokeFunction(name: string, args: JsonValue, caller: { userId: string | null; permissions: string[] }): Promise<BackendOutcome>;
  /** "Run schedule now". */
  runSchedule(name: string): Promise<BackendOutcome>;
  emit(type: string, data?: JsonValue): Promise<BackendOutcome>;
  /** `POST /hooks/<name>`: verification, the function, its answer (or 202 after 10 s). */
  hook(name: string, request: { method: string; headers: Record<string, string | string[] | undefined>; body: string; query: Record<string, string> }): Promise<HookResponse>;
  rebuild(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The local backend of `olan-app dev`: bundles `server.entry` (rebuilt when files next to it or the
 * manifest change), runs it in `@olan-app/runtime` against the dev server's mock host (the same
 * `olan.db` the preview uses) and reports every invocation with its console lines.
 */
export async function startDevBackend(options: {
  projectDir: string;
  manifest: () => OlanAppManifest | null;
  host: () => MockHost;
  engine?: BackendEngine;
  onEvent?: (event: DevBackendEvent) => void;
}): Promise<DevBackend> {
  const { projectDir } = options;
  let runtime: AppRuntime | null = null;
  let code: string | null = null;
  let state: DevBackendStatus = { engine: null, sha256: null, errors: [], schedules: [], hooks: [], events: [] };
  const emitEvent = (event: DevBackendEvent) => options.onEvent?.(event);

  const rebuild = async () => {
    const manifest = options.manifest();
    if (!manifest?.server) return;
    state = { ...state, schedules: (manifest.server.schedules ?? []).map((entry) => entry.name), hooks: (manifest.server.hooks ?? []).map((entry) => entry.name), events: Object.keys(manifest.server.events ?? {}) };
    try {
      const built = await buildBackend(projectDir, manifest, { write: false });
      code = built.code;
      state = { ...state, sha256: built.digest, errors: [] };
      emitEvent({ type: 'backend-built', sha256: built.digest, bytes: built.bytes });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      state = { ...state, errors: error.issues };
      emitEvent({ type: 'backend-error', errors: error.issues });
    }
  };

  const ensureRuntime = async () => {
    runtime ??= await openBackendRuntime(options.engine ?? 'auto', (message) => emitEvent({ type: 'backend-warning', message }));
    state = { ...state, engine: runtime.engine };
    return runtime;
  };

  await rebuild();
  await ensureRuntime();

  // Rebuild when anything under the backend entry's directory changes (esbuild watches only the UI).
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const entry = options.manifest()?.server?.entry;
  if (entry) {
    try {
      watchers.push(
        watch(dirname(resolve(projectDir, entry)), { recursive: true }, (_event, filename) => {
          if (filename && /^(?:dist|node_modules|\.olan-app|\.git)(?:[\\/]|$)/.test(String(filename))) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void rebuild().catch(() => undefined), 80);
        }),
      );
    } catch {
      // Without recursive watching the backend still rebuilds when the manifest changes.
    }
  }

  const invoke = async (input: BackendInvokeInput): Promise<BackendOutcome> => {
    const manifest = options.manifest();
    if (!manifest?.server) throw new Error('olan-app.json declares no "server"');
    if (code === null) {
      const message = `The backend does not build: ${state.errors.map((item) => item.message).join('; ')}`;
      return { ok: false, error: { code: 'backend_error', runtimeCode: 'bundle_error', message }, logs: [], cpuMs: 0, wallMs: 0 };
    }
    const runner = createBackendRunner({ runtime: await ensureRuntime(), manifest, host: options.host(), code });
    const outcome = await runner.invoke(input);
    emitEvent({ type: 'backend-invocation', kind: input.kind, name: input.name, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }), logs: outcome.logs, wallMs: outcome.wallMs });
    return outcome;
  };
  // §15.1: a trigger's fallback function is not callable from the UI; answered like a missing one.
  const invokeFunction = async (name: string, args: JsonValue, caller: { userId: string | null; permissions: string[] }): Promise<BackendOutcome> => {
    if (!backendCallable(options.manifest(), name)) {
      const outcome = notCallable(name);
      emitEvent({ type: 'backend-invocation', kind: 'function', name, ok: false, error: outcome.error, logs: [], wallMs: 0 });
      return outcome;
    }
    return invoke({ kind: 'function', name, payload: args, identity: { actor: 'user', userId: caller.userId, permissions: caller.permissions } });
  };
  const appIdentity = () => ({ actor: 'app' as const, userId: null, permissions: [...(options.manifest()?.permissions ?? [])] });
  const server = () => {
    const value = options.manifest()?.server;
    if (!value) throw new Error('olan-app.json declares no "server"');
    return value;
  };

  return {
    status: () => state,
    async call(name, args, caller) {
      const outcome = await invokeFunction(name, args, caller);
      return outcome.ok ? { ok: true, result: outcome.value } : { ok: false, error: { code: outcome.error.code, message: outcome.error.message } };
    },
    invokeFunction,
    runSchedule(name) {
      const schedule = server().schedules?.find((item) => item.name === name);
      if (!schedule) throw new Error(`No schedule "${name}" in server.schedules`);
      return invoke({ kind: 'schedule', name, fallback: schedule.function, payload: { schedule: name, scheduledAt: new Date().toISOString() }, identity: appIdentity() });
    },
    emit(type, data) {
      const fn = server().events?.[type];
      if (!fn) throw new Error(`"${type}" is not in server.events`);
      const manifest = options.manifest()!;
      const host = options.host();
      const definition = eventDefinition(type);
      const envelope: JsonValue = {
        id: `evt_${randomUUID()}`,
        type,
        version: EVENT_DATA_VERSION,
        occurredAt: new Date().toISOString(),
        issuer: 'http://localhost',
        installationId: DEV_BACKEND_INSTALLATION,
        appId: manifest.id,
        actor: definition?.permission ? { kind: 'user', id: host.userId } : { kind: 'system' },
        data: data ?? sampleEventData(type as EventType, host.data, manifest),
      };
      return invoke({ kind: 'event', name: type, fallback: fn, payload: envelope, identity: appIdentity() });
    },
    async hook(name, request) {
      const hook = server().hooks?.find((item) => item.name === name);
      if (!hook) return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'hook_not_found' }) };
      const headers = normalizeHeaders(request.headers);
      const secret = hook.verify.secretSetting ? options.host().secret(hook.verify.secretSetting) : null;
      const verification = await verifyHookSignature(hook.verify, { headers, body: request.body }, secret, { development: true });
      if (!verification.ok) {
        emitEvent({ type: 'backend-invocation', kind: 'hook', name, ok: false, error: { code: verification.code, runtimeCode: verification.code, message: verification.message }, logs: [], wallMs: 0 });
        return { status: verification.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: verification.code, message: verification.message }) };
      }
      const running = invoke({ kind: 'hook', name, fallback: hook.function, payload: { method: request.method, headers, body: request.body, query: request.query }, identity: appIdentity() });
      const late = new Promise<null>((resolveLate) => setTimeout(() => resolveLate(null), BACKEND_LIMITS.hookResponseMs).unref());
      const outcome = await Promise.race([running, late]);
      return outcome ? hookResponse(outcome) : { status: 202, headers: {}, body: '' };
    },
    rebuild,
    async close() {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      await runtime?.dispose();
      runtime = null;
    },
  };
}
