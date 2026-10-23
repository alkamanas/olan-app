import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { EVENT_DATA_VERSION, backendCallable, defaultSettings, eventDefinition, validateManifest, type EventType, type OlanAppManifest } from '@olan-app/schema';
import type { EngineName, JsonValue, LogLine, RuntimeLimits } from '@olan-app/runtime';
import { signHookRequest, verifyHookSignature } from '@olan-app/sdk/server';
import type { MemoryDb } from '@olan-app/sdk/memory-db';

import { CliError } from '../errors';
import { createMockHost, defaultFixtures, loadProjectFixtures, mergeFixtures, type Fixtures, type MockCall, type MockHost } from '../mock-server';
import { sampleEventData } from '../remote-dev';
import { BACKEND_BUNDLE, buildBackend } from './build';
import { hookResponse, normalizeHeaders, type HookResponse } from './hooks';
import { createBackendRunner, DEV_BACKEND_INSTALLATION, notCallable, openBackendRuntime, type BackendEngine, type BackendInvokeInput, type BackendOutcome } from './runner';

export interface BackendHarnessOptions {
  /** App directory (default: `OLAN_APP_ROOT`, set by `olan-app test`, else the current directory). */
  root?: string;
  /** Fields over `olan-app.json` (e.g. another `server` or `permissions` for one test). */
  manifest?: Partial<OlanAppManifest>;
  /** Settings over the manifest defaults and `fixtures/settings.json` (`secret: true` fields included). */
  settings?: Record<string, JsonValue>;
  /** `olan.secrets.get` values (default: the `secret: true` settings values). */
  secrets?: Record<string, string | null>;
  /** `olan.db` rows by collection (like `fixtures/db.json`). */
  db?: Fixtures['db'];
  /** Fixture data over `fixtures/*.json` and the defaults (projects, calendar, `http` responses, …). */
  fixtures?: Fixtures;
  /** `auto` (default; `OLAN_APP_BACKEND_ENGINE` or `olan-app test --engine` change it), `isolated-vm` or `quickjs`. */
  engine?: BackendEngine;
  /** The app identity's permissions (schedules, events, hooks) and the default caller's; default the manifest's. */
  permissions?: string[];
  /** The `backend.call` caller (default `DEFAULT_USER_ID`). */
  userId?: string;
  /** Start of the host clock (row timestamps). */
  now?: string | number | Date;
  /** `true` (default): bundle `server.entry` now; `false`: load the existing `dist/server.js`. */
  build?: boolean;
  /** Per-invocation limits over the §15.1 defaults (e.g. `{ cpuMs: 5000 }` on a slow machine). */
  limits?: Partial<RuntimeLimits>;
  /** Share a mock host (and its database) with `renderApp`; internal. */
  host?: MockHost;
  /** Engine notices (e.g. the QuickJS fallback); default: printed to stderr once. */
  onWarning?: (message: string) => void;
}

export interface BackendResult<T = JsonValue> {
  ok: boolean;
  /** The handler's JSON result (`ok`). */
  value?: T;
  /** `code` is what `olan.backend.call` rejects with (`backend_error`, `backend_limit`, …); `runtimeCode` the runtime's (`handler_error`, `cpu_limit`, …). */
  error?: { code: string; runtimeCode: string; message: string };
  /** `console.*` lines of this invocation (what Studio shows). */
  logs: LogLine[];
  cpuMs: number;
  wallMs: number;
}

export interface HookResult extends BackendResult, HookResponse {
  /** Whether the request passed `verify` (the function only runs when it did). */
  verified: boolean;
}

export interface HookInput {
  method?: string;
  headers?: Record<string, string>;
  /** Raw body; objects are sent as JSON. */
  body?: string | JsonValue;
  query?: Record<string, string>;
  /** Add a valid signature when the request has none (default `true`; `false` sends it unsigned). */
  sign?: boolean;
}

export interface EmitInput {
  type: string;
  /** Event `data` (default: a sample built from the fixtures, like `olan-app events send`). */
  data?: JsonValue;
  actor?: JsonValue;
  id?: string;
  occurredAt?: string;
}

export interface BackendCallOptions {
  /** Caller (default the harness user). */
  userId?: string;
  /** The caller's consented permissions (default the manifest's). */
  permissions?: string[];
}

