import type { JsonValue } from './json.js';
import type { EmbeddedAppToken } from './remote.js';

/*
 * `olan.remote.request` (Phase 5a contract §1, G1/G2/G12): the sandbox asks the app's own server for
 * something on behalf of the person. Host → `POST /api/v2/apps/installations/:id/remote/requests` →
 * signed `POST {remote.url}/requests` (the Phase 3 §5.3 signature). Shared by the hosts (web, mobile),
 * the Olan server, the CLI mock server and `@olan-app/sdk/server`. No runtime dependencies.
 */

export const REMOTE_REQUEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type RemoteRequestMethod = (typeof REMOTE_REQUEST_METHODS)[number];

/** Request headers an app may set (lowercase); any other is `invalid_params`. */
export const REMOTE_REQUEST_HEADERS = ['accept', 'accept-language', 'if-match', 'if-none-match', 'idempotency-key'] as const;
/** Response headers Olan passes from the app server's answer to the app. */
export const REMOTE_RESPONSE_HEADERS = ['content-type', 'etag'] as const;

export const REMOTE_REQUEST_LIMITS = Object.freeze({
  defaultTimeoutMs: 30_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  /** `body` serialised as JSON (UTF-8). */
  requestBodyBytes: 1024 * 1024,
  /** The app server's raw HTTP response. */
  responseBytes: 4 * 1024 * 1024,
  pathMax: 2048,
  queryKeys: 50,
  queryKeyMax: 128,
  queryValues: 100,
  headerValueMax: 1024,
  /** Per installation and person. */
  perPersonPerMinute: 300,
  /** Per installation and person, in flight. */
  concurrentPerPerson: 8,
  /** Receivers keep seen `req_` ids at least this long (Olan never retries a request). */
  idRetentionSeconds: 600,
});

/** `webhook-id` / envelope `id` prefix of requests. */
export const REMOTE_REQUEST_ID_PREFIX = 'req_';

/**
 * The generic app-server error for "this needs `profile:read`": the server answers a 4xx (409) with
 * `{ error: 'profile_required' }`, the app gets `remote_rejected` and explains it to the person.
 */
export const PROFILE_REQUIRED = 'profile_required';

/** `user.role` with `profile:read` (G2): the same mapping as the marketplace `olan_org_role`, without `developer`. */
export const PROFILE_ROLES = ['admin', 'member'] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

/** Olan `users.role` values that are `admin` in `user.role`; every other role is `member`. */
const ADMIN_USER_ROLES = new Set(['super_admin', 'tenant_admin']);

/** `user.role` of the envelope for an Olan `users.role` (`super_admin`/`tenant_admin` → `admin`). */
export function profileRole(usersRole: string | null | undefined): ProfileRole {
  return typeof usersRole === 'string' && ADMIN_USER_ROLES.has(usersRole) ? 'admin' : 'member';
}

export type RemoteQueryValue = string | number | boolean;

/** What the app passes to `olan.remote.request` (the RPC params). */
export interface RemoteRequestInit {
  method: RemoteRequestMethod;
  /** Starts with `/`; no `?`, `#`, `..`, `//` or control characters; ≤ 2048. */
  path: string;
  query?: Record<string, RemoteQueryValue | RemoteQueryValue[]>;
  /** Only `REMOTE_REQUEST_HEADERS`. */
  headers?: Record<string, string>;
  /** Not with GET and DELETE; ≤ 1 MiB as JSON. */
  body?: JsonValue;
  /** 1000–60000, default 30000. */
  timeoutMs?: number;
}

/** `request` of the envelope: the app's request, normalised. */
export interface NormalizedRemoteRequest {
  method: RemoteRequestMethod;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: JsonValue;
  timeoutMs: number;
}

/** Result of `olan.remote.request` (status 200–399). */
export interface RemoteResponse {
  status: number;
  headers: { 'content-type'?: string; etag?: string };
  body: JsonValue;
}

/**
 * What the app server answers to a verified request: HTTP 200, `application/json`, this body
 * (contract §1.5). `status` 200–599; Olan passes only `content-type` and `etag`.
 */
export interface RemoteAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: JsonValue;
}

/** `user` of the envelope; `email`, `displayName` and `role` only with `profile:read`. */
export interface RemoteRequestUser {
  /** Central Olan user id (OIDC `sub`). */
  id: string;
  /** Tenant id. */
  organizationId: string;
  locale: string;
  timeZone: string;
  email?: string;
  displayName?: string;
  role?: ProfileRole;
}

/** The body of `POST {remote.url}/requests`. */
export interface RemoteRequestEnvelope {
  /** `req_<uuid>`; also the `webhook-id`. */
  id: string;
  issuer: string;
  installationId: string;
  appId: string;
  /** Absent when the call runs as the app identity (none in Phase 5a: requests always come from a person). */
  user?: RemoteRequestUser;
  request: NormalizedRemoteRequest;
  /** On behalf of the person (300 s): their effective permissions in this installation. */
  token: EmbeddedAppToken;
}

