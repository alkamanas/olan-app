/**
 * `@olan-app/sdk/server`: for an Olan app's own server (manifest `remote`, Phase 3 contract §4–§6).
 * Verifies requests Olan signs (events, assistant tool calls, card actions), gets installation
 * tokens with a `private_key_jwt` client assertion, and answers tool calls. WebCrypto only, no
 * dependencies: runs on Node ≥ 22 (also Deno, Bun, edge runtimes).
 *
 * ```ts
 * import { createServer } from 'node:http';
 * import { createOlanServer, fromNodeRequest, sendNodeResponse } from '@olan-app/sdk/server';
 *
 * const olan = createOlanServer({ appId: 'com.example.standup', privateKeyPem: process.env.APP_KEY, issuers: ['https://olan.example.com'] });
 * createServer(async (req, res) => {
 *   const request = await fromNodeRequest(req);
 *   if (req.url === '/olan/events') return sendNodeResponse(res, await olan.handleEvent(request, { 'project.task.created': async (event) => { … } }));
 *   if (req.url?.startsWith('/olan/ai-tools/')) return sendNodeResponse(res, await olan.handleToolCall(request, { standup_summary: async (input, ctx) => ({ result: … }) }));
 *   if (req.url === '/.well-known/jwks.json') return sendNodeResponse(res, Response.json(await olan.jwks()));
 * }).listen(4100);
 * ```
 */
import type {
  AiToolCallRequest,
  AnyAppEvent,
  AppCard,
  CardActionRequest,
  CardActionResponse,
  EventType,
  JsonValue,
  NormalizedRemoteRequest,
  RemoteAnswer,
  RemoteRequestEnvelope,
  RemoteRequestUser,
} from '@olan-app/schema';

import {
  base64UrlJson,
  derToPem,
  fromBase64,
  importSigningKey,
  importVerifyKey,
  jwkThumbprint,
  sign,
  toBase64Url,
  utf8,
  verifyEd25519,
  type AssertionAlgorithm,
  type Jwk,
  type SigningKey,
} from './crypto.js';

export type {
  AiToolCallRequest,
  AnyAppEvent,
  AppCard,
  AppEventEnvelope,
  CardActionRequest,
  CardActionResponse,
  EventDataMap,
  EventType,
  NormalizedRemoteRequest,
  ProfileRole,
  RemoteAnswer,
  RemoteRequestEnvelope,
  RemoteRequestUser,
} from '@olan-app/schema';
export type { AssertionAlgorithm, Jwk } from './crypto.js';
export { HOOK_BODY_MAX_BYTES, HOOK_TIMESTAMP_TOLERANCE_SECONDS, signHookRequest, verifyHookSignature, type HookVerificationResult, type HookVerifyConfig } from './hooks.js';

// Repeated from @olan-app/schema (remote.ts) so this module stays dependency-free; a test keeps them equal.
export const WEBHOOK_HEADERS = Object.freeze({
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
  issuer: 'olan-issuer',
  keyId: 'olan-key-id',
  installationId: 'olan-installation-id',
  eventType: 'olan-event-type',
  attempt: 'olan-delivery-attempt',
});
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_ID_RETENTION_SECONDS = 24 * 60 * 60;
/**
 * Olan's own cloud (`OLAN_CLOUD_ISSUER`: `/.well-known/olan` `apps.issuer` in production). Pass
 * `issuers` explicitly anyway: self-hosted and development servers are never in this default.
 */
export const DEFAULT_ISSUERS: readonly string[] = Object.freeze(['https://api.olan.app']);
/**
 * Seen `req_` and `act_` ids are kept this long: Olan never retries a request or a card action, so
 * a repeat is a replay (twice the ±5 min timestamp window).
 */
export const REQUEST_ID_RETENTION_SECONDS = 600;
/**
 * The error an app server answers (`throw new RequestError(409, { error: PROFILE_REQUIRED })`) when
 * it needs the person's profile (`email`, `displayName`, `role`) but they did not grant
 * `profile:read`. The app gets `remote_rejected` with `details.body.error === 'profile_required'`.
 */
export const PROFILE_REQUIRED = 'profile_required';
/**
 * Events after which a cached installation token may carry outdated permissions: `handleEvent`
 * drops the installation's cached tokens when it receives one (a new version or a consent changes
 * the grant; an uninstalled installation's tokens stop working).
 */
export const TOKEN_INVALIDATING_EVENTS: readonly string[] = Object.freeze(['app.updated', 'app.consent.changed', 'app.uninstalled']);
/**
 * 403 `error` codes of Olan's app-token guard that a token issued before a grant change causes
 * (`permission_denied`: the token's permissions lack the route's; `insufficient_scope`: its scope):
 * `fetchOlan` retries these once with a fresh token.
 */
export const STALE_TOKEN_ERRORS: readonly string[] = Object.freeze(['permission_denied', 'insufficient_scope']);
/** Fixed paths of Olan's web app (`APP_RETURN_PATH_PREFIX` of @olan-app/schema). */
const APP_RETURN_PATH = '/apps/return/';
const SIGNATURE_VERSION = 'v1a';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ASSERTION_LIFETIME_SECONDS = 60;
const JWKS_CACHE_SECONDS = 600;
const JWKS_REFRESH_MIN_SECONDS = 60;
const TOOL_RESULT_MAX_BYTES = 64 * 1024;
const TOOL_SUMMARY_MAX = 500;
/** JWK members that are never published (`additionalPublicKeys`). */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** Why a request or a token call failed. Verification failures carry `status` 401 (400 for bodies). */
export type OlanServerErrorCode =
  | 'missing_header'
  | 'issuer_not_allowed'
  | 'jwks_unavailable'
  | 'unknown_key'
  | 'invalid_signature'
  | 'timestamp_out_of_range'
  | 'invalid_body'
  | 'no_private_key'
  | 'token_failed'
  | 'issuer_mismatch'
  | 'tool_mismatch'
  | (string & {});

