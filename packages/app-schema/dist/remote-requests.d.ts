import type { JsonValue } from './json.js';
import type { EmbeddedAppToken } from './remote.js';
export declare const REMOTE_REQUEST_METHODS: readonly ["GET", "POST", "PUT", "PATCH", "DELETE"];
export type RemoteRequestMethod = (typeof REMOTE_REQUEST_METHODS)[number];
/** Request headers an app may set (lowercase); any other is `invalid_params`. */
export declare const REMOTE_REQUEST_HEADERS: readonly ["accept", "accept-language", "if-match", "if-none-match", "idempotency-key"];
/** Response headers Olan passes from the app server's answer to the app. */
export declare const REMOTE_RESPONSE_HEADERS: readonly ["content-type", "etag"];
export declare const REMOTE_REQUEST_LIMITS: Readonly<{
    defaultTimeoutMs: 30000;
    minTimeoutMs: 1000;
    maxTimeoutMs: 60000;
    /** `body` serialised as JSON (UTF-8). */
    requestBodyBytes: number;
    /** The app server's raw HTTP response. */
    responseBytes: number;
    pathMax: 2048;
    queryKeys: 50;
    queryKeyMax: 128;
    queryValues: 100;
    headerValueMax: 1024;
    /** Per installation and person. */
    perPersonPerMinute: 300;
    /** Per installation and person, in flight. */
    concurrentPerPerson: 8;
    /** Receivers keep seen `req_` ids at least this long (Olan never retries a request). */
    idRetentionSeconds: 600;
}>;
/** `webhook-id` / envelope `id` prefix of requests. */
export declare const REMOTE_REQUEST_ID_PREFIX = "req_";
/**
 * The generic app-server error for "this needs `profile:read`": the server answers a 4xx (409) with
 * `{ error: 'profile_required' }`, the app gets `remote_rejected` and explains it to the person.
 */
export declare const PROFILE_REQUIRED = "profile_required";
/** `user.role` with `profile:read` (G2): the same mapping as the marketplace `olan_org_role`, without `developer`. */
export declare const PROFILE_ROLES: readonly ["admin", "member"];
export type ProfileRole = (typeof PROFILE_ROLES)[number];
/** `user.role` of the envelope for an Olan `users.role` (`super_admin`/`tenant_admin` → `admin`). */
export declare function profileRole(usersRole: string | null | undefined): ProfileRole;
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
    headers: {
        'content-type'?: string;
        etag?: string;
    };
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
export declare const REMOTE_ERROR_REASONS: readonly ["timeout", "network", "http_status", "invalid_response", "response_too_large"];
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
export declare const REMOTE_REQUEST_ERROR_CODES: readonly ["remote_unavailable", "remote_rejected", "consent_required", "payload_too_large", "rate_limited", "feature_not_enabled"];
export type RemoteRequestErrorCode = (typeof REMOTE_REQUEST_ERROR_CODES)[number];
export type RemoteRequestOutcome = {
    ok: true;
    result: RemoteResponse;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
        details: RemoteErrorDetails;
    };
};
/** Problem of a request path, or null. */
export declare function remotePathProblem(path: unknown): string | null;
export type ValidateRemoteRequestResult = {
    ok: true;
    request: NormalizedRemoteRequest;
} | {
    ok: false;
    code: 'invalid_params' | 'payload_too_large';
    message: string;
};
/**
 * Checks and normalises `remote.request` params (host, server route and mock server): method,
 * path, query (values to strings), header allowlist (names lowercased), body size, timeout.
 */
export declare function validateRemoteRequest(input: unknown): ValidateRemoteRequestResult;
/**
 * Parses the app server's answer (contract §1.5): an object with an integer `status` 200–599,
 * optional `headers` (only `content-type` and `etag` are kept) and `body` (default null).
 * Null when the shape is wrong (`remote_unavailable`, reason `invalid_response`).
 */
export declare function parseRemoteAnswer(value: unknown): RemoteResponse | null;
/**
 * The RPC outcome of an app server answer (contract §1.6): 200–399 → the result; 400–499 →
 * `remote_rejected` with the body; 500–599 → `remote_unavailable` (`reason: 'http_status'`).
 */
export declare function remoteRequestOutcome(answer: RemoteResponse): RemoteRequestOutcome;
/**
 * The RPC error of a refused `remote/requests` route call (contract §1.3 table): `details.status` is
 * the HTTP status, 0 for `remote_unavailable` (no usable answer).
 */
export declare function remoteRouteError(httpStatus: number, body: unknown): {
    code: string;
    message: string;
    details: RemoteErrorDetails;
};