export interface BackendHarness {
  readonly engine: EngineName;
  readonly manifest: OlanAppManifest;
  /** The mock Olan host behind `__olan.call` (`host.data`, `host.audit()`, `host.cards`). */
  readonly host: MockHost;
  /** The in-memory `olan.db`. */
  readonly db: MemoryDb;
  /** `olan.backend.call(name, args)` as the caller (actor `user`). */
  call<T = JsonValue>(name: string, args?: JsonValue, options?: BackendCallOptions): Promise<BackendResult<T>>;
  /** Runs `server.schedules[name]` now (actor `app`). */
  runSchedule<T = JsonValue>(name: string, options?: { scheduledAt?: string }): Promise<BackendResult<T>>;
  /** Delivers an event listed in `server.events` (actor `app`); a string is the event type. */
  emit<T = JsonValue>(event: string | EmitInput): Promise<BackendResult<T>>;
  /** `POST /api/v2/apps/hooks/<installationId>/<name>`: verification, then the hook function. */
  hook(name: string, request?: HookInput): Promise<HookResult>;
  /** Runs `migrate(fromVersion)`. */
  migrate(fromVersion: string): Promise<BackendResult>;
  /** Host calls the backend made (`olan.*` from backend code), oldest first. */
  calls(method?: string): MockCall[];
  /** Every console line so far. */
  logs(): LogLine[];
  dispose(): Promise<void>;
}

let fallbackWarned = false;