export class OlanServerError extends Error {
  readonly code: OlanServerErrorCode;
  readonly status: number;
  /** Token endpoint failures: the OAuth error body (`consent_required` has `missing`). */
  readonly detail?: Record<string, unknown>;

  constructor(code: OlanServerErrorCode, message: string, status = 401, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'OlanServerError';
    this.code = code;
    this.status = status;
    if (detail) this.detail = detail;
  }
}

/** Remembers `webhook-id`s (≥ 24 h) so retried deliveries are processed once. */
export interface IdempotencyStore {
  has(id: string): boolean | Promise<boolean>;
  add(id: string, ttlSeconds: number): void | Promise<void>;
}

/** In-memory store; use a shared one (Redis, a table) when the app server runs more than one process. */
export function memoryIdempotencyStore(now: () => number = Date.now): IdempotencyStore {
  const seen = new Map<string, number>();
  return {
    has(id) {
      const until = seen.get(id);
      if (until === undefined) return false;
      if (until < now()) {
        seen.delete(id);
        return false;
      }
      return true;
    },
    add(id, ttlSeconds) {
      seen.set(id, now() + ttlSeconds * 1000);
      if (seen.size > 10_000) for (const [key, until] of seen) if (until < now()) seen.delete(key);
    },
  };
}

export interface OlanServerOptions {
  /** The app's manifest id (`iss`/`sub` of client assertions). */
  appId: string;
  /** PKCS#8 PEM private key (Ed25519, P-256 or RSA) whose public half is served at `remote.jwksUrl`. Only needed for tokens and `jwks()`. */
  privateKeyPem?: string;
  /** `kid` of the key (default: its RFC 7638 thumbprint). */
  keyId?: string;
  /**
   * Key rotation: the next private key. `jwks()` publishes its public half after the current key's;
   * assertions are still signed with `privateKeyPem`. After Olan's JWKS cache time (10 min) make it
   * `privateKeyPem` (server.md#rotating-the-app-key).
   */
  nextPrivateKeyPem?: string;
  /** `kid` of `nextPrivateKeyPem` (default: its RFC 7638 thumbprint). */
  nextKeyId?: string;
  /**
   * More public keys for `jwks()` (each with a `kid`), e.g. the retired key while the rotation
   * finishes. Private members are never published.
   */
  additionalPublicKeys?: readonly Jwk[];
  /**
   * Olan servers this app accepts. Always set it (e.g. `[process.env.OLAN_ISSUER]`); the default is
   * Olan's cloud only (`['https://api.olan.app']`). Add each self-hosted Olan here: a request from
   * any other issuer is rejected, since anyone could run an "Olan server".
   */
  issuers?: readonly string[] | ((issuer: string) => boolean);
  /**
   * Seen `webhook-id`s (default in memory): `handleEvent` processes a retried event once,
   * `handleRequest` and `handleCardAction` refuse a repeat as a replay. `false` turns the checks off.
   */
  idempotency?: IdempotencyStore | false;
  /** Clock skew allowed on `webhook-timestamp` (default 300 s). */
  toleranceSeconds?: number;
  /** How long issuer discovery and JWKS are cached (default 600 s). */
  jwksCacheSeconds?: number;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
}

/** A request whose signature, issuer and timestamp checked out. */
export interface VerifiedRequest<T = unknown> {
  issuer: string;
  keyId: string;
  /** `webhook-id`: `evt_…`, `call_…` or `act_…`; the same on every retry. */
  webhookId: string;
  timestamp: number;
  installationId: string | null;
  /** Events only. */
  eventType: string | null;
  /** Events only (1-based). */
  attempt: number | null;
  rawBody: string;
  body: T;
}

/**
 * What `verify` and the handlers take: a WHATWG `Request`, or headers plus the raw body (and the
 * request URL or path, which `handleToolCall` compares with the body's tool).
 */
export type IncomingRequest = Request | { headers: Headers | Record<string, string | string[] | undefined>; body: string | Uint8Array; url?: string };

export interface InstallationToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  permissions: string[];
}

export interface ToolContext {
  callId: string;
  tool: string;
  installationId: string;
  appId: string;
  issuer: string;
  channel: 'assistant' | 'mcp';
  user: { id: string; locale: string; timeZone: string };
  /** On behalf of the person (300 s); its permissions are the tool's `permissions` ∩ the person's. */
  token: { accessToken: string; expiresIn: number };
}

/** A tool's answer: `result` goes back to the model, `summary` (≤ 500) is shown to the person. */
export interface ToolOutput {
  result: JsonValue;
  summary?: string;
}

export type ToolHandler = (input: Record<string, JsonValue>, context: ToolContext) => ToolOutput | Promise<ToolOutput>;

/** Throw from a tool handler to answer `{ ok: false, error: { code, message } }`. */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export interface EventContext {
  issuer: string;
  installationId: string;
  webhookId: string;
  attempt: number | null;
}

export type EventHandler = (event: AnyAppEvent, context: EventContext) => void | Promise<void>;
/** Handlers by event type; `'*'` gets the rest. Events without a handler are acknowledged and ignored. */
export type EventHandlers = { [T in EventType]?: (event: Extract<AnyAppEvent, { type: T }>, context: EventContext) => void | Promise<void> } & { '*'?: EventHandler };

export type CardActionHandler = (action: CardActionRequest, context: { issuer: string; webhookId: string }) => CardActionResponse | void | Promise<CardActionResponse | void>;

