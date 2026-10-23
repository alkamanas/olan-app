import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

import { PROFILE_REQUIRED } from '@olan-app/sdk/server';

import { createMediaDeskServer, type MediaDeskServer } from '../remote-server/server.ts';

/*
 * The app server in-process, against a fake Olan issuer (its own Ed25519 key, `/.well-known/olan`
 * with `webOrigin`, the JWKS) reached through the `fetch` the server is given. Requests are signed
 * exactly as Olan signs `POST {remote.url}/requests` (Phase 5a contract §1.4).
 */

const ISSUER = 'https://olan.test';
const WEB_ORIGIN = 'https://web.olan.test';
const KID = 'olan-test-1';
const INSTALLATION = '6d3f8e2a-0c4b-4f7e-9a51-3b2c1d0e9f87';
const USER = '0b7a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const PUBLIC_URL = 'http://127.0.0.1:4419';

type Pair = { privateKey: CryptoKey; publicKey: CryptoKey };
const generate = async () => (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as Pair;

let olanKey: Pair;
let otherKey: Pair;
let dataDir: string;
let server: MediaDeskServer;
let counter = 0;

async function fakeOlan(input: Parameters<typeof fetch>[0]): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== ISSUER) throw new Error(`unexpected fetch ${url.href}`);
  if (url.pathname === '/.well-known/olan') return Response.json({ webOrigin: WEB_ORIGIN, apps: { jwksUri: `${ISSUER}/api/v2/apps/jwks.json`, tokenEndpoint: `${ISSUER}/api/v2/apps/oauth/token` } });
  if (url.pathname === '/api/v2/apps/jwks.json') {
    const jwk = await crypto.subtle.exportKey('jwk', olanKey.publicKey);
    return Response.json({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: KID, alg: 'EdDSA', use: 'sig' }] });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: Record<string, unknown>;
}

/** Runs one request through `server.handle` with Node-like request/response objects. */
async function call(method: string, path: string, body: string | Uint8Array = '', headers: Record<string, string> = {}): Promise<Answer> {
  const chunks = typeof body === 'string' ? (body ? [Buffer.from(body)] : []) : [Buffer.from(body)];
  const request = Object.assign(Readable.from(chunks), { method, url: path, headers: { 'content-type': 'application/json', ...headers } }) as unknown as IncomingMessage;
  let status = 0;
  let sent: Record<string, string> = {};
  let text = '';
  const response = {
    writeHead(code: number, values?: Record<string, string>) {
      status = code;
      sent = Object.fromEntries(Object.entries(values ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
      return response;
    },
    end(chunk?: Uint8Array | string) {
      text = chunk === undefined ? '' : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return response;
    },
  } as unknown as ServerResponse;
  await server.handle(request, response);
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // not JSON (HTML, media)
  }
  return { status, headers: sent, text, json };
}

interface SignOptions {
  key?: CryptoKey;
  timestamp?: number;
  issuer?: string;
  id?: string;
  /** The envelope's `id` when it should differ from `webhook-id`. */
  bodyId?: string;
  user?: Record<string, unknown> | null;
}

/** `olan.remote.request` as Olan delivers it: the signed envelope to `{remote.url}/requests`. */
async function remoteRequest(request: { method: string; path: string; body?: unknown; query?: Record<string, string | string[]> }, options: SignOptions = {}) {
  counter += 1;
  const id = options.id ?? `req_00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const envelope = {
    id: options.bodyId ?? id,
    issuer: options.issuer ?? ISSUER,
    installationId: INSTALLATION,
    appId: 'com.olan.examples.media-desk',
    ...(options.user === null
      ? {}
      : { user: options.user ?? { id: USER, organizationId: '9c8b7a6d-5e4f-4321-8abc-def012345678', locale: 'tr', timeZone: 'Europe/Istanbul', email: 'utku@example.com', displayName: 'Utku Gökcan', role: 'member' } }),
    request: { method: request.method, path: request.path, query: request.query ?? {}, headers: {}, body: request.body ?? null, timeoutMs: 30000 },
    token: { accessToken: 'embedded-token', expiresIn: 300 },
  };
  const raw = JSON.stringify(envelope);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = await crypto.subtle.sign('Ed25519', options.key ?? olanKey.privateKey, new TextEncoder().encode(`${id}.${timestamp}.${raw}`));
  return call('POST', '/olan/requests', raw, {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1a,${Buffer.from(signature).toString('base64')}`,
    'olan-issuer': options.issuer ?? ISSUER,
    'olan-key-id': KID,
    'olan-installation-id': INSTALLATION,
  });
}

const newItem = { title: 'Ekim kampanyası', caption: 'Yeni sezon', channels: ['instagram', 'tiktok'], publishNow: false, fileName: 'kampanya.jpg', type: 'image/jpeg', size: 10 };

