import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  APP_TOKEN_PATH,
  CLIENT_ASSERTION_MAX_LIFETIME_SECONDS,
  CLIENT_ASSERTION_TYPE,
  OLAN_CLOUD_ISSUER,
  PROFILE_REQUIRED as SCHEMA_PROFILE_REQUIRED,
  REMOTE_REQUEST_LIMITS,
  WEBHOOK_HEADERS as SCHEMA_HEADERS,
  WEBHOOK_ID_RETENTION_SECONDS as SCHEMA_RETENTION,
  WEBHOOK_TOLERANCE_SECONDS as SCHEMA_TOLERANCE,
  clientAssertionAudience,
  type AiToolCallRequest,
} from '@olan-app/schema';
import { describe, expect, it } from 'vitest';

import { PROFILE_REQUIRED as SDK_PROFILE_REQUIRED } from '../src/api/rpc-client';
import {
  DEFAULT_ISSUERS,
  OlanServerError,
  PROFILE_REQUIRED,
  memoryIdempotencyStore,
  REQUEST_ID_RETENTION_SECONDS,
  RequestError,
  matchRemoteRoute,
  type RemoteRequestHandler,
  type RemoteRoutes,
  ToolError,
  WEBHOOK_HEADERS,
  WEBHOOK_ID_RETENTION_SECONDS,
  WEBHOOK_TOLERANCE_SECONDS,
  createOlanServer,
  fromNodeRequest,
  generateAppKey,
  sendNodeResponse,
  type EventHandlers,
  type OlanServerOptions,
  type ToolHandler,
} from '../src/server';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISSUER = 'https://olan.example.com';
const NOW = Date.UTC(2026, 9, 17, 9, 0, 0);
const APP_ID = 'com.example.team-standup';

/** A fake Olan server: its Ed25519 signing keys, JWKS, well-known and token endpoint. */
function fakeOlan() {
  const keys = new Map<string, KeyObject>();
  const published: Record<string, unknown>[] = [];
  const addKey = (kid: string) => {
    const pair = generateKeyPairSync('ed25519');
    keys.set(kid, pair.privateKey);
    published.push({ ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'EdDSA', use: 'sig' });
  };
  addKey('olan-apps-1');
  const requests: { url: string; body?: string }[] = [];
  let tokenHandler: (body: URLSearchParams) => Response = () => Response.json({ error: 'invalid_client' }, { status: 401 });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url === `${ISSUER}/.well-known/olan`) return Response.json({ webOrigin: 'https://web.olan.example.com/', apps: { jwksUri: `${ISSUER}/api/v2/apps/jwks.json`, tokenEndpoint: `${ISSUER}${APP_TOKEN_PATH}` } });
    if (url === `${ISSUER}/api/v2/apps/jwks.json`) return Response.json({ keys: published });
    if (url === `${ISSUER}${APP_TOKEN_PATH}`) return tokenHandler(new URLSearchParams(String(init?.body ?? '')));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const signed = (body: unknown, options: { id?: string; kid?: string; timestamp?: number; issuer?: string; extraKids?: string[]; tamper?: boolean; headers?: Record<string, string>; url?: string } = {}) => {
    const raw = JSON.stringify(body);
    const id = options.id ?? (body as { id?: string }).id ?? 'evt_1';
    const timestamp = options.timestamp ?? Math.floor(NOW / 1000);
    const kids = [options.kid ?? 'olan-apps-1', ...(options.extraKids ?? [])];
    const signatures = kids.map((kid) => `v1a,${nodeSign(null, Buffer.from(`${id}.${timestamp}.${raw}`), keys.get(kid)!).toString('base64')}`);
    return new Request(options.url ?? 'https://app.example.com/olan/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signatures.join(' '),
        'olan-issuer': options.issuer ?? ISSUER,
        'olan-key-id': options.kid ?? 'olan-apps-1',
        'olan-installation-id': 'inst-1',
        ...(options.headers ?? {}),
      },
      body: options.tamper ? raw.replace('}', ',"x":1}') : raw,
    });
  };
  return {
    fetch: fetchImpl,
    addKey,
    signed,
    requests,
    setTokenHandler(handler: (body: URLSearchParams) => Response) {
      tokenHandler = handler;
    },
  };
}

function server(olan: ReturnType<typeof fakeOlan>, extra: Partial<OlanServerOptions> = {}) {
  let clock = NOW;
  const instance = createOlanServer({ appId: APP_ID, issuers: [ISSUER], fetch: olan.fetch, now: () => clock, ...extra });
  return { instance, advance: (ms: number) => (clock += ms) };
}

const event = (id = 'evt_11111111-1111-4111-8111-111111111111') => ({
  id,
  type: 'project.task.created',
  version: 1,
  occurredAt: '2026-10-17T09:00:00Z',
  issuer: ISSUER,
  installationId: 'inst-1',
  appId: APP_ID,
  actor: { kind: 'user', id: 'u1' },
  data: { projectId: 'p1', task: { id: 't1', projectId: 'p1', title: 'Yaz' } },
});