function loadManifestFile(root: string): OlanAppManifest | null {
  const path = join(root, 'olan-app.json');
  if (!existsSync(path)) return null;
  const result = validateManifest(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (!result.ok) throw new Error(`olan-app.json is invalid:\n${result.issues.map((item) => `${item.path} ${item.message}`).join('\n')}`);
  return result.manifest;
}

/** `secret: true` settings fields: hidden from the UI when the app declares `server`. */
export function secretSettingKeys(manifest: Pick<OlanAppManifest, 'settings'>): string[] {
  return Object.entries(manifest.settings ?? {}).filter(([, field]) => field.secret === true).map(([key]) => key);
}

const asResult = <T>(outcome: BackendOutcome): BackendResult<T> =>
  outcome.ok
    ? { ok: true, value: outcome.value as T, logs: outcome.logs, cpuMs: outcome.cpuMs, wallMs: outcome.wallMs }
    : { ok: false, error: outcome.error, logs: outcome.logs, cpuMs: outcome.cpuMs, wallMs: outcome.wallMs };

/**
 * A headless backend for tests (`@olan-app/cli/testing`): bundles `server.entry` (or loads
 * `dist/server.js`), runs it in `@olan-app/runtime` (isolated-vm in a forked runtime process, or
 * QuickJS) and answers `olan.*` from the mock Olan host (in-memory `olan.db`, fixtures, fake
 * `http.fetch` from `fixtures/http.json`, `olan.secrets` from the secret settings).
 *
 * ```ts
 * const backend = await createBackendHarness({ secrets: { apiToken: 't' } });
 * const result = await backend.call('summary');
 * assert.equal(result.ok, true);
 * await backend.dispose();
 * ```
 */
export async function createBackendHarness(options: BackendHarnessOptions = {}): Promise<BackendHarness> {
  const root = resolve(options.root ?? process.env.OLAN_APP_ROOT ?? process.cwd());
  const fileManifest = loadManifestFile(root);
  if (!fileManifest && !options.manifest) throw new Error(`createBackendHarness: no olan-app.json in ${root}`);
  const manifest = { ...(fileManifest ?? {}), ...(options.manifest ?? {}) } as OlanAppManifest;
  const server = manifest.server;
  if (!server) throw new Error('createBackendHarness: olan-app.json declares no "server" (backend code)');
  const permissions = options.permissions ?? manifest.permissions ?? [];

  let host = options.host;
  if (!host) {
    const fixtures = mergeFixtures(defaultFixtures(), loadProjectFixtures(root), options.fixtures, options.db ? { db: options.db } : undefined);
    const settings = { ...defaultSettings(manifest), ...(fixtures.settings ?? {}), ...(options.settings ?? {}) };
    try {
      host = createMockHost({
        fixtures: { ...fixtures, settings },
        permissions,
        data: manifest.data ?? null,
        appId: manifest.id,
        ...(typeof manifest.name === 'string' ? { appName: manifest.name } : {}),
        secretSettings: secretSettingKeys(manifest),
        ...(options.secrets ? { secrets: options.secrets } : {}),
        ...(options.userId !== undefined ? { userId: options.userId } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    } catch (error) {
      if (error instanceof CliError) throw new Error(`createBackendHarness: the fixtures are invalid:\n${error.issues.map((item) => item.message).join('\n')}`);
      throw error;
    }
  }
  const mock = host;

  let code: string;
  if (options.build === false) {
    const file = join(root, BACKEND_BUNDLE);
    if (!existsSync(file)) throw new Error(`createBackendHarness: ${BACKEND_BUNDLE} does not exist; run \`olan-app build\` or leave build on`);
    code = readFileSync(file, 'utf8');
  } else {
    try {
      code = (await buildBackend(root, manifest, { write: false })).code;
    } catch (error) {
      if (error instanceof CliError) {
        throw new Error(`The backend (${server.entry}) does not build:\n${error.issues.map((item) => `${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.message}`).join('\n')}`);
      }
      throw error;
    }
  }

  const engine = options.engine ?? (process.env.OLAN_APP_BACKEND_ENGINE as BackendEngine | undefined) ?? 'auto';
  const warn =
    options.onWarning ??
    ((message: string) => {
      if (fallbackWarned) return;
      fallbackWarned = true;
      process.stderr.write(`[olan-app backend] ${message}\n`);
    });
  const runtime = await openBackendRuntime(engine, warn);
  const allLogs: LogLine[] = [];
  const runner = createBackendRunner({ runtime, manifest, host: mock, code, limits: options.limits, onLogs: (lines) => allLogs.push(...lines) });
  const appIdentity = () => ({ actor: 'app' as const, userId: null, permissions: [...permissions] });
  const run = async <T>(input: BackendInvokeInput) => asResult<T>(await runner.invoke(input));

  const harness: BackendHarness = {
    get engine() {
      return runner.engine;
    },
    manifest,
    host: mock,
    db: mock.db,
    async call(name, args = null, callOptions = {}) {
      // §15.1: trigger fallback functions are not callable from the UI (`backend_function_not_found`).
      if (!backendCallable(manifest, name)) return asResult(notCallable(name));
      return run({ kind: 'function', name, payload: args, identity: { actor: 'user', userId: callOptions.userId ?? mock.userId, permissions: [...(callOptions.permissions ?? mock.permissions)] } });
    },
    async runSchedule(name, scheduleOptions = {}) {
      const schedule = server.schedules?.find((entry) => entry.name === name);
      if (!schedule) throw new Error(`runSchedule: olan-app.json server.schedules has no "${name}" (${(server.schedules ?? []).map((entry) => entry.name).join(', ') || 'none'})`);
      return run({ kind: 'schedule', name, fallback: schedule.function, payload: { schedule: name, scheduledAt: scheduleOptions.scheduledAt ?? new Date().toISOString() }, identity: appIdentity() });
    },
    async emit(input) {
      const event = typeof input === 'string' ? { type: input } : input;
      const fn = server.events?.[event.type];
      if (!fn) throw new Error(`emit: "${event.type}" is not in olan-app.json server.events, so Olan would not deliver it`);
      const definition = eventDefinition(event.type);
      const data = event.data ?? sampleEventData(event.type as EventType, mock.data, manifest);
      const envelope: JsonValue = {
        id: event.id ?? `evt_${randomUUID()}`,
        type: event.type,
        version: EVENT_DATA_VERSION,
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        issuer: 'http://localhost',
        installationId: DEV_BACKEND_INSTALLATION,
        appId: manifest.id,
        actor: event.actor ?? (definition?.permission ? { kind: 'user', id: mock.userId } : { kind: 'system' }),
        data,
      };
      return run({ kind: 'event', name: event.type, fallback: fn, payload: envelope, identity: appIdentity() });
    },
    async hook(name, input = {}) {
      const hook = server.hooks?.find((entry) => entry.name === name);
      if (!hook) throw new Error(`hook: olan-app.json server.hooks has no "${name}" (${(server.hooks ?? []).map((entry) => entry.name).join(', ') || 'none'})`);
      const body = input.body === undefined ? '' : typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
      let headers = normalizeHeaders({ ...(typeof input.body === 'object' && input.body !== null ? { 'content-type': 'application/json' } : {}), ...input.headers });
      const secret = hook.verify.secretSetting ? mock.secret(hook.verify.secretSetting) : null;
      const signed = hook.verify.kind === 'hmac-sha256' ? (hook.verify.header ?? '').toLowerCase() in headers : 'webhook-signature' in headers;
      if (input.sign !== false && !signed && secret && hook.verify.kind !== 'none') headers = { ...headers, ...normalizeHeaders(await signHookRequest(hook.verify, body, secret)) };
      const verification = await verifyHookSignature(hook.verify, { headers, body }, secret, { development: true });
      if (!verification.ok) {
        return {
          ok: false,
          verified: false,
          error: { code: verification.code, runtimeCode: verification.code, message: verification.message },
          logs: [],
          cpuMs: 0,
          wallMs: 0,
          status: verification.status,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: verification.code, message: verification.message }),
        };
      }
      const outcome = await runner.invoke({ kind: 'hook', name, fallback: hook.function, payload: { method: input.method ?? 'POST', headers, body, query: input.query ?? {} }, identity: appIdentity() });
      return { ...asResult(outcome), verified: true, ...hookResponse(outcome) };
    },
    async migrate(fromVersion) {
      return run({ kind: 'migrate', name: 'migrate', payload: { fromVersion }, identity: appIdentity() });
    },
    calls: (method) => structuredClone(mock.calls.filter((call) => call.source === 'backend' && (!method || call.method === method))),
    logs: () => structuredClone(allLogs),
    dispose: () => runner.dispose(),
  };
  return harness;
}
