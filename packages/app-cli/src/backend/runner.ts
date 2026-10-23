import { createHash } from 'node:crypto';

import { BACKEND_LIMITS, backendCallErrorCode, type OlanAppManifest } from '@olan-app/schema';
import type { AppRuntime, EngineChoice, EngineName, InvocationKind, InvocationRequest, JsonValue, LogLine, RuntimeLimits } from '@olan-app/runtime';

import { CliError, issue } from '../errors';
import type { MockHost } from '../mock-server';

export type BackendEngine = EngineChoice;
export const BACKEND_ENGINES: readonly BackendEngine[] = ['auto', 'isolated-vm', 'quickjs'];
/** The installation id local runs use (`olan-app dev`, `olan-app test`). */
export const DEV_BACKEND_INSTALLATION = 'dev-installation';

/** `--engine`: `auto` (default), `isolated-vm` or `quickjs`. */
export function backendEngineFlag(value: string | undefined): BackendEngine {
  if (value === undefined) return 'auto';
  if ((BACKEND_ENGINES as readonly string[]).includes(value)) return value as BackendEngine;
  throw new CliError(issue('cli.invalid_option', `--engine must be one of ${BACKEND_ENGINES.join(', ')}, not "${value}"`));
}

/**
 * Starts `@olan-app/runtime` for local runs. isolated-vm needs a Node started with
 * `--no-node-snapshot`, so it runs in a forked runtime process (like on the Olan server); QuickJS
 * runs in this process. `auto` falls back to QuickJS where the isolated-vm prebuild does not load
 * (Intel Mac, Windows ARM) and reports it through `onWarning`
 * ("isolated-vm prebuild not available on <platform>; using QuickJS (slower)").
 */
export async function openBackendRuntime(engine: BackendEngine = 'auto', onWarning?: (message: string) => void): Promise<AppRuntime> {
  let runtimeModule: typeof import('@olan-app/runtime');
  try {
    runtimeModule = await import('@olan-app/runtime');
  } catch (error) {
    throw new CliError(issue('backend.runtime_missing', `@olan-app/runtime could not be loaded: ${(error as Error).message}`, { hint: 'Reinstall @olan-app/cli (it depends on @olan-app/runtime).' }));
  }
  if (engine === 'quickjs') return runtimeModule.createRuntime({ engine: 'quickjs', onWarning });
  try {
    return await runtimeModule.forkRuntime({ engine, onWarning });
  } catch (error) {
    if (engine === 'isolated-vm') {
      throw new CliError(issue('backend.engine_unavailable', `isolated-vm could not start: ${(error as Error).message}`, { hint: 'Use --engine quickjs (or auto).' }));
    }
    onWarning?.(`the app runtime process could not start (${(error as Error).message}); using QuickJS in this process (slower)`);
    return runtimeModule.createRuntime({ engine: 'quickjs', onWarning });
  }
}

export interface BackendIdentityInput {
  actor: 'user' | 'app';
  userId: string | null;
  permissions: string[];
}

export type BackendOutcome =
  | { ok: true; value: JsonValue; logs: LogLine[]; cpuMs: number; wallMs: number }
  | {
      ok: false;
      /** `code`: what `olan.backend.call` rejects with (`backend_error`, `backend_limit`, …); `runtimeCode`: the runtime's own code. */
      error: { code: string; runtimeCode: string; message: string };
      logs: LogLine[];
      cpuMs: number;
      wallMs: number;
    };

export interface BackendInvokeInput {
  kind: InvocationKind;
  name: string;
  fallback?: string;
  payload: JsonValue;
  identity: BackendIdentityInput;
  limits?: Partial<RuntimeLimits>;
}

/**
 * The answer to `backend.call(name)` when `name` is not callable from the UI (`backendCallable`:
 * a trigger's fallback function): the runtime's own `not_found`, as for a missing function.
 */
export function notCallable(name: string): Extract<BackendOutcome, { ok: false }> {
  return { ok: false, error: { code: 'backend_function_not_found', runtimeCode: 'not_found', message: `no handler for function "${name}"` }, logs: [], cpuMs: 0, wallMs: 0 };
}

/** Default local limits: the §15.1 defaults (`backend.call` 10 s, other triggers 30 s). */
export function defaultBackendLimits(kind: InvocationKind): RuntimeLimits {
  return {
    cpuMs: BACKEND_LIMITS.cpuMs,
    wallMs: kind === 'function' ? BACKEND_LIMITS.callMs : BACKEND_LIMITS.invocationMs,
    memoryMb: BACKEND_LIMITS.memoryMiB,
    concurrency: BACKEND_LIMITS.concurrencyPerInstallation,
  };
}

export interface BackendRunner {
  readonly engine: EngineName;
  /** Replaces the bundle (after a rebuild); the next invocation loads it. */
  setCode(code: string): void;
  readonly digest: string | null;
  invoke(input: BackendInvokeInput): Promise<BackendOutcome>;
  dispose(): Promise<void>;
}

/**
 * Runs `dist/server.js` in `runtime` with `host` as the `__olan.call` dispatcher (the mock Olan
 * host: `olan.db` on the in-memory database, fixtures for projects/calendar/…, fake `http.fetch`,
 * `secrets.get` from the secret settings). Every call is checked against the invocation identity's
 * permissions with `backendMethodAllowed`, like the Olan server.
 */
export function createBackendRunner(options: {
  runtime: AppRuntime;
  manifest: Pick<OlanAppManifest, 'id'>;
  host: MockHost;
  code: string;
  limits?: Partial<RuntimeLimits>;
  onLogs?: (lines: LogLine[], input: BackendInvokeInput) => void;
  installationId?: string;
}): BackendRunner {
  const installationId = options.installationId ?? DEV_BACKEND_INSTALLATION;
  let code = options.code;
  let digest = createHash('sha256').update(code).digest('hex');
  return {
    get engine() {
      return options.runtime.engine;
    },
    get digest() {
      return digest;
    },
    setCode(next) {
      code = next;
      digest = createHash('sha256').update(code).digest('hex');
    },
    async invoke(input) {
      const request: InvocationRequest = {
        installationId,
        digest,
        kind: input.kind,
        name: input.name,
        ...(input.fallback ? { fallback: input.fallback } : {}),
        payload: input.payload,
        context: { appId: options.manifest.id, identity: { actor: input.identity.actor, userId: input.identity.userId, permissions: [...input.identity.permissions] } },
        limits: { ...defaultBackendLimits(input.kind), ...options.limits, ...input.limits },
      };
      const bundle = code;
      const result = await options.runtime.invoke(
        request,
        async () => bundle,
        async (_installation, method, argsJson) => {
          let params: JsonValue;
          try {
            params = JSON.parse(argsJson) as JsonValue;
          } catch {
            throw { code: 'invalid_params', message: `${method}: the arguments are not JSON` };
          }
          const outcome = await options.host.handle(method, params, { backend: true, permissions: input.identity.permissions });
          if (!outcome.ok) throw { code: outcome.error.code, message: outcome.error.message };
          return JSON.stringify(outcome.result ?? null);
        },
      );
      options.onLogs?.(result.logs, input);
      if (result.ok) return result;
      return { ...result, error: { code: backendCallErrorCode(result.error.code), runtimeCode: result.error.code, message: result.error.message } };
    },
    async dispose() {
      await options.runtime.dispose();
    },
  };
}