export const REMOTE_ERROR_REASONS = ['timeout', 'network', 'http_status', 'invalid_response', 'response_too_large'] as const;
export type RemoteErrorReason = (typeof REMOTE_ERROR_REASONS)[number];

/** `details` of a failed `remote.request` RPC (the SDK's `RemoteError` reads it). */
export interface RemoteErrorDetails {
  /** The app server's status, Olan's HTTP status for Olan-side refusals, 0 without a response. */
  status: number;
  /** `remote_rejected` / `remote_unavailable` with an answer: the app server's body. */
  body?: JsonValue;
  reason?: RemoteErrorReason;
  retryAfterSeconds?: number;
  feature?: string;
  limitBytes?: number;
}

/** Error codes `olan.remote.request` may fail with (besides the generic RPC ones). */
export const REMOTE_REQUEST_ERROR_CODES = ['remote_unavailable', 'remote_rejected', 'consent_required', 'payload_too_large', 'rate_limited', 'feature_not_enabled'] as const;
export type RemoteRequestErrorCode = (typeof REMOTE_REQUEST_ERROR_CODES)[number];

export type RemoteRequestOutcome =
  | { ok: true; result: RemoteResponse }
  | { ok: false; error: { code: string; message: string; details: RemoteErrorDetails } };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Problem of a request path, or null. */
export function remotePathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'path must be a non-empty string';
  if (path.length > REMOTE_REQUEST_LIMITS.pathMax) return `path is limited to ${REMOTE_REQUEST_LIMITS.pathMax} characters`;
  if (!path.startsWith('/')) return 'path must start with "/"';
  if (path.includes('//')) return 'path must not contain "//"';
  if (/[?#\\]/.test(path) || CONTROL.test(path)) return 'path must not contain "?", "#", "\\" or control characters (use query for parameters)';
  for (const segment of path.split('/').slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return 'path has a malformed percent-encoding';
    }
    if (decoded === '.' || decoded === '..') return 'path must not contain "." or ".." segments';
    if (decoded.includes('/') || decoded.includes('\\')) return 'path segments must not encode "/" or "\\"';
  }
  return null;
}

export type ValidateRemoteRequestResult =
  | { ok: true; request: NormalizedRemoteRequest }
  | { ok: false; code: 'invalid_params' | 'payload_too_large'; message: string };

/**
 * Checks and normalises `remote.request` params (host, server route and mock server): method,
 * path, query (values to strings), header allowlist (names lowercased), body size, timeout.
 */
export function validateRemoteRequest(input: unknown): ValidateRemoteRequestResult {
  const invalid = (message: string): ValidateRemoteRequestResult => ({ ok: false, code: 'invalid_params', message });
  if (!isObject(input)) return invalid('remote.request needs { method, path }');
  for (const key of Object.keys(input)) {
    if (!['method', 'path', 'query', 'headers', 'body', 'timeoutMs'].includes(key)) return invalid(`remote.request does not take "${key}"`);
  }
  const method = input.method;
  if (typeof method !== 'string' || !(REMOTE_REQUEST_METHODS as readonly string[]).includes(method)) {
    return invalid(`method must be one of ${REMOTE_REQUEST_METHODS.join(', ')}`);
  }
  const pathProblem = remotePathProblem(input.path);
  if (pathProblem) return invalid(pathProblem);

  const query: Record<string, string | string[]> = {};
  if (input.query !== undefined && input.query !== null) {
    if (!isObject(input.query)) return invalid('query must be an object');
    const entries = Object.entries(input.query);
    if (entries.length > REMOTE_REQUEST_LIMITS.queryKeys) return invalid(`query takes at most ${REMOTE_REQUEST_LIMITS.queryKeys} keys`);
    const scalar = (value: unknown): string | null =>
      typeof value === 'string' ? value : typeof value === 'boolean' ? String(value) : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
    for (const [key, value] of entries) {
      if (key.length === 0 || key.length > REMOTE_REQUEST_LIMITS.queryKeyMax) return invalid(`query keys are 1–${REMOTE_REQUEST_LIMITS.queryKeyMax} characters`);
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        if (value.length > REMOTE_REQUEST_LIMITS.queryValues) return invalid(`query.${key} takes at most ${REMOTE_REQUEST_LIMITS.queryValues} values`);
        const list = value.map(scalar);
        if (list.some((item) => item === null)) return invalid(`query.${key} values must be strings, numbers or booleans`);
        query[key] = list as string[];
      } else {
        const text = scalar(value);
        if (text === null) return invalid(`query.${key} must be a string, number, boolean or an array of them`);
        query[key] = text;
      }
    }
  }

  const headers: Record<string, string> = {};
  if (input.headers !== undefined && input.headers !== null) {
    if (!isObject(input.headers)) return invalid('headers must be an object');
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (!(REMOTE_REQUEST_HEADERS as readonly string[]).includes(lower)) return invalid(`header "${name}" is not allowed (allowed: ${REMOTE_REQUEST_HEADERS.join(', ')})`);
      if (typeof value !== 'string' || value.length > REMOTE_REQUEST_LIMITS.headerValueMax || /[\r\n]/.test(value)) {
        return invalid(`header "${name}" must be a single-line string of at most ${REMOTE_REQUEST_LIMITS.headerValueMax} characters`);
      }
      headers[lower] = value;
    }
  }

  const body = input.body === undefined ? null : (input.body as JsonValue);
  if ((method === 'GET' || method === 'DELETE') && body !== null) return invalid(`${method} requests have no body`);
  if (body !== null) {
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      return invalid('body must be JSON');
    }
    if (text === undefined) return invalid('body must be JSON');
    if (utf8Length(text) > REMOTE_REQUEST_LIMITS.requestBodyBytes) {
      return { ok: false, code: 'payload_too_large', message: `The request body is larger than ${REMOTE_REQUEST_LIMITS.requestBodyBytes} bytes` };
    }
  }

  let timeoutMs: number = REMOTE_REQUEST_LIMITS.defaultTimeoutMs;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    const value = input.timeoutMs;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < REMOTE_REQUEST_LIMITS.minTimeoutMs || value > REMOTE_REQUEST_LIMITS.maxTimeoutMs) {
      return invalid(`timeoutMs must be an integer from ${REMOTE_REQUEST_LIMITS.minTimeoutMs} to ${REMOTE_REQUEST_LIMITS.maxTimeoutMs}`);
    }
    timeoutMs = value;
  }
  return { ok: true, request: { method: method as RemoteRequestMethod, path: input.path as string, query, headers, body, timeoutMs } };
}