/** What a `handleRequest` route gets (Phase 5a §1.8). */
export interface RemoteRequestContext {
  /** `req_…` (also the `webhook-id`). */
  id: string;
  issuer: string;
  installationId: string;
  appId: string;
  /**
   * The person; `email`, `displayName` and `role` only when they granted `profile:read`. Null for
   * app-identity calls (none in Phase 5a).
   */
  user: RemoteRequestUser | null;
  method: NormalizedRemoteRequest['method'];
  path: string;
  /** `:name` segments of the matched route (decoded); `*` holds the rest of a `/*` route. */
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: JsonValue;
  /** On behalf of the person (300 s): call Olan back without a token request. */
  token: { accessToken: string; expiresIn: number } | null;
  timeoutMs: number;
}

/** A route's answer: `status` defaults to 200 (200–599), `body` to null. */
export interface RemoteRequestResult {
  status?: number;
  headers?: Record<string, string>;
  body?: JsonValue;
}

export type RemoteRequestHandler = (context: RemoteRequestContext) => RemoteRequestResult | void | Promise<RemoteRequestResult | void>;
/** Routes by `"METHOD /path/:param"` (`*` as method matches any; a trailing `/*` matches the rest). */
export type RemoteRoutes = Readonly<Record<string, RemoteRequestHandler>>;

/** Throw from a route to answer that status (4xx reaches the app as `remote_rejected` with `body`). */
export class RequestError extends Error {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers?: Record<string, string>;

  constructor(status: number, body: JsonValue = null, headers?: Record<string, string>) {
    super(`Request failed with status ${status}`);
    this.name = 'RequestError';
    this.status = status;
    this.body = body;
    if (headers) this.headers = headers;
  }
}

/**
 * `instanceof RequestError`, or an error shaped like one (`name` "RequestError", numeric `status`):
 * a route may throw the class from another copy of this module, e.g. the app's own
 * `@olan-app/sdk/server` while `olan-app` runs its bundled copy.
 */
function isRequestError(error: unknown): error is RequestError {
  if (error instanceof RequestError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; status?: unknown };
  return candidate.name === 'RequestError' && typeof candidate.status === 'number';
}

interface CompiledRoute {
  method: string;
  segments: string[];
  rest: boolean;
  handler: RemoteRequestHandler;
}

const compiledRoutes = new WeakMap<RemoteRoutes, CompiledRoute[]>();

function compileRoutes(routes: RemoteRoutes): CompiledRoute[] {
  const cached = compiledRoutes.get(routes);
  if (cached) return cached;
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const match = /^([A-Z]+|\*)\s+(\/\S*)$/.exec(key.trim());
    if (!match) throw new TypeError(`Route "${key}" must look like "GET /brands/:brandId"`);
    const segments = match[2]!.split('/').slice(1).filter((segment, index, all) => segment !== '' || index < all.length - 1);
    const rest = segments[segments.length - 1] === '*';
    return { method: match[1]!, segments: rest ? segments.slice(0, -1) : segments, rest, handler };
  });
  compiledRoutes.set(routes, compiled);
  return compiled;
}

/**
 * The route for `method` + `path`: `{ handler, params }`, or `{ status: 404 | 405 }`. Static
 * segments win over `:params` only by declaration order: list specific routes first.
 */
export function matchRemoteRoute(routes: RemoteRoutes, method: string, path: string): { handler: RemoteRequestHandler; params: Record<string, string> } | { status: 404 | 405 } {
  const parts = path.split('/').slice(1).filter((segment, index, all) => segment !== '' || index < all.length - 1);
  let pathMatched = false;
  for (const route of compileRoutes(routes)) {
    if (route.rest ? parts.length < route.segments.length : parts.length !== route.segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let index = 0; index < route.segments.length && ok; index++) {
      const segment = route.segments[index]!;
      let part: string;
      try {
        part = decodeURIComponent(parts[index]!);
      } catch {
        ok = false;
        break;
      }
      if (segment.startsWith(':')) params[segment.slice(1)] = part;
      else ok = segment === part;
    }
    if (!ok) continue;
    if (route.rest) params['*'] = parts.slice(route.segments.length).join('/');
    pathMatched = true;
    if (route.method === '*' || route.method === method) return { handler: route.handler, params };
  }
  return { status: pathMatched ? 405 : 404 };
}

/**
 * Runs `router` for a request context and returns the wrapped answer (`{ status, headers, body }`,
 * contract §1.5): unknown path 404 `unknown_route`, other method 405 `method_not_allowed`,
 * `RequestError` its status and body, any other error 500 `internal_error`. The CLI mock server uses
 * the same function, so tests and production route alike.
 */
export async function runRemoteRoute(router: RemoteRoutes | RemoteRequestHandler, context: Omit<RemoteRequestContext, 'params'>): Promise<RemoteAnswer> {
  let handler: RemoteRequestHandler;
  let params: Record<string, string> = {};
  if (typeof router === 'function') {
    handler = router;
  } else {
    const found = matchRemoteRoute(router, context.method, context.path);
    if ('status' in found) {
      return found.status === 404
        ? { status: 404, body: { error: 'unknown_route', message: `No route for ${context.method} ${context.path}` } }
        : { status: 405, body: { error: 'method_not_allowed', message: `${context.path} does not accept ${context.method}` } };
    }
    handler = found.handler;
    params = found.params;
  }
  try {
    const result = (await handler({ ...context, params })) ?? {};
    const status = result.status ?? 200;
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new TypeError(`A route answered status ${String(status)} (200–599)`);
    return { status, ...(result.headers ? { headers: result.headers } : {}), body: result.body ?? null };
  } catch (error) {
    if (isRequestError(error) && Number.isInteger(error.status) && error.status >= 200 && error.status <= 599) {
      return { status: error.status, ...(error.headers ? { headers: error.headers } : {}), body: error.body ?? null };
    }
    return { status: 500, body: { error: 'internal_error' } };
  }
}

