import type { JsonValue, RpcError, RpcErrorCode, SandboxToHostMessage } from '../protocol';
import type { RemoteErrorReason, RpcMethodName, RpcParams, RpcResult } from './types';

/**
 * Error code of a failed call: one of the contract codes (`permission_denied`, `conflict`,
 * `forbidden_record`, …; see errors.md). A newer host may send codes this SDK does not know yet.
 */
export type OlanErrorCode = RpcErrorCode | (string & {});

/** A failed `olan.*` call. `code` is one of the contract error codes (`permission_denied`, …). */
export class OlanError extends Error {
  readonly code: OlanErrorCode;
  /** Machine-readable extras the host sent (`rpc-result.error.details`), if any. */
  declare readonly hostDetails?: JsonValue;

  constructor(code: OlanErrorCode, message: string, hostDetails?: JsonValue) {
    super(message);
    this.name = 'OlanError';
    this.code = code;
    if (hostDetails !== undefined) this.hostDetails = hostDetails;
  }
}

/**
 * A failed `olan.remote.request` (Phase 5a §1.6). `status` is the app server's status
 * (`remote_rejected`, `remote_unavailable` with an answer), Olan's HTTP status for its own refusals
 * (`consent_required` 403, `payload_too_large` 413, `rate_limited` 429), or 0 when the app server
 * gave no usable answer. `details` is the app server's body for `remote_rejected` /
 * `remote_unavailable`, else null.
 */
export class RemoteError extends OlanError {
  readonly status: number;
  readonly details: JsonValue;
  declare readonly reason?: RemoteErrorReason;
  declare readonly retryAfterSeconds?: number;

  constructor(code: OlanErrorCode, message: string, hostDetails?: JsonValue) {
    super(code, message, hostDetails);
    this.name = 'RemoteError';
    const extra = typeof hostDetails === 'object' && hostDetails !== null && !Array.isArray(hostDetails) ? hostDetails : {};
    this.status = typeof extra.status === 'number' ? extra.status : 0;
    this.details = extra.body === undefined ? null : extra.body;
    if (typeof extra.reason === 'string') this.reason = extra.reason as RemoteErrorReason;
    if (typeof extra.retryAfterSeconds === 'number') this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

/**
 * `error` of an app server's 4xx body when it needs `profile:read` (`RemoteError` `remote_rejected`
 * with `details.error === PROFILE_REQUIRED`). Repeated from @olan-app/schema; a test keeps them equal.
 */
export const PROFILE_REQUIRED = 'profile_required';

/**
 * Whether `error` is an `OlanError` (optionally with this `code`). Also true for errors that
 * crossed a realm boundary, by shape (`name === 'OlanError'` and a string `code`).
 */
export function isOlanError<C extends RpcErrorCode>(error: unknown, code?: C): error is OlanError & { code: C } {
  const shaped =
    error instanceof OlanError ||
    (typeof error === 'object' && error !== null && ((error as { name?: unknown }).name === 'OlanError' || (error as { name?: unknown }).name === 'RemoteError') && typeof (error as { code?: unknown }).code === 'string');
  return shaped && (code === undefined || (error as OlanError).code === code);
}

/** Whether `error` is a `RemoteError` (a failed `olan.remote.request`), optionally with this `code`. */
export function isRemoteError(error: unknown, code?: OlanErrorCode): error is RemoteError {
  const shaped = error instanceof RemoteError || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'RemoteError' && typeof (error as { status?: unknown }).status === 'number');
  return shaped && (code === undefined || (error as RemoteError).code === code);
}

/** Methods whose failures are `RemoteError`s. */
const REMOTE_METHODS = new Set<string>(['remote.request']);

export interface RpcClient {
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  /** Resolves or rejects the pending call `id`; unknown ids are ignored. */
  settle(id: number, outcome: { ok: true; result: JsonValue } | { ok: false; error: RpcError }): void;
  /** Rejects every pending call (the runtime is shutting down). */
  cancelAll(reason: string): void;
  readonly pending: number;
}

export function createRpcClient(post: (message: SandboxToHostMessage) => void): RpcClient {
  let nextId = 1;
  const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
        try {
          post({ type: 'rpc', id, method, params: params as unknown as JsonValue });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    settle(id, outcome) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (outcome.ok) entry.resolve(outcome.result);
      else {
        const { code, message, details } = outcome.error;
        entry.reject(REMOTE_METHODS.has(entry.method) ? new RemoteError(code, message, details) : new OlanError(code, message, details));
      }
    },
    cancelAll(reason) {
      for (const entry of pending.values()) entry.reject(REMOTE_METHODS.has(entry.method) ? new RemoteError('cancelled', reason) : new OlanError('cancelled', reason));
      pending.clear();
    },
    get pending() {
      return pending.size;
    },
  };
}

/* The runtime installs its client here; `olan.*` calls made before `init` fail clearly. */
let activeClient: RpcClient | null = null;

export function setActiveRpcClient(client: RpcClient | null): void {
  activeClient = client;
}

export function rpc<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  if (!activeClient) {
    const message = `olan.${method} was called before the app runtime started`;
    return Promise.reject(REMOTE_METHODS.has(method) ? new RemoteError('host_error', message) : new OlanError('host_error', message));
  }
  return activeClient.call(method, params);
}