/**
 * Parses the app server's answer (contract §1.5): an object with an integer `status` 200–599,
 * optional `headers` (only `content-type` and `etag` are kept) and `body` (default null).
 * Null when the shape is wrong (`remote_unavailable`, reason `invalid_response`).
 */
export function parseRemoteAnswer(value: unknown): RemoteResponse | null {
  if (!isObject(value)) return null;
  const status = value.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) return null;
  const headers: RemoteResponse['headers'] = {};
  if (value.headers !== undefined && value.headers !== null) {
    if (!isObject(value.headers)) return null;
    for (const [name, header] of Object.entries(value.headers)) {
      const lower = name.toLowerCase();
      if (typeof header === 'string' && (REMOTE_RESPONSE_HEADERS as readonly string[]).includes(lower)) headers[lower as 'content-type' | 'etag'] = header;
    }
  }
  return { status, headers, body: value.body === undefined ? null : (value.body as JsonValue) };
}

/**
 * The RPC outcome of an app server answer (contract §1.6): 200–399 → the result; 400–499 →
 * `remote_rejected` with the body; 500–599 → `remote_unavailable` (`reason: 'http_status'`).
 */
export function remoteRequestOutcome(answer: RemoteResponse): RemoteRequestOutcome {
  if (answer.status < 400) return { ok: true, result: answer };
  if (answer.status < 500) {
    return { ok: false, error: { code: 'remote_rejected', message: `The app's server answered ${answer.status}`, details: { status: answer.status, body: answer.body } } };
  }
  return {
    ok: false,
    error: { code: 'remote_unavailable', message: `The app's server answered ${answer.status}`, details: { status: answer.status, body: answer.body, reason: 'http_status' } },
  };
}

/**
 * The RPC error of a refused `remote/requests` route call (contract §1.3 table): `details.status` is
 * the HTTP status, 0 for `remote_unavailable` (no usable answer).
 */
export function remoteRouteError(httpStatus: number, body: unknown): { code: string; message: string; details: RemoteErrorDetails } {
  const payload = isObject(body) ? body : {};
  const code = typeof payload.error === 'string' && payload.error ? payload.error : httpStatus >= 500 ? 'remote_unavailable' : 'host_error';
  const message = typeof payload.message === 'string' ? payload.message : `The request failed (${httpStatus})`;
  const extra = isObject(payload.details) ? payload.details : {};
  const details: RemoteErrorDetails = { status: code === 'remote_unavailable' ? 0 : httpStatus };
  if (typeof extra.reason === 'string' && (REMOTE_ERROR_REASONS as readonly string[]).includes(extra.reason)) details.reason = extra.reason as RemoteErrorReason;
  if (typeof extra.retryAfterSeconds === 'number') details.retryAfterSeconds = extra.retryAfterSeconds;
  if (typeof extra.feature === 'string') details.feature = extra.feature;
  if (typeof extra.limitBytes === 'number') details.limitBytes = extra.limitBytes;
  return { code, message, details };
}