async function failure(promise: Promise<unknown>): Promise<OlanServerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OlanServerError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('@olan-app/sdk/server', () => {
  it('repeats the app-schema constants exactly', () => {
    expect(WEBHOOK_HEADERS).toEqual(SCHEMA_HEADERS);
    expect(WEBHOOK_TOLERANCE_SECONDS).toBe(SCHEMA_TOLERANCE);
    expect(WEBHOOK_ID_RETENTION_SECONDS).toBe(SCHEMA_RETENTION);
    expect(PROFILE_REQUIRED).toBe(SCHEMA_PROFILE_REQUIRED);
    expect(SDK_PROFILE_REQUIRED).toBe(SCHEMA_PROFILE_REQUIRED);
    expect(PROFILE_REQUIRED).toBe('profile_required');
  });

  it('verifies a signed request (issuer → kid → signature → timestamp)', async () => {
    const olan = fakeOlan();
    const { instance } = server(olan);
    const verified = await instance.verify(olan.signed(event(), { headers: { 'olan-event-type': 'project.task.created', 'olan-delivery-attempt': '2' } }));
    expect(verified).toMatchObject({ issuer: ISSUER, keyId: 'olan-apps-1', installationId: 'inst-1', eventType: 'project.task.created', attempt: 2 });
    expect((verified.body as { data: { projectId: string } }).data.projectId).toBe('p1');
    // Discovery and JWKS are cached.
    await instance.verify(olan.signed(event('evt_2')));
    expect(olan.requests.filter((request) => request.url.endsWith('jwks.json'))).toHaveLength(1);
  });

  it('rejects other issuers, bad signatures, unknown keys and old timestamps', async () => {
    const olan = fakeOlan();
    const { instance } = server(olan);
    expect((await failure(instance.verify(olan.signed(event(), { issuer: 'https://evil.example.com' })))).code).toBe('issuer_not_allowed');
    expect((await failure(instance.verify(olan.signed(event(), { tamper: true })))).code).toBe('invalid_signature');
    expect((await failure(instance.verify(olan.signed(event(), { timestamp: Math.floor(NOW / 1000) - 301 })))).code).toBe('timestamp_out_of_range');
    const missing = olan.signed(event());
    missing.headers.delete('webhook-signature');
    expect((await failure(instance.verify(missing))).code).toBe('missing_header');
    // The default allowlist is Olan's cloud only (G20).
    const strict = createOlanServer({ appId: APP_ID, fetch: olan.fetch, now: () => NOW });
    expect((await failure(strict.verify(olan.signed(event())))).code).toBe('issuer_not_allowed');
  });

  it('picks up a rotated key (unknown kid refreshes the JWKS at most once a minute)', async () => {
    const olan = fakeOlan();
    const { instance, advance } = server(olan);
    await instance.verify(olan.signed(event()));
    olan.addKey('olan-apps-2');
    // Right after a fetch the unknown kid does not refetch yet.
    expect((await failure(instance.verify(olan.signed(event(), { kid: 'olan-apps-2' })))).code).toBe('unknown_key');
    advance(61_000);
    const verified = await instance.verify(olan.signed(event(), { kid: 'olan-apps-2', timestamp: Math.floor((NOW + 61_000) / 1000) }));
    expect(verified.keyId).toBe('olan-apps-2');
    // During rotation two signatures may travel; one valid one is enough.
    await instance.verify(olan.signed(event(), { kid: 'olan-apps-2', extraKids: ['olan-apps-1'], timestamp: Math.floor((NOW + 61_000) / 1000) }));
  });

  it('handles events once per webhook-id and lets failures be retried', async () => {
    const olan = fakeOlan();
    const { instance } = server(olan);
    const seen: string[] = [];
    let fail = true;
    const handlers: EventHandlers = {
      'project.task.created': async (incoming) => {
        if (fail) throw new Error('database down');
        seen.push(String(incoming.data.task.title));
      },
    };
    const first = await instance.handleEvent(olan.signed(event()), handlers);
    expect(first.status).toBe(500);
    fail = false;
    const retry = await instance.handleEvent(olan.signed(event()), handlers);
    expect(retry.status).toBe(200);
    const duplicate = await instance.handleEvent(olan.signed(event()), handlers);
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true });
    expect(seen).toEqual(['Yaz']);
    const other = await instance.handleEvent(olan.signed({ ...event('evt_3'), type: 'app.installed', data: {} }), handlers);
    expect(await other.json()).toEqual({ ok: true, ignored: true });
    const forged = await instance.handleEvent(olan.signed(event(), { tamper: true }), handlers);
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ error: 'invalid_signature' });
    const mismatched = await instance.handleEvent(olan.signed(event('evt_9'), { id: 'evt_other' }), handlers);
    expect(mismatched.status).toBe(400);
  });

  it('runs tool calls and answers the §6 response shapes', async () => {
    const olan = fakeOlan();
    const { instance } = server(olan);
    const call = (tool: string, input: Record<string, unknown> = {}): AiToolCallRequest => ({
      id: `call_${tool}`,
      tool,
      installationId: 'inst-1',
      appId: APP_ID,
      issuer: ISSUER,
      channel: 'assistant',
      user: { id: 'u1', locale: 'tr', timeZone: 'Europe/Istanbul' },
      input: input as AiToolCallRequest['input'],
      token: { accessToken: 'embedded', expiresIn: 300 },
    });
    const tools: Record<string, ToolHandler> = {
      standup_summary: async (input, context) => ({
        result: { project: input.projectId ?? null, token: context.token.accessToken, user: context.user.id },
        summary: 'x'.repeat(600),
      }),
      fails: async () => {
        throw new ToolError('not_found', 'No such project');
      },
      huge: async () => ({ result: 'x'.repeat(70_000) }),
    };
    const ok = await (await instance.handleToolCall(olan.signed(call('standup_summary', { projectId: 'p1' })), tools)).json();
    expect(ok).toMatchObject({ ok: true, result: { project: 'p1', token: 'embedded', user: 'u1' } });
    expect(ok.summary).toHaveLength(500);
    expect(await (await instance.handleToolCall(olan.signed(call('fails')), tools)).json()).toEqual({ ok: false, error: { code: 'not_found', message: 'No such project' } });
    expect(await (await instance.handleToolCall(olan.signed(call('huge')), tools)).json()).toMatchObject({ ok: false, error: { code: 'result_too_large' } });
    expect(await (await instance.handleToolCall(olan.signed(call('nope')), tools)).json()).toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
    expect((await instance.handleToolCall(olan.signed(call('standup_summary'), { tamper: true }), tools)).status).toBe(401);
  });

  it('refuses a tool call whose URL names another tool (EK3-2)', async () => {
    const olan = fakeOlan();
    const { instance } = server(olan);
    const ran: string[] = [];
    const tools: Record<string, ToolHandler> = {
      standup_summary: async () => {
        ran.push('standup_summary');
        return { result: 'summary' };
      },
      delete_everything: async () => {
        ran.push('delete_everything');
        return { result: 'gone' };
      },
    };
    const call = (tool: string, id = `call_${tool}`): AiToolCallRequest => ({
      id, tool, installationId: 'inst-1', appId: APP_ID, issuer: ISSUER, channel: 'assistant',
      user: { id: 'u1', locale: 'tr', timeZone: 'Europe/Istanbul' }, input: {}, token: { accessToken: 't', expiresIn: 300 },
    });
    const base = 'https://app.example.com/olan/ai-tools';
    // A signed body for one tool posted to another tool's URL.
    const moved = await instance.handleToolCall(olan.signed(call('delete_everything'), { url: `${base}/standup_summary` }), tools);
    expect(moved.status).toBe(400);
    expect(await moved.json()).toMatchObject({ error: 'tool_mismatch' });
    expect(ran).toEqual([]);
    // Matching names run (also with a trailing slash, an encoded name and a query).
    expect(await (await instance.handleToolCall(olan.signed(call('standup_summary', 'call_a'), { url: `${base}/standup_summary` }), tools)).json()).toMatchObject({ ok: true, result: 'summary' });
    expect((await instance.handleToolCall(olan.signed(call('standup_summary', 'call_b'), { url: `${base}/standup%5Fsummary/?x=1` }), tools)).status).toBe(200);
    // Node requests keep req.url (a path) through fromNodeRequest.
    const request = olan.signed(call('standup_summary', 'call_c'));
    const text = await request.clone().text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value));
    const node = await fromNodeRequest(Object.assign((async function* () { yield text; })(), { headers, url: '/olan/ai-tools/delete_everything' }));
    expect(node.url).toBe('/olan/ai-tools/delete_everything');
    expect(await (await instance.handleToolCall(node, tools)).json()).toMatchObject({ error: 'tool_mismatch' });
    // Without a URL (or one without an /ai-tools/ segment) the body decides, as before.
    expect((await instance.handleToolCall({ headers, body: text }, tools)).status).toBe(200);
    expect(ran).toEqual(['standup_summary', 'standup_summary', 'standup_summary']);
  });

  it('answers card actions and refuses a replayed act_ id (EK3-3)', async () => {
    const olan = fakeOlan();
    const { instance } = server(olan);
    const action = { id: 'act_1', issuer: ISSUER, installationId: 'inst-1', user: { id: 'u1', locale: 'tr' }, conversationId: 'c1', messageId: 'm1', name: 'done', payload: { day: 1 }, token: { accessToken: 't', expiresIn: 300 } };
    let runs = 0;
    const handler = async (incoming: { name: string }) => {
      runs++;
      return { toast: { text: `ok ${incoming.name}` } };
    };
    const response = await instance.handleCardAction(olan.signed(action), handler);
    expect(await response.json()).toEqual({ toast: { text: 'ok done' } });
    const replay = await instance.handleCardAction(olan.signed(action), handler);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: 'duplicate_request' });
    expect(runs).toBe(1);
    expect((await instance.handleCardAction(olan.signed({ ...action, id: 'act_2' }), handler)).status).toBe(200);
    // A shared store sees the id across instances (several processes); `false` turns it off.
    const store = memoryIdempotencyStore(() => NOW);
    const first = server(olan, { idempotency: store }).instance;
    const second = server(olan, { idempotency: store }).instance;
    expect((await first.handleCardAction(olan.signed({ ...action, id: 'act_3' }), handler)).status).toBe(200);
    expect((await second.handleCardAction(olan.signed({ ...action, id: 'act_3' }), handler)).status).toBe(409);
    const unchecked = server(olan, { idempotency: false }).instance;
    expect((await unchecked.handleCardAction(olan.signed(action), handler)).status).toBe(200);
    expect((await unchecked.handleCardAction(olan.signed(action), handler)).status).toBe(200);
    // The id is remembered for REQUEST_ID_RETENTION_SECONDS (beyond the ±5 min timestamp window).
    const timed = server(olan);
    expect((await timed.instance.handleCardAction(olan.signed({ ...action, id: 'act_4' }), handler)).status).toBe(200);
    timed.advance(REQUEST_ID_RETENTION_SECONDS * 1000 + 1000);
    const late = await timed.instance.handleCardAction(olan.signed({ ...action, id: 'act_4' }), handler);
    expect(await late.json()).toMatchObject({ error: 'timestamp_out_of_range' });
  });

  it('publishes the next key and extra public keys for rotation, signing with the current one (EK3-4)', async () => {
    const olan = fakeOlan();
    const current = await generateAppKey();
    const next = await generateAppKey();
    const retired = await generateAppKey();
    // Step 1: the next key is published, the current one still signs.
    const step1 = server(olan, { privateKeyPem: current.privateKeyPem, keyId: 'k1', nextPrivateKeyPem: next.privateKeyPem, nextKeyId: 'k2' }).instance;
    const published = await step1.jwks();
    expect(published.keys.map((key) => key.kid)).toEqual(['k1', 'k2']);
    expect(published.keys[1]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', x: next.publicJwk.x, alg: 'EdDSA', use: 'sig' });
    expect(JSON.stringify(published)).not.toContain('"d"');
    const header = (assertion: string) => JSON.parse(Buffer.from(assertion.split('.')[0]!, 'base64url').toString()) as { kid: string };
    expect(header(await step1.createClientAssertion({ issuer: ISSUER, installationId: 'inst-1' })).kid).toBe('k1');
    // Default kids are the thumbprints.
    expect((await server(olan, { privateKeyPem: current.privateKeyPem, nextPrivateKeyPem: next.privateKeyPem }).instance.jwks()).keys.map((key) => key.kid)).toEqual([current.keyId, next.keyId]);
    // Step 2: the next key signs; the retired public key stays published for a while.
    const step2 = server(olan, { privateKeyPem: next.privateKeyPem, keyId: 'k2', additionalPublicKeys: [{ ...current.publicJwk, kid: 'k1', d: 'secret' }] }).instance;
    const after = await step2.jwks();
    expect(after.keys.map((key) => key.kid)).toEqual(['k2', 'k1']);
    expect(after.keys[1]).not.toHaveProperty('d');
    expect(header(await step2.createClientAssertion({ issuer: ISSUER, installationId: 'inst-1' })).kid).toBe('k2');
    // Duplicates are dropped; a next key with the current kid or a key without kid is a mistake.
    const extra = { ...retired.publicJwk, kid: 'k3' };
    expect((await server(olan, { privateKeyPem: next.privateKeyPem, keyId: 'k2', additionalPublicKeys: [extra, extra, { ...current.publicJwk, kid: 'k2' }] }).instance.jwks()).keys.map((key) => key.kid)).toEqual(['k2', 'k3']);
    await expect(server(olan, { privateKeyPem: current.privateKeyPem, keyId: 'k1', nextPrivateKeyPem: next.privateKeyPem, nextKeyId: 'k1' }).instance.jwks()).rejects.toThrow(/nextKeyId/);
    await expect(server(olan, { privateKeyPem: current.privateKeyPem, additionalPublicKeys: [{ ...retired.publicJwk, kid: '' }] }).instance.jwks()).rejects.toThrow(/kid/);
  });

  for (const algorithm of ['ed25519', 'ec', 'rsa'] as const) {
    it(`gets installation tokens with a ${algorithm} client assertion`, async () => {
      const olan = fakeOlan();
      const pair =
        algorithm === 'ed25519'
          ? generateKeyPairSync('ed25519')
          : algorithm === 'ec'
            ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
            : generateKeyPairSync('rsa', { modulusLength: 2048 });
      const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      const { instance } = server(olan, { privateKeyPem });
      const jwks = await instance.jwks();
      expect(jwks.keys).toHaveLength(1);
      expect(JSON.stringify(jwks)).not.toContain('"d"');
      const published = jwks.keys[0]! as JsonWebKey & { kid: string; alg: string };
      let tokenCalls = 0;
      olan.setTokenHandler((body) => {
        tokenCalls++;
        expect(body.get('grant_type')).toBe('client_credentials');
        expect(body.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE);
        const [header, claims, signature] = body.get('client_assertion')!.split('.');
        const decodedHeader = JSON.parse(Buffer.from(header!, 'base64url').toString());
        const decoded = JSON.parse(Buffer.from(claims!, 'base64url').toString());
        expect(decodedHeader).toEqual({ alg: published.alg, kid: published.kid, typ: 'JWT' });
        expect(decoded).toMatchObject({ iss: APP_ID, sub: APP_ID, aud: clientAssertionAudience(ISSUER), olan_installation_id: 'inst-1', olan_user_id: 'u1' });
        expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(CLIENT_ASSERTION_MAX_LIFETIME_SECONDS);
        expect(typeof decoded.jti).toBe('string');
        // Verify like the Olan server does, with the key from the app's JWKS.
        const publicKey = createPublicKey({ key: published as never, format: 'jwk' });
        const data = Buffer.from(`${header}.${claims}`);
        const raw = Buffer.from(signature!, 'base64url');
        const ok =
          published.alg === 'ES256'
            ? nodeVerify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)
            : nodeVerify(published.alg === 'EdDSA' ? null : 'sha256', data, publicKey, raw);
        expect(ok).toBe(true);
        return Response.json({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 900, scope: 'projects:read', permissions: ['projects:read'] });
      });
      const token = await instance.getInstallationToken({ issuer: ISSUER, installationId: 'inst-1', userId: 'u1' });
      expect(token).toMatchObject({ accessToken: 'tok-1', expiresIn: 900, permissions: ['projects:read'], expiresAt: NOW + 900_000 });
      await instance.getInstallationToken({ issuer: `${ISSUER}/`, installationId: 'inst-1', userId: 'u1' });
      expect(tokenCalls).toBe(1);
    });
  }

  it('reports token endpoint errors and refuses unknown issuers', async () => {
    const olan = fakeOlan();
    const key = await generateAppKey();
    expect(key.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(key.publicJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: key.keyId, alg: 'EdDSA', use: 'sig' });
    const { instance } = server(olan, { privateKeyPem: key.privateKeyPem, keyId: 'app-key-1' });
    expect((await instance.jwks()).keys[0]).toMatchObject({ kid: 'app-key-1' });
    olan.setTokenHandler(() => Response.json({ error: 'consent_required', missing: ['projects:read'] }, { status: 403 }));
    const error = await failure(instance.getInstallationToken({ issuer: ISSUER, installationId: 'inst-1', userId: 'u2' }));
    expect(error).toMatchObject({ code: 'consent_required', status: 403, detail: { missing: ['projects:read'] } });
    expect((await failure(instance.getInstallationToken({ issuer: 'https://evil.example.com', installationId: 'i' }))).code).toBe('issuer_not_allowed');
    const keyless = createOlanServer({ appId: APP_ID, issuers: [ISSUER], fetch: olan.fetch });
    expect((await failure(keyless.jwks())).code).toBe('no_private_key');
  });

  describe('installation token cache', () => {
    async function tokenServer() {
      const olan = fakeOlan();
      const key = await generateAppKey();
      let issued = 0;
      olan.setTokenHandler((body) => {
        issued++;
        const claims = JSON.parse(Buffer.from(body.get('client_assertion')!.split('.')[1]!, 'base64url').toString()) as { olan_installation_id: string; olan_user_id?: string };
        return Response.json({ access_token: `tok-${issued}-${claims.olan_installation_id}${claims.olan_user_id ? `-${claims.olan_user_id}` : ''}`, token_type: 'Bearer', expires_in: 900 });
      });
      const { instance } = server(olan, { privateKeyPem: key.privateKeyPem });
      const token = async (installationId = 'inst-1', userId?: string) =>
        (await instance.getInstallationToken({ issuer: ISSUER, installationId, ...(userId ? { userId } : {}) })).accessToken;
      return { olan, instance, token, issued: () => issued };
    }

    for (const type of ['app.updated', 'app.consent.changed', 'app.uninstalled'] as const) {
      it(`drops the installation's cached tokens on ${type}`, async () => {
        const { olan, instance, token, issued } = await tokenServer();
        expect(await token()).toBe('tok-1-inst-1');
        expect(await token('inst-1', 'u1')).toBe('tok-2-inst-1-u1');
        expect(await token('inst-2')).toBe('tok-3-inst-2');
        expect(await token()).toBe('tok-1-inst-1');
        const seen: string[] = [];
        const response = await instance.handleEvent(olan.signed({ ...event(`evt_${type}`), type, data: {} }), async () => {
          // The handler already gets a token with the new grant.
          seen.push(await token());
        });
        expect(response.status).toBe(200);
        expect(seen).toEqual(['tok-4-inst-1']);
        expect(await token('inst-1', 'u1')).toBe('tok-5-inst-1-u1');
        // Other installations keep theirs.
        expect(await token('inst-2')).toBe('tok-3-inst-2');
        expect(issued()).toBe(5);
      });
    }

    it('keeps cached tokens on other events and drops them on demand', async () => {
      const { olan, instance, token, issued } = await tokenServer();
      await token();
      await token('inst-2');
      expect((await instance.handleEvent(olan.signed(event()), {})).status).toBe(200);
      expect(await token()).toBe('tok-1-inst-1');
      expect(instance.invalidateToken('inst-1', { issuer: 'https://other.example.com' })).toBe(0);
      expect(instance.invalidateToken('inst-1', { issuer: `${ISSUER}/` })).toBe(1);
      expect(await token()).toBe('tok-3-inst-1');
      expect(instance.invalidateToken('inst-1')).toBe(1);
      instance.clearTokenCache();
      expect(await token('inst-2')).toBe('tok-4-inst-2');
      expect(issued()).toBe(4);
    });

    it('does not cache a token that was in flight during an invalidation', async () => {
      const { instance, token } = await tokenServer();
      const pending = token();
      instance.invalidateToken('inst-1');
      expect(await pending).toBe('tok-1-inst-1');
      expect(await token()).toBe('tok-2-inst-1');
    });

    it('fetchOlan retries a stale-token 403 once with a fresh token, never more', async () => {
      const olan = fakeOlan();
      const api: { authorization: string | null; body: unknown }[] = [];
      let answer: (authorization: string) => Response = () => Response.json({ ok: true });
      const base = olan.fetch;
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(`${ISSUER}/api/v2/apps/installations/`)) return base(input, init);
        const authorization = new Headers(init?.headers).get('authorization');
        api.push({ authorization, body: init?.body ?? null });
        return answer(authorization ?? '');
      }) as typeof fetch;
      const key = await generateAppKey();
      let issued = 0;
      olan.setTokenHandler(() => Response.json({ access_token: `tok-${++issued}`, token_type: 'Bearer', expires_in: 900 }));
      const { instance: client } = server({ ...olan, fetch: fetchImpl }, { privateKeyPem: key.privateKeyPem });
      const target = { issuer: ISSUER, installationId: 'inst-1' };
      const path = '/api/v2/apps/installations/inst-1/chat/cards';

      // Cached before the grant changed; Olan now refuses it.
      await client.getInstallationToken(target);
      answer = (authorization) => (authorization === 'Bearer tok-1' ? Response.json({ error: 'permission_denied', permission: 'chat:write' }, { status: 403 }) : Response.json({ messageId: 'm1' }));
      const posted = await client.fetchOlan(target, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"conversationId":"c1"}' });
      expect(posted.status).toBe(200);
      expect(await posted.json()).toEqual({ messageId: 'm1' });
      expect(api).toEqual([
        { authorization: 'Bearer tok-1', body: '{"conversationId":"c1"}' },
        { authorization: 'Bearer tok-2', body: '{"conversationId":"c1"}' },
      ]);
      // The fresh token is cached.
      expect((await client.getInstallationToken(target)).accessToken).toBe('tok-2');

      // Still refused with a fresh token: one retry, then the 403 goes to the caller.
      api.length = 0;
      answer = () => Response.json({ error: 'insufficient_scope' }, { status: 403 });
      const refused = await client.fetchOlan(target, path, { method: 'POST', body: '{}' });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'insufficient_scope' });
      expect(api.map((call) => call.authorization)).toEqual(['Bearer tok-2', 'Bearer tok-3']);

      // Other 403s (and other statuses) are not retried.
      for (const [status, body] of [[403, { error: 'app_project_forbidden' }], [403, 'nope'], [404, { error: 'permission_denied' }]] as const) {
        api.length = 0;
        answer = () => (typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status }));
        expect((await client.fetchOlan(target, path)).status).toBe(status);
        expect(api).toHaveLength(1);
      }
      expect(issued).toBe(3);

      // The token never goes to another origin.
      await expect(client.fetchOlan(target, 'https://evil.example.com/api/v2/apps/installations/inst-1')).rejects.toThrow(/issuer/);
      await expect(client.fetchOlan(target, '//evil.example.com/x')).rejects.toThrow(/issuer/);
    });
  });

  describe('handleRequest (Phase 5a §1)', () => {
    const envelope = (extra: { id?: string; user?: Record<string, unknown> | null; request?: Record<string, unknown> } = {}) => ({
      id: extra.id ?? 'req_11111111-1111-4111-8111-111111111111',
      issuer: ISSUER,
      installationId: 'inst-1',
      appId: APP_ID,
      ...(extra.user === null ? {} : { user: extra.user ?? { id: 'u1', organizationId: 'org-1', locale: 'tr', timeZone: 'Europe/Istanbul' } }),
      request: { method: 'GET', path: '/brands', query: {}, headers: {}, body: null, timeoutMs: 30_000, ...extra.request },
      token: { accessToken: 'embedded', expiresIn: 300 },
    });
    const routes = {
      'GET /brands': (context: { user: unknown; token: unknown; query: unknown }) => ({ body: { user: context.user, token: context.token, query: context.query } }),
      'POST /brands/:brandId/posts': (context: { params: Record<string, string>; body: unknown }) => ({ status: 201, headers: { etag: '"v1"' }, body: { brand: context.params.brandId, got: context.body } }),
      'GET /brands/:brandId': (context: { params: Record<string, string> }) => {
        if (context.params.brandId === 'missing') throw new RequestError(404, { error: 'brand_not_found' });
        throw new Error('database down');
      },
      'GET /files/*': (context: { params: Record<string, string> }) => ({ body: context.params['*'] ?? null }),
    } as unknown as RemoteRoutes;
    const answer = async (response: Response) => ({ http: response.status, body: await response.json() });

    it('verifies, routes and wraps the answer', async () => {
      const olan = fakeOlan();
      const { instance } = server(olan);
      const listed = await answer(await instance.handleRequest(olan.signed(envelope({ request: { query: { page: '2' } } })), routes));
      expect(listed).toEqual({
        http: 200,
        body: { status: 200, body: { user: { id: 'u1', organizationId: 'org-1', locale: 'tr', timeZone: 'Europe/Istanbul' }, token: { accessToken: 'embedded', expiresIn: 300 }, query: { page: '2' } } },
      });
      const created = await answer(await instance.handleRequest(olan.signed(envelope({ id: 'req_2', request: { method: 'POST', path: '/brands/b%201/posts', body: { text: 'Merhaba' } } })), routes));
      expect(created.body).toEqual({ status: 201, headers: { etag: '"v1"' }, body: { brand: 'b 1', got: { text: 'Merhaba' } } });
      expect((await answer(await instance.handleRequest(olan.signed(envelope({ id: 'req_3', request: { path: '/files/a/b.png' } })), routes))).body).toEqual({ status: 200, body: 'a/b.png' });
    });

    it('answers unknown routes, wrong methods and route errors inside the wrapper', async () => {
      const olan = fakeOlan();
      const { instance } = server(olan);
      const unknown = await answer(await instance.handleRequest(olan.signed(envelope({ id: 'req_a', request: { path: '/nope' } })), routes));
      expect(unknown).toEqual({ http: 200, body: { status: 404, body: { error: 'unknown_route', message: 'No route for GET /nope' } } });
      const wrongMethod = await answer(await instance.handleRequest(olan.signed(envelope({ id: 'req_b', request: { method: 'DELETE', path: '/brands' } })), routes));
      expect(wrongMethod.body).toMatchObject({ status: 405, body: { error: 'method_not_allowed' } });
      const rejected = await answer(await instance.handleRequest(olan.signed(envelope({ id: 'req_c', request: { path: '/brands/missing' } })), routes));
      expect(rejected.body).toEqual({ status: 404, body: { error: 'brand_not_found' } });
      const crashed = await answer(await instance.handleRequest(olan.signed(envelope({ id: 'req_d', request: { path: '/brands/b1' } })), routes));
      expect(crashed.body).toEqual({ status: 500, body: { error: 'internal_error' } });
    });

    it('rejects a bad signature, a stale timestamp, an unknown issuer, a replay and a mismatched id', async () => {
      const olan = fakeOlan();
      const { instance } = server(olan);
      const forged = await answer(await instance.handleRequest(olan.signed(envelope(), { tamper: true }), routes));
      expect(forged).toMatchObject({ http: 401, body: { error: 'invalid_signature' } });
      const stale = await answer(await instance.handleRequest(olan.signed(envelope(), { timestamp: Math.floor(NOW / 1000) - 301 }), routes));
      expect(stale).toMatchObject({ http: 401, body: { error: 'timestamp_out_of_range' } });
      const foreign = await answer(await instance.handleRequest(olan.signed(envelope(), { issuer: 'https://evil.example.com' }), routes));
      expect(foreign).toMatchObject({ http: 401, body: { error: 'issuer_not_allowed' } });
      expect((await instance.handleRequest(olan.signed(envelope()), routes)).status).toBe(200);
      const replay = await answer(await instance.handleRequest(olan.signed(envelope()), routes));
      expect(replay).toMatchObject({ http: 409, body: { error: 'duplicate_request' } });
      const mismatched = await instance.handleRequest(olan.signed(envelope({ id: 'req_x' }), { id: 'req_y' }), routes);
      expect(mismatched.status).toBe(400);
    });

    it('refuses an envelope whose issuer is not the olan-issuer header (EK3-2)', async () => {
      const olan = fakeOlan();
      // Both issuers are allowed: a server trusted for its own organization claims another issuer.
      const { instance } = server(olan, { issuers: [ISSUER, 'https://api.olan.app'] });
      let ran = 0;
      const record: RemoteRequestHandler = () => {
        ran++;
      };
      const foreign = await answer(await instance.handleRequest(olan.signed({ ...envelope({ id: 'req_i1' }), issuer: 'https://api.olan.app' }), record));
      expect(foreign).toMatchObject({ http: 401, body: { error: 'issuer_mismatch' } });
      const missing = { ...envelope({ id: 'req_i2' }) } as Record<string, unknown>;
      delete missing.issuer;
      expect((await instance.handleRequest(olan.signed(missing), record)).status).toBe(400);
      expect(ran).toBe(0);
      // The refused ids were not consumed; a trailing slash is the same issuer.
      expect((await answer(await instance.handleRequest(olan.signed(envelope({ id: 'req_i1' })), record))).http).toBe(200);
      expect((await answer(await instance.handleRequest(olan.signed({ ...envelope({ id: 'req_i3' }), issuer: `${ISSUER}/` }), record))).http).toBe(200);
      expect(ran).toBe(2);
    });

    it('passes profile fields only when the envelope has them, and no user for the app identity', async () => {
      const olan = fakeOlan();
      const { instance } = server(olan);
      const seen: unknown[] = [];
      const record: RemoteRequestHandler = (context) => {
        seen.push(context.user);
      };
      const profile = { id: 'u1', organizationId: 'org-1', locale: 'tr', timeZone: 'Europe/Istanbul', email: 'utku@example.com', displayName: 'Utku', role: 'admin' };
      await instance.handleRequest(olan.signed(envelope({ id: 'req_p1', user: profile })), record);
      await instance.handleRequest(olan.signed(envelope({ id: 'req_p2' })), record);
      await instance.handleRequest(olan.signed(envelope({ id: 'req_p3', user: null })), record);
      expect(seen[0]).toEqual(profile);
      expect(seen[1]).not.toHaveProperty('email');
      expect(seen[1]).not.toHaveProperty('displayName');
      expect(seen[1]).not.toHaveProperty('role');
      expect(seen[2]).toBeNull();
    });

    it('builds and checks the return address from the issuer webOrigin', async () => {
      const olan = fakeOlan();
      const { instance } = server(olan);
      expect(await instance.appReturnUrl({ issuer: ISSUER, installationId: 'inst-1' })).toBe('https://web.olan.example.com/apps/return/inst-1');
      expect(await instance.isAppReturnUrl({ issuer: ISSUER, installationId: 'inst-1', url: 'https://web.olan.example.com/apps/return/inst-1?state=s' })).toBe(true);
      expect(await instance.isAppReturnUrl({ issuer: ISSUER, installationId: 'inst-1', url: 'https://evil.example.com/apps/return/inst-1' })).toBe(false);
      expect((await failure(instance.appReturnUrl({ issuer: 'https://evil.example.com', installationId: 'i' }))).code).toBe('issuer_not_allowed');
    });

    it('matches routes like the server does', () => {
      expect(matchRemoteRoute(routes, 'GET', '/brands/b1')).toMatchObject({ params: { brandId: 'b1' } });
      expect(matchRemoteRoute(routes, 'PUT', '/brands')).toEqual({ status: 405 });
      expect(matchRemoteRoute(routes, 'GET', '/x')).toEqual({ status: 404 });
    });
  });

  it('defaults to the Olan cloud issuer (G20)', () => {
    expect(DEFAULT_ISSUERS).toEqual([OLAN_CLOUD_ISSUER]);
    expect(REQUEST_ID_RETENTION_SECONDS).toBe(REMOTE_REQUEST_LIMITS.idRetentionSeconds);
  });

  it('adapts Node requests and responses', async () => {
    const olan = fakeOlan();
    const { instance } = server(olan);
    const request = olan.signed(event());
    const text = await request.clone().text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value));
    const incoming = Object.assign((async function* () {
      yield Buffer.from(text.slice(0, 10));
      yield text.slice(10);
    })(), { headers });
    const parsed = await fromNodeRequest(incoming);
    const response = await instance.handleEvent(parsed, async () => {});
    const written: { status?: number; headers?: Record<string, string>; body?: string } = {};
    await sendNodeResponse({ writeHead: (status, h) => Object.assign(written, { status, headers: h }), end: (body) => (written.body = Buffer.from(body as Uint8Array).toString()) }, response);
    expect(written.status).toBe(200);
    expect(written.headers?.['content-type']).toContain('application/json');
    expect(JSON.parse(written.body!)).toEqual({ ok: true });
  });
});

describe('dist/', () => {
  it('is up to date (run `npm run build` in packages/app-sdk when this fails)', () => {
    expect(() => execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  }, 60_000);

  it('runs in plain Node without other packages', () => {
    const script = `
      const { createOlanServer, generateAppKey } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/server.js')).href)});
      const { defineBackend, isBackendModule } = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/backend.js')).href)});
      const key = await generateAppKey();
      const server = createOlanServer({ appId: 'com.example.x', privateKeyPem: key.privateKeyPem });
      const jwks = await server.jwks();
      const assertion = await server.createClientAssertion({ issuer: 'https://olan.app', installationId: 'i' });
      console.log(JSON.stringify({ kid: jwks.keys[0].kid === key.keyId, parts: assertion.split('.').length, backend: isBackendModule(defineBackend({})) }));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: root });
    expect(JSON.parse(output.trim())).toEqual({ kid: true, parts: 3, backend: true });
  }, 60_000);
});