export interface OlanServer {
  /** Checks issuer allowlist → key (`kid` in the issuer's JWKS) → Ed25519 signature → timestamp (±5 min). */
  verify<T = unknown>(request: IncomingRequest): Promise<VerifiedRequest<T>>;
  /**
   * A token for the Olan API: app identity (no `userId`; only projects and conversations the app was
   * added to) or on behalf of a person who consented (`userId`). Cached until 30 s before expiry.
   */
  getInstallationToken(options: { issuer: string; installationId: string; userId?: string }): Promise<InstallationToken>;
  /**
   * Drops the cached tokens of an installation (app identity and every person; of one issuer when
   * `issuer` is given), so the next `getInstallationToken` asks Olan again. `handleEvent` does this
   * for `TOKEN_INVALIDATING_EVENTS`; call it when you process events yourself. Returns how many it dropped.
   */
  invalidateToken(installationId: string, options?: { issuer?: string }): number;
  /** Drops every cached installation token. */
  clearTokenCache(): void;
  /**
   * Calls the Olan API with an installation token (`Authorization: Bearer`, from
   * `getInstallationToken`). `path` is resolved against the issuer; a URL on another origin is
   * refused, so the token never goes to another server. When Olan answers 403 with one of
   * `STALE_TOKEN_ERRORS`, the cached token is dropped and the call is sent once more with a fresh
   * token (the body must be replayable: a string, bytes, `URLSearchParams`, `FormData` or `Blob`).
   */
  fetchOlan(options: { issuer: string; installationId: string; userId?: string }, path: string, init?: RequestInit): Promise<Response>;
  /** The signed client assertion `getInstallationToken` sends (RFC 7523). */
  createClientAssertion(options: { issuer: string; installationId: string; userId?: string }): Promise<string>;
  /**
   * `POST {remote.url}/ai-tools/{name}`: verifies, refuses a body whose `tool` is not `{name}` (400
   * `tool_mismatch`, when the request URL is known), runs `tools[body.tool]`, answers `{ ok, result | error }`.
   */
  handleToolCall(request: IncomingRequest, tools: Readonly<Record<string, ToolHandler>>): Promise<Response>;
  /**
   * `POST {remote.url}/events`: verifies, drops the installation's cached tokens for
   * `TOKEN_INVALIDATING_EVENTS`, skips seen `webhook-id`s, runs the handler; 2xx acknowledges.
   */
  handleEvent(request: IncomingRequest, handler: EventHandler | EventHandlers): Promise<Response>;
  /**
   * `POST {remote.url}/card-actions`: verifies, refuses a repeated `act_` id (HTTP 409
   * `duplicate_request`: Olan never retries card actions) and answers `{ card?, toast? }` (within 5 s).
   */
  handleCardAction(request: IncomingRequest, handler: CardActionHandler): Promise<Response>;
  /**
   * `POST {remote.url}/requests` (`olan.remote.request`, Phase 5a §1): verifies like events, refuses
   * an envelope whose `issuer` is not the `olan-issuer` header (401 `issuer_mismatch`) and a
   * repeated `req_` id (HTTP 409), routes by method and path, and answers HTTP 200 with
   * `{ status, headers?, body }`. Verification failures answer 401 without the wrapper.
   */
  handleRequest(request: IncomingRequest, router: RemoteRoutes | RemoteRequestHandler): Promise<Response>;
  /**
   * `https://<Olan web>/apps/return/<installationId>`: where external flows send the person back
   * (`olan.ui.openExternal`). The web origin comes from the issuer's `/.well-known/olan` `webOrigin`.
   */
  appReturnUrl(options: { issuer: string; installationId: string }): Promise<string>;
  /** Whether `url` is exactly that return address (any query); use it to accept a `returnUrl`. */
  isAppReturnUrl(options: { issuer: string; installationId: string; url: string }): Promise<boolean>;
  /**
   * The public JWKS to serve at the manifest `remote.jwksUrl`: the current key, then the
   * `nextPrivateKeyPem` key and `additionalPublicKeys` (key rotation).
   */
  jwks(): Promise<{ keys: Jwk[] }>;
}

const normalizeIssuer = (issuer: string) => issuer.trim().replace(/\/+$/, '');