before(async () => {
  olanKey = await generate();
  otherKey = await generate();
  dataDir = mkdtempSync(join(tmpdir(), 'media-desk-'));
  server = await createMediaDeskServer({ issuers: [ISSUER], dataDir, publicUrl: PUBLIC_URL, webOrigins: [WEB_ORIGIN], processingMs: 10, fetch: fakeOlan as typeof fetch });
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('serves its JWKS and health', async () => {
  const jwks = await call('GET', '/.well-known/jwks.json');
  const keys = jwks.json.keys as { kid: string; crv: string }[];
  assert.equal(keys[0]?.kid, server.keyId);
  assert.equal(keys[0]?.crv, 'Ed25519');
  assert.equal((await call('GET', '/health')).json.ok, true);
});

test('answers verified requests with HTTP 200 and the { status, headers, body } wrapper', async () => {
  const empty = await remoteRequest({ method: 'GET', path: '/items' });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.status, 200);
  assert.deepEqual(empty.json.body, { items: [] });

  const created = await remoteRequest({ method: 'POST', path: '/items', body: newItem });
  assert.equal(created.status, 200);
  assert.equal(created.json.status, 201);
  const body = created.json.body as { item: { id: string; status: string; ownerName: string; ownerId: string }; upload: { url: string; method: string } };
  assert.equal(body.item.status, 'awaiting_upload');
  // `displayName` came in the envelope (`profile:read`).
  assert.equal(body.item.ownerName, 'Utku Gökcan');
  assert.equal(body.item.ownerId, USER);
  assert.equal(body.upload.method, 'PUT');
  assert.match(body.upload.url, new RegExp(`^${PUBLIC_URL}/olan/uploads/${body.item.id}\\?token=`));

  const listed = await remoteRequest({ method: 'GET', path: '/items' });
  assert.equal((listed.json.body as { items: unknown[] }).items.length, 1);
  assert.match((listed.json.headers as { etag: string }).etag, /^"1-a"$/);
});

test('route errors stay inside the wrapper: 404 unknown_route, 405, RequestError statuses', async () => {
  const unknown = await remoteRequest({ method: 'GET', path: '/nope' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.status, 404);
  assert.equal((unknown.json.body as { error: string }).error, 'unknown_route');

  const wrongMethod = await remoteRequest({ method: 'PATCH', path: '/items' });
  assert.equal(wrongMethod.json.status, 405);
  assert.equal((wrongMethod.json.body as { error: string }).error, 'method_not_allowed');

  const missing = await remoteRequest({ method: 'GET', path: '/items/m_missing' });
  assert.deepEqual(missing.json, { status: 404, body: { error: 'item_not_found', message: 'Medya bulunamadı' } });

  const invalid = await remoteRequest({ method: 'POST', path: '/items', body: { ...newItem, title: ' ', channels: [] } });
  assert.deepEqual(invalid.json, { status: 422, body: { error: 'validation_failed', issues: { title: 'Başlık gerekli', channels: 'En az bir kanal seçin' } } });

  // An app-identity envelope (no `user`) never acts for a person.
  const noPerson = await remoteRequest({ method: 'GET', path: '/items' }, { user: null });
  assert.equal(noPerson.json.status, 403);
  assert.equal((noPerson.json.body as { error: string }).error, 'person_required');
});

test('rejects a forged signature, a stale timestamp and an unknown issuer with 401 (no wrapper)', async () => {
  const forged = await remoteRequest({ method: 'GET', path: '/items' }, { key: otherKey.privateKey });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.error, 'invalid_signature');
  assert.equal('status' in forged.json, false);

  const stale = await remoteRequest({ method: 'GET', path: '/items' }, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.error, 'timestamp_out_of_range');

  const issuer = await remoteRequest({ method: 'GET', path: '/items' }, { issuer: 'https://evil.example' });
  assert.equal(issuer.status, 401);
  assert.equal(issuer.json.error, 'issuer_not_allowed');
});

test('refuses an envelope whose id differs from webhook-id (400) and a repeated req_ id (409)', async () => {
  const mismatch = await remoteRequest({ method: 'GET', path: '/items' }, { id: 'req_mismatch-1', bodyId: 'req_other' });
  assert.equal(mismatch.status, 400);

  const first = await remoteRequest({ method: 'GET', path: '/items' }, { id: 'req_replay-1' });
  assert.equal(first.status, 200);
  const replay = await remoteRequest({ method: 'GET', path: '/items' }, { id: 'req_replay-1' });
  assert.equal(replay.status, 409);
  assert.equal(replay.json.error, 'duplicate_request');
});

test('takes the upload once (x-olan-file-name, CORS), then serves the media', async () => {
  const created = await remoteRequest({ method: 'POST', path: '/items', body: { ...newItem, fileName: 'eski-ad.jpg' } });
  const { item, upload } = created.json.body as { item: { id: string }; upload: { url: string } };
  const target = new URL(upload.url);
  const path = `${target.pathname}${target.search}`;

  const preflight = await call('OPTIONS', path, '', { origin: WEB_ORIGIN, 'access-control-request-method': 'PUT' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], WEB_ORIGIN);
  assert.match(preflight.headers['access-control-allow-headers']!, /x-olan-file-name/);
  assert.equal(preflight.headers['access-control-expose-headers'], 'etag, location');

  const bytes = new TextEncoder().encode('jpeg-bytes');
  const put = await call('PUT', path, bytes, { origin: WEB_ORIGIN, 'content-type': 'image/jpeg', 'x-olan-file-name': encodeURIComponent('Ekim görseli.jpg') });
  assert.equal(put.status, 201);
  assert.equal(put.headers['access-control-allow-origin'], WEB_ORIGIN);
  assert.equal(put.headers.location, `${PUBLIC_URL}/olan/media/${item.id}`);
  assert.ok(put.headers.etag);
  const saved = (put.json.item as { fileName: string; status: string; size: number });
  assert.equal(saved.fileName, 'Ekim görseli.jpg');
  assert.equal(saved.status, 'processing');
  assert.equal(saved.size, bytes.byteLength);

  // The token is single-use.
  assert.equal((await call('PUT', path, bytes)).status, 403);
  // Another origin gets no CORS headers.
  assert.equal((await call('OPTIONS', path, '', { origin: 'https://evil.example' })).headers['access-control-allow-origin'], undefined);

  const media = await call('GET', `/olan/media/${item.id}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers['content-type'], 'image/jpeg');
  assert.equal(media.text, 'jpeg-bytes');

  await new Promise((resolve) => setTimeout(resolve, 30));
  const after = await remoteRequest({ method: 'GET', path: `/items/${item.id}` });
  assert.equal((after.json.body as { item: { status: string } }).item.status, 'ready');
});

test('connects an account: return address from the issuer\'s webOrigin, sign-in page redirect, state checked once', async () => {
  const start = await remoteRequest({ method: 'POST', path: '/connections/start' });
  assert.equal(start.json.status, 201);
  const { authorizeUrl, state } = start.json.body as { authorizeUrl: string; state: string };
  const authorize = new URL(authorizeUrl);
  assert.equal(authorize.origin, PUBLIC_URL);
  assert.equal(authorize.pathname, '/oauth/authorize');
  const returnUrl = `${WEB_ORIGIN}/apps/return/${INSTALLATION}`;
  assert.equal(authorize.searchParams.get('return'), returnUrl);
  assert.equal(await server.olan.isAppReturnUrl({ issuer: ISSUER, installationId: INSTALLATION, url: returnUrl }), true);

  // The external page sends the person back to the app's return address.
  const page = await call('GET', `${authorize.pathname}${authorize.search}`);
  assert.equal(page.status, 302);
  const back = new URL(page.headers.location!);
  assert.equal(`${back.origin}${back.pathname}`, returnUrl);
  assert.equal(back.searchParams.get('state'), state);
  assert.equal(back.searchParams.get('connection'), 'connected');
  // A tampered return address is refused.
  const tampered = new URL(authorizeUrl);
  tampered.searchParams.set('return', 'https://evil.example/apps/return/x');
  assert.equal((await call('GET', `${tampered.pathname}${tampered.search}`)).status, 400);

  const params = Object.fromEntries(back.searchParams);
  const complete = await remoteRequest({ method: 'POST', path: '/connections/complete', body: params });
  assert.equal(complete.json.status, 200);
  assert.equal((complete.json.body as { connection: { account: string } }).connection.account, '@medya-masasi');
  const replay = await remoteRequest({ method: 'POST', path: '/connections/complete', body: params });
  assert.equal(replay.json.status, 400);
  assert.equal((replay.json.body as { error: string }).error, 'invalid_state');

  const state2 = await remoteRequest({ method: 'GET', path: '/connections' });
  assert.equal((state2.json.body as { connection: { account: string } }).connection.account, '@medya-masasi');
});

test('GET /me reports what profile:read shared', async () => {
  const withProfile = await remoteRequest({ method: 'GET', path: '/me' });
  assert.deepEqual(withProfile.json.body, { id: USER, displayName: 'Utku Gökcan', email: 'utku@example.com', role: 'member' });
  const without = await remoteRequest({ method: 'GET', path: '/me' }, { user: { id: USER, organizationId: 'org', locale: 'tr', timeZone: 'UTC' } });
  assert.deepEqual(without.json.body, { id: USER, displayName: null, email: null, role: null });
});

test('connecting an account without profile:read answers 409 profile_required', async () => {
  const start = await remoteRequest({ method: 'POST', path: '/connections/start' }, { user: { id: USER, organizationId: 'org', locale: 'tr', timeZone: 'UTC' } });
  assert.equal(start.status, 200);
  assert.equal(start.json.status, 409);
  assert.equal((start.json.body as { error: string }).error, PROFILE_REQUIRED);
});
