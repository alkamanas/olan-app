import { createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import {
  AI_TOOL_LIMITS,
  APP_TOKEN_PATH,
  APPS_JWKS_MAX_AGE_SECONDS,
  APPS_JWKS_PATH,
  EVENT_DATA_VERSION,
  EVENT_TYPES,
  MAX_PACKAGE_BYTES,
  PERMISSIONS,
  REMOTE_REQUEST_ID_PREFIX,
  REMOTE_REQUEST_LIMITS,
  SURFACES,
  WEBHOOK_HEADERS,
  WELL_KNOWN_PATH,
  eventDefinition,
  formatWebhookSignature,
  parseRemoteAnswer,
  remoteEndpoint,
  remoteRequestOutcome,
  validateRemoteRequest,
  webhookSignedContent,
  type AiToolCallRequest,
  type EventType,
  type JsonValue,
  type OlanAppManifest,
  type RemoteErrorReason,
  type RemoteRequestEnvelope,
  type RemoteRequestInit,
  type RemoteRequestUser,
  type RemoteResponse,
} from '@olan-app/schema';

import { ensureDevKey } from './dev-key';
import { CliError, issue } from './errors';
import { DEFAULT_USER_ID, defaultFixtures, FIXTURE_NOW, loadProjectFixtures, mergeFixtures, MOCK_INSTALLATION_ID, normalizeFixtures, type NormalizedFixtures, type RemoteTransportResult } from './mock-server';

/*
 * Local stand-in for an Olan server towards an app's own server (Phase 3 §4.3, §5.3, §6): signs
 * requests with the development key (`olan-app keygen --dev`) and serves the matching
 * `/.well-known/olan` and JWKS while a request is in flight, so `@olan-app/sdk/server` verifies
 * them like production deliveries. The app server must list the dev issuer in `issuers`.
 */

/** Port of the development issuer (`http://127.0.0.1:5180`). */
export const DEV_ISSUER_PORT = 5180;
/** Installation id of development deliveries (`--installation` overrides it). */
export const DEV_INSTALLATION_ID = '00000000-0000-4000-8000-0000000000a1';
/** The embedded token of development tool calls and card actions: not accepted by any Olan server. */
export const DEV_EMBEDDED_TOKEN = 'olan-app-dev-token';

/**
 * A local Olan issuer: serves `/.well-known/olan` and the JWKS of its Ed25519 key on 127.0.0.1, and
 * signs with that key. `olan-app events send`, `tools call`, `requests send` and `dev --remote live`
 * use the development key (`startDevIssuer`); `createTestIssuer` of `@olan-app/cli/testing` a fresh key.
 */
export interface DevIssuer {
  /** `http://127.0.0.1:<port>`: put it in the app server's `issuers`. */
  issuer: string;
  keyId: string;
  /** Public JWK of the signing key (`{ kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' }`). */
  jwk: Record<string, string>;
  /** `/.well-known/olan` as this issuer serves it. */
  wellKnown(): Record<string, JsonValue>;
  /** Signs `${id}.${timestamp}.${body}` (Ed25519) and returns the base64 signature. */
  sign(content: string): string;
  close(): Promise<void>;
}

export interface IssuerKey {
  keyId: string;
  privateKey: KeyObject;
  jwk: Record<string, string>;
}

function devSigningKey(env: NodeJS.ProcessEnv): IssuerKey {
  const devKey = ensureDevKey(env);
  const privateKey = createPrivateKey({ key: Buffer.from(devKey.key.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const keyId = `olan-app-dev-${devKey.fingerprint}`;
  const x = Buffer.from(devKey.key.publicKey, 'base64').toString('base64url');
  return { keyId, privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x, kid: keyId, alg: 'EdDSA', use: 'sig' } };
}

/** A new Ed25519 key (tests, forged signatures). */
export function generateIssuerKey(keyId = `olan-test-${randomUUID().slice(0, 8)}`): IssuerKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  return { keyId, privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x, kid: keyId, alg: 'EdDSA', use: 'sig' } };
}

/** Feature flags of a 1.5 Olan server (`apps.features`). */
const LOCAL_FEATURES = ['db', 'record-writes', 'remote', 'events', 'ai-tools', 'pim-writes', 'project-writes', 'app-cards', 'remote-requests', 'files', 'external-return', 'app-links'];

/**
 * `/.well-known/olan` of a local issuer, with every field an Olan 1.5 server publishes
 * (server.md#well-known-olan). `webOrigin` (default: the issuer) is where `appReturnUrl` points.
 */
export function localWellKnown(issuer: string, options: { webOrigin?: string | null; serverVersion?: string } = {}): Record<string, JsonValue> {
  const webOrigin = options.webOrigin === null ? null : new URL(options.webOrigin ?? issuer).origin;
  return {
    apiVersion: 1,
    serverVersion: options.serverVersion ?? 'olan-app-dev',
    sdkVersions: ['^1.0.0'],
    apps: {
      enabled: true,
      maxPackageBytes: MAX_PACKAGE_BYTES,
      surfaces: [...SURFACES],
      permissions: PERMISSIONS.map((permission) => permission.id),
      trustedKeyFingerprints: [],
      builtInKeys: [],
      trustedKeys: [],
      features: [...LOCAL_FEATURES],
      issuer,
      jwksUri: `${issuer}${APPS_JWKS_PATH}`,
      tokenEndpoint: `${issuer}${APP_TOKEN_PATH}`,
      events: [...EVENT_TYPES],
      ...(webOrigin ? { returnUrlTemplate: `${webOrigin}/apps/return/{installationId}`, appUrlTemplate: `${webOrigin}/apps/a/{appId}` } : {}),
    },
    ...(webOrigin ? { webOrigin } : {}),
    catalogUrl: `${issuer}/api/v2/apps/catalog`,
    marketplaceUrl: null,
    revocationsUrl: `${issuer}/api/v2/apps/revocations`,
    marketplaceKeysUrl: `${issuer}/api/v2/apps/marketplace-keys`,
    issuer,
  };
}

export interface LocalIssuerOptions {
  key: IssuerKey;
  /** Default `DEV_ISSUER_PORT`; `0` picks a free port. */
  port?: number;
  /** `webOrigin` of `/.well-known/olan` (default: the issuer itself); `null` leaves it out (an Olan before 1.5). */
  webOrigin?: string | null;
  serverVersion?: string;
  /** The `remote.issuer_port` hint when the port is taken. */
  portHint?: string;
}

/**
 * Starts a local issuer on 127.0.0.1:`port`: `GET /.well-known/olan`, `GET /api/v2/apps/jwks.json`;
 * the token endpoint answers `unsupported_grant_type`.
 */
export async function startLocalIssuer(options: LocalIssuerOptions): Promise<DevIssuer> {
  const { key } = options;
  let issuer = '';
  let document: Record<string, JsonValue> = {};
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && path === WELL_KNOWN_PATH) {
      send(200, document);
    } else if (request.method === 'GET' && path === APPS_JWKS_PATH) {
      send(200, { keys: [key.jwk] }, { 'cache-control': `max-age=${APPS_JWKS_MAX_AGE_SECONDS}` });
    } else if (path === APP_TOKEN_PATH) {
      send(400, { error: 'unsupported_grant_type', error_description: 'This local issuer does not issue tokens; use a local Olan server for token requests.' });
    } else {
      send(404, { error: 'not_found' });
    }
  });
  const port = options.port ?? DEV_ISSUER_PORT;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      rejectListen(
        new CliError(
          issue('remote.issuer_port', `The local issuer could not listen on 127.0.0.1:${port}: ${error.message}`, {
            hint: options.portHint ?? 'Free the port or pass --issuer-port <port> (and add that issuer to the app server\'s issuers list).',
          }),
        ),
      );
    });
    server.listen(port, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
  document = localWellKnown(issuer, { ...(options.webOrigin !== undefined ? { webOrigin: options.webOrigin } : {}), ...(options.serverVersion ? { serverVersion: options.serverVersion } : {}) });
  return {
    issuer,
    keyId: key.keyId,
    jwk: key.jwk,
    wellKnown: () => structuredClone(document),
    sign: (content) => sign(null, Buffer.from(content, 'utf8'), key.privateKey).toString('base64'),
    close: () =>
      new Promise<void>((resolveClose) => {
        // fetch keeps connections alive: close them, or close() waits for their idle timeout.
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

/** The development issuer (your development key, `olan-app keygen --dev`) on 127.0.0.1:`port`. */
export async function startDevIssuer(options: { env: NodeJS.ProcessEnv; port?: number; webOrigin?: string | null }): Promise<DevIssuer> {
  return startLocalIssuer({ key: devSigningKey(options.env), port: options.port, ...(options.webOrigin !== undefined ? { webOrigin: options.webOrigin } : {}) });
}

// ---------------------------------------------------------------------------
// remote.request envelopes (Phase 5a §1.4)
// ---------------------------------------------------------------------------

export interface RemoteEnvelopeInput {
  appId: string;
  /** Default `DEV_INSTALLATION_ID`. */
  installationId?: string;
  /** The person (default: the mock user with organization, `tr`, `Europe/Istanbul`); `null`: an app-identity envelope without `user`. */
  user?: RemoteRequestUser | null;
  /** What the app passes to `olan.remote.request`: checked and normalised like Olan does. */
  request: RemoteRequestInit;
  /** Default `{ accessToken: DEV_EMBEDDED_TOKEN, expiresIn: 300 }`. */
  token?: { accessToken: string; expiresIn: number };
  /** `req_…` (default a new one). */
  id?: string;
}

export const DEV_ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000a1';

/** The signed body of `POST {remote.url}/requests`; throws `remote.request_invalid` for params Olan would refuse. */
export function remoteEnvelope(issuer: string, input: RemoteEnvelopeInput): RemoteRequestEnvelope {
  const checked = validateRemoteRequest(input.request);
  if (!checked.ok) throw new CliError(issue('remote.request_invalid', `${checked.code}: ${checked.message}`, { hint: 'The request must pass the rules of olan.remote.request (remote-requests.md#calling-it).' }));
  const user = input.user === undefined ? { id: DEFAULT_USER_ID, organizationId: DEV_ORGANIZATION_ID, locale: 'tr', timeZone: 'Europe/Istanbul' } : input.user;
  return {
    id: input.id ?? `${REMOTE_REQUEST_ID_PREFIX}${randomUUID()}`,
    issuer,
    installationId: input.installationId ?? DEV_INSTALLATION_ID,
    appId: input.appId,
    ...(user ? { user } : {}),
    request: checked.request,
    token: input.token ?? { accessToken: DEV_EMBEDDED_TOKEN, expiresIn: 300 },
  };
}

/** Header overrides for forged requests (tests). */
export interface SignEnvelopeOptions {
  /** `webhook-timestamp` in Unix seconds (default now); more than 300 s off → `timestamp_out_of_range`. */
  timestamp?: number;
  /** Sign with a key the issuer does not publish → `invalid_signature`. */
  badSignature?: boolean;
  /** `olan-key-id` (default the issuer's); an unpublished one → `unknown_key`. */
  keyId?: string;
  /** `olan-issuer` (default the issuer's); one the server does not list → `issuer_not_allowed`. */
  issuer?: string;
  /** `webhook-id` (default the envelope's `id`); another value → HTTP 400 `invalid_body`. */
  webhookId?: string;
}

/** The headers and exact body Olan posts for `envelope` (Standard Webhooks `v1a`, no event headers). */
export function signRemoteEnvelope(signer: Pick<DevIssuer, 'issuer' | 'keyId' | 'sign'>, envelope: RemoteRequestEnvelope, options: SignEnvelopeOptions = {}): { headers: Record<string, string>; body: string } {
  const body = JSON.stringify(envelope);
  const id = options.webhookId ?? envelope.id;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const content = webhookSignedContent(id, timestamp, body);
  const signature = options.badSignature ? sign(null, Buffer.from(content, 'utf8'), generateIssuerKey().privateKey).toString('base64') : signer.sign(content);
  return {
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_HEADERS.id]: id,
      [WEBHOOK_HEADERS.timestamp]: String(timestamp),
      [WEBHOOK_HEADERS.signature]: formatWebhookSignature([signature]),
      [WEBHOOK_HEADERS.issuer]: options.issuer ?? signer.issuer,
      [WEBHOOK_HEADERS.keyId]: options.keyId ?? signer.keyId,
      [WEBHOOK_HEADERS.installationId]: envelope.installationId,
    },
    body,
  };
}

/** What Olan makes of one forwarded request: the parsed wrapper, or why there was none. */
export type ForwardedRemoteRequest =
  | { ok: true; url: string; httpStatus: 200; durationMs: number; answer: RemoteResponse }
  | { ok: false; url: string; httpStatus: number | null; durationMs: number; reason: RemoteErrorReason; message: string; body: string };

/**
 * Posts a signed envelope to `{base}/requests` and reads the answer as Olan does (§1.5): HTTP 200
 * with the `{ status, headers?, body }` wrapper, ≤ 4 MiB, within `request.timeoutMs`. Never retried.
 */
export async function forwardRemoteRequest(signer: DevIssuer, base: string, envelope: RemoteRequestEnvelope): Promise<ForwardedRemoteRequest> {
  const url = remoteEndpoint(base, 'requests');
  const { headers, body } = signRemoteEnvelope(signer, envelope);
  const started = Date.now();
  const failed = (reason: RemoteErrorReason, message: string, httpStatus: number | null = null, text = ''): ForwardedRemoteRequest => ({ ok: false, url, httpStatus, durationMs: Date.now() - started, reason, message, body: text.slice(0, 4096) });
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { ...headers, 'user-agent': 'olan-app-dev' }, body, signal: AbortSignal.timeout(envelope.request.timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return failed('timeout', `${url} did not answer within ${envelope.request.timeoutMs} ms`);
    const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
    return failed('network', `POST ${url} failed: ${cause}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  if (bytes.byteLength > REMOTE_REQUEST_LIMITS.responseBytes) return failed('response_too_large', `${url} answered more than ${REMOTE_REQUEST_LIMITS.responseBytes} bytes`, response.status);
  if (response.status !== 200) return failed('http_status', `${url} answered HTTP ${response.status}`, response.status, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failed('invalid_response', `${url} answered something that is not JSON`, 200, text);
  }
  const answer = parseRemoteAnswer(parsed);
  if (!answer) return failed('invalid_response', `${url} answered JSON that is not { status (200–599), headers?, body? }`, 200, text);
  return { ok: true, url, httpStatus: 200, durationMs: Date.now() - started, answer };
}

export interface SendRequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  body?: JsonValue;
  headers?: Record<string, string>;
  timeoutMs?: number;
  to?: string;
  userId?: string;
  /** Add `email`, `displayName`, `role` as with `profile:read` (default: when the manifest asks for `profile:read`). */
  profile?: boolean;
  role?: 'admin' | 'member';
  installationId?: string;
  issuerPort?: number;
  env: NodeJS.ProcessEnv;
}

export interface SendRequestResult {
  envelope: RemoteRequestEnvelope;
  issuer: string;
  keyId: string;
  forwarded: ForwardedRemoteRequest;
  /** What `olan.remote.request` resolves or rejects with in the app. */
  outcome: { ok: true; result: RemoteResponse } | { ok: false; error: { code: string; message: string; details: JsonValue } };
  warnings: { code: string; message: string; hint?: string }[];
}

/** `olan-app requests send`: one signed `olan.remote.request` to `{remote.url}/requests`, read like Olan reads it. */
export async function sendDevRequest(projectDir: string, manifest: OlanAppManifest, options: SendRequestOptions): Promise<SendRequestResult> {
  const warnings: SendRequestResult['warnings'] = [];
  if (manifest.remote && manifest.remote.requests !== true) {
    warnings.push({ code: 'requests.not_enabled', message: 'olan-app.json "remote" has no "requests": true, so Olan refuses olan.remote.request (permission_denied)', hint: 'Add "requests": true to "remote".' });
  }
  const base = remoteBase(manifest, options.to);
  const fixtures = projectFixtures(projectDir);
  const userId = options.userId ?? DEFAULT_USER_ID;
  const profile = options.profile ?? manifest.permissions.includes('profile:read');
  const person = fixtures.users.find((user) => user.id === userId);
  const user: RemoteRequestUser = {
    id: userId,
    organizationId: DEV_ORGANIZATION_ID,
    locale: 'tr',
    timeZone: 'Europe/Istanbul',
    ...(profile && person ? { email: person.email, displayName: person.displayName } : {}),
    ...(profile ? { role: options.role ?? 'member' } : {}),
  };
  const request: RemoteRequestInit = {
    method: options.method.toUpperCase() as RemoteRequestInit['method'],
    path: options.path,
    ...(options.query ? { query: options.query } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  const issuer = await startDevIssuer({ env: options.env, port: options.issuerPort });
  try {
    const envelope = remoteEnvelope(issuer.issuer, { appId: manifest.id, installationId: options.installationId, user, request });
    const forwarded = await forwardRemoteRequest(issuer, base, envelope);
    const outcome: SendRequestResult['outcome'] = forwarded.ok
      ? (remoteRequestOutcome(forwarded.answer) as SendRequestResult['outcome'])
      : { ok: false, error: { code: 'remote_unavailable', message: forwarded.message, details: { status: 0, reason: forwarded.reason } } };
    return { envelope, issuer: issuer.issuer, keyId: issuer.keyId, forwarded, outcome, warnings };
  } finally {
    await issuer.close();
  }
}

/**
 * `olan-app dev --remote live`: the mock host's `olan.remote.request` goes to the real app server at
 * `remote.url`, signed by `issuer` (the development issuer), as `forwardRemoteRequest` reads it.
 */
export function liveRemoteTransport(issuer: DevIssuer, base: string, onRequest?: (line: string) => void): (envelope: RemoteRequestEnvelope) => Promise<RemoteTransportResult> {
  return async (envelope) => {
    const signed = { ...envelope, issuer: issuer.issuer, installationId: DEV_INSTALLATION_ID, token: { accessToken: DEV_EMBEDDED_TOKEN, expiresIn: 300 } };
    const forwarded = await forwardRemoteRequest(issuer, base, signed);
    onRequest?.(
      forwarded.ok
        ? `remote ${envelope.request.method} ${envelope.request.path} → ${forwarded.answer.status} (${forwarded.durationMs} ms)`
        : `remote ${envelope.request.method} ${envelope.request.path} → remote_unavailable ${forwarded.reason}: ${forwarded.message}${forwarded.httpStatus === 401 ? ` (does the app server list the issuer ${issuer.issuer}?)` : ''}`,
    );
    return forwarded.ok ? { ok: true, answer: forwarded.answer } : { ok: false, reason: forwarded.reason, message: forwarded.message };
  };
}

export interface SignedDelivery {
  url: string;
  status: number;
  ok: boolean;
  durationMs: number;
  /** At most 4 KiB of the response body. */
  body: string;
  headers: Record<string, string>;
  /** The JSON body when it parsed. */
  json?: unknown;
}

/** POSTs a signed request to the app server (Standard Webhooks `v1a` headers, §5.3). */
export async function sendSigned(
  issuer: DevIssuer,
  url: string,
  body: unknown,
  options: { id: string; installationId: string; eventType?: string; attempt?: number; timeoutMs: number; maxResponseBytes?: number },
): Promise<SignedDelivery> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'olan-app-dev',
    [WEBHOOK_HEADERS.id]: options.id,
    [WEBHOOK_HEADERS.timestamp]: String(timestamp),
    [WEBHOOK_HEADERS.signature]: formatWebhookSignature([issuer.sign(webhookSignedContent(options.id, timestamp, raw))]),
    [WEBHOOK_HEADERS.issuer]: issuer.issuer,
    [WEBHOOK_HEADERS.keyId]: issuer.keyId,
    [WEBHOOK_HEADERS.installationId]: options.installationId,
    ...(options.eventType ? { [WEBHOOK_HEADERS.eventType]: options.eventType, [WEBHOOK_HEADERS.attempt]: String(options.attempt ?? 1) } : {}),
  };
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (error) {
    const cause = error instanceof Error ? (error.name === 'TimeoutError' ? `no answer within ${options.timeoutMs} ms` : ((error.cause as Error | undefined)?.message ?? error.message)) : String(error);
    throw new CliError(issue('remote.unreachable', `POST ${url} failed: ${cause}`, { hint: 'Start the app server first and check remote.url (or --to).' }));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = options.maxResponseBytes ?? 4096;
  const text = new TextDecoder().decode(bytes.subarray(0, Math.max(limit, 4096)));
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    json = undefined;
  }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => (responseHeaders[name] = value));
  return {
    url,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - started,
    body: text.slice(0, 4096),
    headers: responseHeaders,
    ...(json !== undefined ? { json } : {}),
    ...(bytes.length > limit ? { tooLarge: true } : {}),
  } as SignedDelivery;
}

/** The base URL requests go to: `--to`, else the manifest `remote.url`. */
export function remoteBase(manifest: OlanAppManifest, to: string | undefined): string {
  const base = to ?? manifest.remote?.url;
  if (!base) {
    throw new CliError(issue('remote.missing', 'olan-app.json has no "remote" and no --to was given', { file: 'olan-app.json', hint: 'Add "remote": { "url": "http://127.0.0.1:4100/olan", "jwksUrl": "…" } or pass --to <url>.' }));
  }
  try {
    new URL(base);
  } catch {
    throw new CliError(issue('remote.invalid_url', `${base} is not a URL`));
  }
  return base;
}

function projectFixtures(projectDir: string): NormalizedFixtures {
  return normalizeFixtures(mergeFixtures(defaultFixtures(), loadProjectFixtures(projectDir)));
}

/** A plausible `data` for an event type, from the project's fixtures (`--data` replaces it). */
export function sampleEventData(type: EventType, data: NormalizedFixtures, manifest: Pick<OlanAppManifest, 'version' | 'permissions'>): JsonValue {
  const detail = data.projects[0];
  const task = detail?.tasks[0];
  const event = data.calendarEvents.find((candidate) => candidate.isOrganizer) ?? data.calendarEvents[0];
  const meeting = data.meetings[0];
  const conversationId = data.conversations[0]?.id ?? 'conversation-0';
  const message = (data.messages[conversationId] ?? []).at(-1);
  switch (type) {
    case 'app.installed':
    case 'app.updated':
      return { versionId: '00000000-0000-4000-8000-0000000000b1', version: manifest.version, scope: 'organization', grantedPermissions: [...manifest.permissions] };
    case 'app.uninstalled':
      return {};
    case 'app.consent.changed':
      return { userId: DEFAULT_USER_ID, permissions: [...manifest.permissions], declined: [] };
    case 'chat.message.created':
      return {
        conversationId,
        message: {
          id: message?.id ?? randomUUID(),
          body: message?.body ?? 'Yarın 10:00 standup',
          senderId: message?.sender.id ?? DEFAULT_USER_ID,
          senderKind: 'user',
          createdAt: message?.createdAt ?? new Date().toISOString(),
          replyToId: message?.replyToId ?? null,
          threadRootId: null,
          attachments: [],
        },
      };
    case 'project.task.created':
    case 'project.task.updated':
    case 'project.task.completed':
      return {
        projectId: detail?.project.id ?? 'p0',
        task: (type === 'project.task.completed' && task ? { ...task, status: 'completed' } : (task ?? { id: 't0', projectId: 'p0', title: 'Görev' })) as unknown as JsonValue,
        ...(type === 'project.task.created' ? {} : { changed: ['status'] }),
      };
    case 'project.task.deleted':
      return { projectId: detail?.project.id ?? 'p0', taskId: task?.id ?? 't0', title: task?.title ?? 'Görev' };
    // Phase 6 (second wave)
    case 'project.issue.opened':
    case 'project.issue.closed':
    case 'project.issue.triaged': {
      const projectId = detail?.project.id ?? 'p0';
      const issue = data.projectIssues[projectId]?.[0];
      const closed = type === 'project.issue.closed';
      return {
        projectId,
        issue: {
          id: issue?.id ?? 'i0',
          projectId,
          key: issue?.key ?? null,
          number: issue?.number ?? 1,
          title: issue?.title ?? 'Sorun',
          kind: issue?.kind ?? null,
          state: closed ? 'closed' : 'open',
          stateReason: closed ? 'completed' : null,
          priority: 0,
          assigneeId: null,
          labels: [],
          triagedAt: type === 'project.issue.opened' ? null : FIXTURE_NOW,
          createdAt: FIXTURE_NOW,
          updatedAt: FIXTURE_NOW,
        },
        ...(type === 'project.issue.triaged' ? { decision: 'accepted' } : {}),
      };
    }
    case 'project.approval.decided': {
      const projectId = detail?.project.id ?? 'p0';
      const approval = data.projectApprovals[projectId]?.[0];
      return {
        projectId,
        installationId: MOCK_INSTALLATION_ID,
        approvalId: approval?.id ?? 'approval-1',
        externalId: approval?.externalId ?? null,
        linkId: approval?.linkId ?? null,
        state: 'approved',
        decisions: [{ userId: DEFAULT_USER_ID, decision: 'approve', note: '', decidedAt: FIXTURE_NOW }],
      };
    }
    case 'calendar.event.created':
    case 'calendar.event.updated':
    case 'calendar.event.deleted':
      return {
        userId: DEFAULT_USER_ID,
        calendarId: event?.calendarId ?? 'cal-0',
        eventId: event?.id ?? 'ev-0',
        uid: event?.uid ?? 'ev-0@example.com',
        ...(type === 'calendar.event.deleted' || !event
          ? {}
          : { event: { title: event.title, start: event.start, end: event.end, timeZone: event.timeZone, isAllDay: event.isAllDay, location: event.location, status: 'confirmed' } }),
      };
    default:
      return {
        meetingId: meeting?.id ?? 'mt-0',
        slug: meeting?.slug ?? 'mt-0',
        title: meeting?.title ?? 'Toplantı',
        startsAt: meeting?.startsAt ?? new Date().toISOString(),
        endsAt: meeting?.endsAt ?? null,
        organizerId: meeting?.organizerId ?? DEFAULT_USER_ID,
        ...(meeting?.projectId ? { projectId: meeting.projectId } : {}),
      };
  }
}

export interface SendEventOptions {
  type: string;
  to?: string;
  data?: JsonValue;
  installationId?: string;
  attempt?: number;
  /** Reuse a `webhook-id` (a redelivery). */
  id?: string;
  issuerPort?: number;
  env: NodeJS.ProcessEnv;
}

export interface SendEventResult {
  event: Record<string, JsonValue>;
  issuer: string;
  keyId: string;
  delivery: SignedDelivery;
  warnings: { code: string; message: string; hint?: string }[];
}

/** `olan-app events send`: one signed event to `{remote.url}/events`. */
export async function sendDevEvent(projectDir: string, manifest: OlanAppManifest, options: SendEventOptions): Promise<SendEventResult> {
  const definition = eventDefinition(options.type);
  if (!definition) {
    throw new CliError(issue('events.unknown_type', `Unknown event "${options.type}"`, { hint: `Events: ${EVENT_TYPES.join(', ')}.` }));
  }
  const warnings: SendEventResult['warnings'] = [];
  if (definition.subscription && !(manifest.events ?? []).includes(definition.type)) {
    warnings.push({ code: 'events.not_subscribed', message: `olan-app.json "events" does not list "${definition.type}", so Olan would not send it`, hint: `Add "${definition.type}" to "events".` });
  }
  if (definition.permission && !manifest.permissions.includes(definition.permission)) {
    warnings.push({ code: 'events.permission_missing', message: `"${definition.type}" needs the "${definition.permission}" permission` });
  }
  const url = remoteEndpoint(remoteBase(manifest, options.to), 'events');
  const issuer = await startDevIssuer({ env: options.env, port: options.issuerPort });
  try {
    const installationId = options.installationId ?? DEV_INSTALLATION_ID;
    const event = {
      id: options.id ?? `evt_${randomUUID()}`,
      type: definition.type,
      version: EVENT_DATA_VERSION,
      occurredAt: new Date().toISOString(),
      issuer: issuer.issuer,
      installationId,
      appId: manifest.id,
      actor: definition.permission ? { kind: 'user', id: DEFAULT_USER_ID } : { kind: 'system' },
      data: options.data ?? sampleEventData(definition.type as EventType, projectFixtures(projectDir), manifest),
    } as Record<string, JsonValue>;
    const delivery = await sendSigned(issuer, url, event, { id: String(event.id), installationId, eventType: definition.type, attempt: options.attempt ?? 1, timeoutMs: 10_000 });
    return { event, issuer: issuer.issuer, keyId: issuer.keyId, delivery, warnings };
  } finally {
    await issuer.close();
  }
}

/**
 * Problems of a tool input against the tool's JSON Schema: required properties, property types
 * (`string`, `number`, `integer`, `boolean`, `array`, `object`, `null`), `enum`, and unknown
 * properties when `additionalProperties` is false. Enough to catch typos before the call.
 */
export function toolInputProblems(schema: Record<string, JsonValue>, input: unknown): string[] {
  const problems: string[] = [];
  const check = (definition: JsonValue | undefined, value: unknown, path: string) => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return;
    const types = Array.isArray(definition.type) ? definition.type : definition.type !== undefined ? [definition.type] : [];
    if (types.length > 0) {
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const matches = types.some((type) => type === actual || (type === 'integer' && Number.isInteger(value)) || (type === 'number' && typeof value === 'number'));
      if (!matches) {
        problems.push(`${path || 'input'} must be ${types.join(' or ')}`);
        return;
      }
    }
    if (Array.isArray(definition.enum) && !definition.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
      problems.push(`${path || 'input'} must be one of ${definition.enum.map((option) => JSON.stringify(option)).join(', ')}`);
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const properties = definition.properties && typeof definition.properties === 'object' && !Array.isArray(definition.properties) ? definition.properties : {};
      for (const name of Array.isArray(definition.required) ? definition.required : []) {
        if (typeof name === 'string' && !(name in value)) problems.push(`${path ? `${path}.` : ''}${name} is required`);
      }
      for (const [name, child] of Object.entries(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, name)) check((properties as Record<string, JsonValue>)[name], child, `${path ? `${path}.` : ''}${name}`);
        else if (definition.additionalProperties === false) problems.push(`${path ? `${path}.` : ''}${name} is not allowed`);
      }
    }
    if (Array.isArray(value) && definition.items) value.forEach((item, index) => check(definition.items, item, `${path}[${index}]`));
  };
  check(schema, input, '');
  return problems;
}

export interface CallToolOptions {
  name: string;
  input: Record<string, JsonValue>;
  to?: string;
  userId?: string;
  locale?: string;
  timeZone?: string;
  channel?: 'assistant' | 'mcp';
  installationId?: string;
  issuerPort?: number;
  env: NodeJS.ProcessEnv;
}

export interface CallToolResult {
  request: AiToolCallRequest;
  issuer: string;
  delivery: SignedDelivery;
  /** The parsed answer: `{ ok: true, result, summary? }` or `{ ok: false, error }`. */
  response: JsonValue;
}

/** `olan-app tools call`: one signed `ai-tools` call to the app server, checked like Olan checks it. */
export async function callDevTool(manifest: OlanAppManifest, options: CallToolOptions): Promise<CallToolResult> {
  const tools = manifest.ai?.tools ?? [];
  const tool = tools.find((candidate) => candidate.name === options.name);
  if (!tool) {
    throw new CliError(
      issue('tools.unknown_tool', `olan-app.json "ai.tools" has no tool "${options.name}"`, {
        file: 'olan-app.json',
        hint: tools.length ? `Tools: ${tools.map((candidate) => candidate.name).join(', ')}.` : 'Declare it in "ai": { "tools": [ … ] } (docs/server.md).',
      }),
    );
  }
  const problems = toolInputProblems(tool.input, options.input);
  if (problems.length > 0) {
    throw new CliError(problems.map((problem) => issue('tools.input_invalid', `${tool.name}: ${problem}`, { hint: 'The input must match the tool\'s "input" JSON Schema in olan-app.json.' })));
  }
  const url = remoteEndpoint(remoteBase(manifest, options.to), 'ai-tools', tool.name);
  const issuer = await startDevIssuer({ env: options.env, port: options.issuerPort });
  try {
    const request: AiToolCallRequest = {
      id: `call_${randomUUID()}`,
      tool: tool.name,
      installationId: options.installationId ?? DEV_INSTALLATION_ID,
      appId: manifest.id,
      issuer: issuer.issuer,
      channel: options.channel ?? 'assistant',
      user: { id: options.userId ?? DEFAULT_USER_ID, locale: options.locale ?? 'tr', timeZone: options.timeZone ?? 'Europe/Istanbul' },
      input: options.input,
      token: { accessToken: DEV_EMBEDDED_TOKEN, expiresIn: 300 },
    };
    const delivery = await sendSigned(issuer, url, request, { id: request.id, installationId: request.installationId, timeoutMs: AI_TOOL_LIMITS.timeoutMs, maxResponseBytes: AI_TOOL_LIMITS.resultBytes });
    const failures: string[] = [];
    if (delivery.status !== 200) failures.push(`answered HTTP ${delivery.status} (Olan reports app_tool_failed)`);
    if ((delivery as SignedDelivery & { tooLarge?: boolean }).tooLarge) failures.push(`answered more than ${AI_TOOL_LIMITS.resultBytes} bytes (app_tool_result_too_large)`);
    const body = delivery.json as Record<string, unknown> | undefined;
    if (delivery.status === 200 && (!body || typeof body !== 'object' || typeof body.ok !== 'boolean')) failures.push('did not answer { ok: true, result } or { ok: false, error: { code, message } }');
    if (body?.ok === true && !('result' in body)) failures.push('answered ok: true without "result"');
    if (body?.ok === false && (typeof (body.error as { code?: unknown } | undefined)?.code !== 'string')) failures.push('answered ok: false without error.code');
    if (typeof body?.summary === 'string' && body.summary.length > AI_TOOL_LIMITS.summaryMax) failures.push(`summary is longer than ${AI_TOOL_LIMITS.summaryMax} characters`);
    if (failures.length > 0) {
      throw new CliError(
        failures.map((failure) => issue('tools.response_invalid', `${tool.name}: ${url} ${failure}`, { hint: 'Answer HTTP 200 with { "ok": true, "result": … } (≤ 64 KiB); handleToolCall from @olan-app/sdk/server does this.' })),
        { request, delivery },
      );
    }
    return { request, issuer: issuer.issuer, delivery, response: body as JsonValue };
  } finally {
    await issuer.close();
  }
}