function headerOf(headers: IncomingRequest['headers'], name: string): string | null {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** The tool the URL names (`…/ai-tools/{name}`), or null when the URL is unknown or has no such segment. */
function urlToolName(request: IncomingRequest): string | null {
  const url = (request as { url?: unknown }).url;
  if (typeof url !== 'string' || url.length === 0) return null;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const match = /\/ai-tools\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

async function readBody(request: IncomingRequest): Promise<string> {
  if (typeof Request !== 'undefined' && request instanceof Request) return request.text();
  const body = (request as { body: string | Uint8Array }).body;
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface IssuerKeys {
  jwksUri: string;
  tokenEndpoint: string;
  /** `/.well-known/olan` `webOrigin` (Olan 1.5+), else null. */
  webOrigin: string | null;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
  refreshedAt: number;
}

/** Creates the helpers for one app (one key, one issuer allowlist). */
export function createOlanServer(options: OlanServerOptions): OlanServer {
  if (!options || typeof options.appId !== 'string' || options.appId.length === 0) throw new TypeError('createOlanServer needs { appId }');
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const cacheMs = (options.jwksCacheSeconds ?? JWKS_CACHE_SECONDS) * 1000;
  const idempotency = options.idempotency === false ? null : (options.idempotency ?? memoryIdempotencyStore(now));
  const allowlist = options.issuers ?? DEFAULT_ISSUERS;
  const issuerAllowed = (issuer: string) =>
    typeof allowlist === 'function' ? allowlist(issuer) : allowlist.some((candidate) => normalizeIssuer(candidate) === issuer);

  const issuers = new Map<string, Promise<IssuerKeys>>();
  const tokens = new Map<string, InstallationToken>();
  /** Bumped by every invalidation: a token request in flight at that moment is not cached. */
  let tokenEpoch = 0;
  let signing: Promise<SigningKey & { kid: string }> | null = null;
  let nextSigning: Promise<SigningKey & { kid: string }> | null = null;
  const keyWithKid = (pem: string, keyId: string | undefined) => importSigningKey(pem).then(async (key) => ({ ...key, kid: keyId ?? (await jwkThumbprint(key.publicJwk)) }));

  const signingKey = () => {
    if (!options.privateKeyPem) throw new OlanServerError('no_private_key', 'createOlanServer needs privateKeyPem for tokens and jwks()', 500);
    signing ??= keyWithKid(options.privateKeyPem, options.keyId);
    return signing;
  };

  const getJson = async (url: string): Promise<Record<string, unknown>> => {
    const response = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const value: unknown = await response.json();
    if (!isObject(value)) throw new Error(`${url} did not answer a JSON object`);
    return value;
  };

  const loadIssuer = async (issuer: string, previous?: IssuerKeys): Promise<IssuerKeys> => {
    let jwksUri = previous?.jwksUri ?? `${issuer}/api/v2/apps/jwks.json`;
    let tokenEndpoint = previous?.tokenEndpoint ?? `${issuer}/api/v2/apps/oauth/token`;
    let webOrigin = previous?.webOrigin ?? null;
    if (!previous) {
      try {
        const wellKnown = await getJson(`${issuer}/.well-known/olan`);
        const apps = isObject(wellKnown.apps) ? wellKnown.apps : {};
        if (typeof apps.jwksUri === 'string') jwksUri = apps.jwksUri;
        if (typeof apps.tokenEndpoint === 'string') tokenEndpoint = apps.tokenEndpoint;
        if (typeof wellKnown.webOrigin === 'string') {
          try {
            webOrigin = new URL(wellKnown.webOrigin).origin;
          } catch {
            // ignore a malformed value
          }
        }
      } catch {
        // Older servers: the documented default paths.
      }
    }
    const document = await getJson(jwksUri);
    const keys = new Map<string, CryptoKey>();
    for (const jwk of Array.isArray(document.keys) ? document.keys : []) {
      if (!isObject(jwk) || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.kid !== 'string' || typeof jwk.x !== 'string') continue;
      try {
        keys.set(jwk.kid, await importVerifyKey(jwk as Jwk));
      } catch {
        // skip malformed keys
      }
    }
    return { jwksUri, tokenEndpoint, webOrigin, keys, fetchedAt: now(), refreshedAt: now() };
  };

  /** Issuer metadata and keys; refreshed after the cache time, or (at most once a minute) for an unknown `kid`. */
  const issuerKeys = async (issuer: string, kid?: string): Promise<IssuerKeys> => {
    let entry = issuers.get(issuer);
    if (!entry) {
      entry = loadIssuer(issuer);
      issuers.set(issuer, entry);
      entry.catch(() => issuers.delete(issuer));
    }
    let current = await entry;
    const stale = now() - current.fetchedAt > cacheMs;
    const unknownKid = kid !== undefined && !current.keys.has(kid) && now() - current.refreshedAt >= JWKS_REFRESH_MIN_SECONDS * 1000;
    if (stale || unknownKid) {
      const refreshed = loadIssuer(issuer, stale ? undefined : current);
      issuers.set(issuer, refreshed);
      try {
        current = await refreshed;
      } catch (error) {
        issuers.set(issuer, Promise.resolve({ ...current, refreshedAt: now() }));
        if (stale) throw error;
      }
    }
    return current;
  };

  const verify = async <T>(request: IncomingRequest): Promise<VerifiedRequest<T>> => {
    const headers = request.headers;
    const need = (name: string) => {
      const value = headerOf(headers, name);
      if (!value) throw new OlanServerError('missing_header', `The request has no ${name} header`);
      return value;
    };
    const webhookId = need(WEBHOOK_HEADERS.id);
    const timestampText = need(WEBHOOK_HEADERS.timestamp);
    const signatureHeader = need(WEBHOOK_HEADERS.signature);
    const issuer = normalizeIssuer(need(WEBHOOK_HEADERS.issuer));
    const keyId = need(WEBHOOK_HEADERS.keyId);
    const rawBody = await readBody(request);

    if (!issuerAllowed(issuer)) throw new OlanServerError('issuer_not_allowed', `Issuer ${issuer} is not in this app's issuers list`);
    let keys: IssuerKeys;
    try {
      keys = await issuerKeys(issuer, keyId);
    } catch (error) {
      throw new OlanServerError('jwks_unavailable', `Could not load the signing keys of ${issuer}: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    const key = keys.keys.get(keyId);
    if (!key) throw new OlanServerError('unknown_key', `${issuer} publishes no key "${keyId}"`);
    const signatures = signatureHeader
      .split(' ')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${SIGNATURE_VERSION},`))
      .map((part) => part.slice(SIGNATURE_VERSION.length + 1));
    const content = utf8(`${webhookId}.${timestampText}.${rawBody}`);
    let valid = false;
    for (const signature of signatures) {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = fromBase64(signature);
      } catch {
        continue;
      }
      if (await verifyEd25519(key, bytes, content)) {
        valid = true;
        break;
      }
    }
    if (!valid) throw new OlanServerError('invalid_signature', 'The webhook-signature does not verify');
    const timestamp = Number(timestampText);
    if (!/^\d+$/.test(timestampText) || Math.abs(now() / 1000 - timestamp) > tolerance) {
      throw new OlanServerError('timestamp_out_of_range', `webhook-timestamp is more than ${tolerance} s away from this server's clock`);
    }
    let body: T;
    try {
      body = JSON.parse(rawBody) as T;
    } catch {
      throw new OlanServerError('invalid_body', 'The body is not JSON', 400);
    }
    const attempt = headerOf(headers, WEBHOOK_HEADERS.attempt);
    return {
      issuer,
      keyId,
      webhookId,
      timestamp,
      installationId: headerOf(headers, WEBHOOK_HEADERS.installationId),
      eventType: headerOf(headers, WEBHOOK_HEADERS.eventType),
      attempt: attempt && /^\d+$/.test(attempt) ? Number(attempt) : null,
      rawBody,
      body,
    };
  };

  const createClientAssertion = async ({ issuer, installationId, userId }: { issuer: string; installationId: string; userId?: string }) => {
    const key = await signingKey();
    const iat = Math.floor(now() / 1000);
    const header = { alg: key.alg, kid: key.kid, typ: 'JWT' };
    const claims: Record<string, unknown> = {
      iss: options.appId,
      sub: options.appId,
      aud: `${normalizeIssuer(issuer)}/api/v2/apps/oauth/token`,
      iat,
      exp: iat + ASSERTION_LIFETIME_SECONDS,
      jti: crypto.randomUUID(),
      olan_installation_id: installationId,
      ...(userId ? { olan_user_id: userId } : {}),
    };
    const input = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
    return `${input}.${toBase64Url(await sign(key, utf8(input)))}`;
  };

  const getInstallationToken = async ({ issuer: rawIssuer, installationId, userId }: { issuer: string; installationId: string; userId?: string }) => {
    const issuer = normalizeIssuer(rawIssuer);
    if (!issuerAllowed(issuer)) throw new OlanServerError('issuer_not_allowed', `Issuer ${issuer} is not in this app's issuers list`);
    const cacheKey = `${issuer}\u0000${installationId}\u0000${userId ?? ''}`;
    const cached = tokens.get(cacheKey);
    if (cached && cached.expiresAt - 30_000 > now()) return cached;
    const epoch = tokenEpoch;
    let endpoint = `${issuer}/api/v2/apps/oauth/token`;
    try {
      endpoint = (await issuerKeys(issuer)).tokenEndpoint;
    } catch {
      // keep the default path
    }
    const assertion = await createClientAssertion({ issuer, installationId, userId });
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion }).toString(),
    });
    let payload: Record<string, unknown> = {};
    try {
      const value: unknown = await response.json();
      if (isObject(value)) payload = value;
    } catch {
      // not JSON
    }
    if (!response.ok || typeof payload.access_token !== 'string') {
      const code = typeof payload.error === 'string' ? payload.error : 'token_failed';
      const message = typeof payload.error_description === 'string' ? payload.error_description : `The token endpoint answered ${response.status}`;
      throw new OlanServerError(code, message, response.status || 502, payload);
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 300;
    const token: InstallationToken = {
      accessToken: payload.access_token,
      tokenType: 'Bearer',
      expiresIn,
      expiresAt: now() + expiresIn * 1000,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
      permissions: Array.isArray(payload.permissions) ? payload.permissions.filter((item): item is string => typeof item === 'string') : [],
    };
    if (epoch === tokenEpoch) tokens.set(cacheKey, token);
    return token;
  };

  const invalidateToken = (installationId: string, { issuer }: { issuer?: string } = {}) => {
    tokenEpoch++;
    const wanted = issuer === undefined ? null : normalizeIssuer(issuer);
    let dropped = 0;
    for (const key of [...tokens.keys()]) {
      const [keyIssuer, keyInstallation] = key.split('\u0000');
      if (keyInstallation !== installationId || (wanted !== null && keyIssuer !== wanted)) continue;
      tokens.delete(key);
      dropped++;
    }
    return dropped;
  };

  const clearTokenCache = () => {
    tokenEpoch++;
    tokens.clear();
  };

  const fetchOlan = async (target: { issuer: string; installationId: string; userId?: string }, path: string, init: RequestInit = {}) => {
    const issuer = normalizeIssuer(target.issuer);
    const url = new URL(path, `${issuer}/`);
    if (url.origin !== new URL(issuer).origin) throw new TypeError(`fetchOlan only calls the issuer ${issuer}, not ${url.origin}`);
    const send = async () => {
      const token = await getInstallationToken({ ...target, issuer });
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token.accessToken}`);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      return doFetch(url.toString(), { ...init, headers });
    };
    const response = await send();
    if (response.status !== 403) return response;
    let code: unknown;
    try {
      const body: unknown = await response.clone().json();
      if (isObject(body)) code = body.error;
    } catch {
      // not JSON: not the guard's answer
    }
    if (typeof code !== 'string' || !STALE_TOKEN_ERRORS.includes(code)) return response;
    // The token may predate a version or consent change: once more with a fresh one, never again.
    invalidateToken(target.installationId, { issuer });
    return send();
  };

  const rejected = (error: unknown) => {
    if (error instanceof OlanServerError) return json(error.status, { error: error.code, message: error.message });
    return json(500, { error: 'internal_error' });
  };

  const handleToolCall = async (request: IncomingRequest, tools: Readonly<Record<string, ToolHandler>>) => {
    let verified: VerifiedRequest<AiToolCallRequest>;
    try {
      verified = await verify<AiToolCallRequest>(request);
    } catch (error) {
      return rejected(error);
    }
    const call = verified.body;
    if (!isObject(call) || call.id !== verified.webhookId || typeof call.tool !== 'string' || !isObject(call.input)) {
      return json(400, { error: 'invalid_body', message: 'Not an Olan tool call (id must equal webhook-id)' });
    }
    // The signature covers the body only: a call sent to another tool's URL must not run there.
    const urlTool = urlToolName(request);
    if (urlTool !== null && urlTool !== call.tool) {
      return json(400, { error: 'tool_mismatch', message: `The URL names the tool "${urlTool}" but the body calls "${call.tool}"` });
    }
    const handler = Object.prototype.hasOwnProperty.call(tools, call.tool) ? tools[call.tool] : undefined;
    if (!handler) return json(200, { ok: false, error: { code: 'unknown_tool', message: `This server has no tool "${call.tool}"` } });
    try {
      const output = await handler(call.input, {
        callId: call.id,
        tool: call.tool,
        installationId: call.installationId,
        appId: call.appId,
        issuer: verified.issuer,
        channel: call.channel,
        user: call.user,
        token: call.token,
      });
      if (!isObject(output) || !('result' in output)) throw new TypeError(`Tool "${call.tool}" must return { result, summary? }`);
      const body: Record<string, unknown> = { ok: true, result: output.result ?? null };
      if (typeof output.summary === 'string') body.summary = output.summary.slice(0, TOOL_SUMMARY_MAX);
      const text = JSON.stringify(body);
      if (utf8(text).length > TOOL_RESULT_MAX_BYTES) {
        return json(200, { ok: false, error: { code: 'result_too_large', message: `The result is larger than ${TOOL_RESULT_MAX_BYTES} bytes` } });
      }
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    } catch (error) {
      if (error instanceof ToolError) return json(200, { ok: false, error: { code: error.code, message: error.message } });
      return json(200, { ok: false, error: { code: 'tool_failed', message: error instanceof Error ? error.message : 'The tool failed' } });
    }
  };

  const handleEvent = async (request: IncomingRequest, handler: EventHandler | EventHandlers) => {
    let verified: VerifiedRequest<AnyAppEvent>;
    try {
      verified = await verify<AnyAppEvent>(request);
    } catch (error) {
      return rejected(error);
    }
    const event = verified.body;
    if (!isObject(event) || event.id !== verified.webhookId || typeof event.type !== 'string') {
      return json(400, { error: 'invalid_body', message: 'Not an Olan event (id must equal webhook-id)' });
    }
    // Before the handler, so a token it asks for already carries the new grant.
    if (TOKEN_INVALIDATING_EVENTS.includes(event.type)) {
      const installationId = typeof event.installationId === 'string' ? event.installationId : verified.installationId;
      if (installationId) invalidateToken(installationId, { issuer: verified.issuer });
    }
    if (idempotency && (await idempotency.has(verified.webhookId))) return json(200, { ok: true, duplicate: true });
    const run =
      typeof handler === 'function'
        ? handler
        : ((handler as Record<string, EventHandler | undefined>)[event.type] ?? (handler as Record<string, EventHandler | undefined>)['*']);
    try {
      if (run) await run(event, { issuer: verified.issuer, installationId: event.installationId, webhookId: verified.webhookId, attempt: verified.attempt });
    } catch (error) {
      // A non-2xx answer makes Olan retry with the same webhook-id.
      return json(500, { ok: false, error: error instanceof Error ? error.message : 'The handler failed' });
    }
    if (idempotency) await idempotency.add(verified.webhookId, WEBHOOK_ID_RETENTION_SECONDS);
    return json(200, { ok: true, ...(run ? {} : { ignored: true }) });
  };

  const handleCardAction = async (request: IncomingRequest, handler: CardActionHandler) => {
    let verified: VerifiedRequest<CardActionRequest>;
    try {
      verified = await verify<CardActionRequest>(request);
    } catch (error) {
      return rejected(error);
    }
    const action = verified.body;
    if (!isObject(action) || action.id !== verified.webhookId || typeof action.name !== 'string') {
      return json(400, { error: 'invalid_body', message: 'Not an Olan card action (id must equal webhook-id)' });
    }
    // Olan sends a card action once (5 s, no retries): a repeated `act_` id is a replay.
    if (idempotency) {
      if (await idempotency.has(verified.webhookId)) return json(409, { error: 'duplicate_request', message: 'This card action was already handled' });
      await idempotency.add(verified.webhookId, REQUEST_ID_RETENTION_SECONDS);
    }
    try {
      const answer = (await handler(action, { issuer: verified.issuer, webhookId: verified.webhookId })) ?? {};
      return json(200, answer);
    } catch (error) {
      return json(500, { error: 'card_action_failed', message: error instanceof Error ? error.message : 'The handler failed' });
    }
  };

  const handleRequest = async (request: IncomingRequest, router: RemoteRoutes | RemoteRequestHandler) => {
    let verified: VerifiedRequest<RemoteRequestEnvelope>;
    try {
      verified = await verify<RemoteRequestEnvelope>(request);
    } catch (error) {
      return rejected(error);
    }
    const envelope = verified.body as unknown;
    const inner = isObject(envelope) && isObject(envelope.request) ? envelope.request : null;
    if (
      !isObject(envelope) ||
      envelope.id !== verified.webhookId ||
      typeof envelope.installationId !== 'string' ||
      typeof envelope.appId !== 'string' ||
      !inner ||
      typeof inner.method !== 'string' ||
      typeof inner.path !== 'string' ||
      !inner.path.startsWith('/')
    ) {
      return json(400, { error: 'invalid_body', message: 'Not an Olan request (id must equal webhook-id)' });
    }
    // Apps map accounts by the envelope's issuer: it must be the issuer whose key signed.
    if (typeof envelope.issuer !== 'string') return json(400, { error: 'invalid_body', message: 'Not an Olan request (no issuer)' });
    if (normalizeIssuer(envelope.issuer) !== verified.issuer) {
      return json(401, { error: 'issuer_mismatch', message: `The envelope's issuer ${envelope.issuer} is not the olan-issuer ${verified.issuer}` });
    }
    if (idempotency) {
      if (await idempotency.has(verified.webhookId)) return json(409, { error: 'duplicate_request', message: 'This request id was already handled' });
      await idempotency.add(verified.webhookId, REQUEST_ID_RETENTION_SECONDS);
    }
    const user = isObject(envelope.user) && typeof envelope.user.id === 'string' ? (envelope.user as unknown as RemoteRequestUser) : null;
    const token = isObject(envelope.token) && typeof envelope.token.accessToken === 'string' ? (envelope.token as unknown as { accessToken: string; expiresIn: number }) : null;
    const answer = await runRemoteRoute(router, {
      id: verified.webhookId,
      issuer: verified.issuer,
      installationId: envelope.installationId,
      appId: envelope.appId,
      user,
      method: inner.method as NormalizedRemoteRequest['method'],
      path: inner.path,
      query: isObject(inner.query) ? (inner.query as Record<string, string | string[]>) : {},
      headers: isObject(inner.headers) ? (inner.headers as Record<string, string>) : {},
      body: (inner.body ?? null) as JsonValue,
      token,
      timeoutMs: typeof inner.timeoutMs === 'number' ? inner.timeoutMs : 30_000,
    });
    return json(200, answer);
  };

  const webOriginOf = async (rawIssuer: string): Promise<string> => {
    const issuer = normalizeIssuer(rawIssuer);
    if (!issuerAllowed(issuer)) throw new OlanServerError('issuer_not_allowed', `Issuer ${issuer} is not in this app's issuers list`);
    let keys: IssuerKeys;
    try {
      keys = await issuerKeys(issuer);
    } catch (error) {
      throw new OlanServerError('jwks_unavailable', `Could not load ${issuer}/.well-known/olan: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    if (!keys.webOrigin) throw new OlanServerError('web_origin_unknown', `${issuer}/.well-known/olan has no webOrigin (Olan before 1.5)`, 503);
    return keys.webOrigin;
  };

  const appReturnUrl = async ({ issuer, installationId }: { issuer: string; installationId: string }) =>
    `${await webOriginOf(issuer)}${APP_RETURN_PATH}${encodeURIComponent(installationId)}`;

  const isAppReturnUrl = async ({ issuer, installationId, url }: { issuer: string; installationId: string; url: string }) => {
    const expected = new URL(await appReturnUrl({ issuer, installationId }));
    try {
      const candidate = new URL(url);
      return candidate.origin === expected.origin && candidate.pathname === expected.pathname && !candidate.username && !candidate.password;
    } catch {
      return false;
    }
  };

  const jwks = async () => {
    const published = (key: SigningKey & { kid: string }) => ({ ...key.publicJwk, kid: key.kid, alg: key.alg, use: 'sig' }) as Jwk;
    const current = await signingKey();
    const keys: Jwk[] = [published(current)];
    if (options.nextPrivateKeyPem) {
      nextSigning ??= keyWithKid(options.nextPrivateKeyPem, options.nextKeyId);
      const next = await nextSigning;
      if (next.kid === current.kid) throw new TypeError('nextPrivateKeyPem needs a kid other than the current key\'s (nextKeyId)');
      keys.push(published(next));
    }
    for (const extra of options.additionalPublicKeys ?? []) {
      if (typeof extra?.kid !== 'string' || extra.kid.length === 0) throw new TypeError('additionalPublicKeys entries need a kid');
      if (keys.some((key) => key.kid === extra.kid)) continue;
      const publicJwk: Jwk = { ...extra };
      for (const member of PRIVATE_JWK_MEMBERS) delete publicJwk[member];
      keys.push(publicJwk);
    }
    return { keys };
  };

  return { verify, getInstallationToken, invalidateToken, clearTokenCache, fetchOlan, createClientAssertion, handleToolCall, handleEvent, handleCardAction, handleRequest, appReturnUrl, isAppReturnUrl, jwks };
}

/**
 * A new Ed25519 key for an app server: keep `privateKeyPem` secret (environment, secret store) and
 * serve `publicJwk` at the manifest `remote.jwksUrl` (or call `jwks()`).
 */
export async function generateAppKey(): Promise<{ privateKeyPem: string; publicJwk: Jwk & { kid: string; alg: AssertionAlgorithm; use: 'sig' }; keyId: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk: Jwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  const keyId = await jwkThumbprint(publicJwk);
  return { privateKeyPem: derToPem(pkcs8), publicJwk: { ...publicJwk, kid: keyId, alg: 'EdDSA', use: 'sig' }, keyId };
}

/** Minimal shape of Node's `IncomingMessage` (no `@types/node` needed). */
export interface NodeIncomingLike extends AsyncIterable<Uint8Array | string> {
  headers: Record<string, string | string[] | undefined>;
  /** `req.url` (the path): `handleToolCall` compares it with the body's tool. */
  url?: string;
}

/** Minimal shape of Node's `ServerResponse`. */
export interface NodeResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string | Uint8Array): unknown;
}

/** Reads a Node `IncomingMessage` into `{ headers, body, url? }` (the raw body, as signed). Limit 1 MiB by default. */
export async function fromNodeRequest(
  request: NodeIncomingLike,
  options: { maxBytes?: number } = {},
): Promise<{ headers: Record<string, string | string[] | undefined>; body: Uint8Array; url?: string }> {
  const max = options.maxBytes ?? 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? utf8(chunk) : chunk;
    size += bytes.length;
    if (size > max) throw new OlanServerError('invalid_body', `The body is larger than ${max} bytes`, 413);
    chunks.push(bytes);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { headers: request.headers, body, ...(typeof request.url === 'string' ? { url: request.url } : {}) };
}

/** Writes a WHATWG `Response` (from the handlers) to a Node `ServerResponse`. */
export async function sendNodeResponse(target: NodeResponseLike, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  target.writeHead(response.status, headers);
  target.end(new Uint8Array(await response.arrayBuffer()));
}

/** A card answer for `handleCardAction` (typing helper). */
export function cardResponse(card?: AppCard, toast?: CardActionResponse['toast']): CardActionResponse {
  return { ...(card ? { card } : {}), ...(toast ? { toast } : {}) };
}
