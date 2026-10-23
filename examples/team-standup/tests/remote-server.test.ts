import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';

import { createStandupServer, type StandupServer } from '../remote-server/server.ts';

/*
 * The app server in-process, against a fake Olan issuer: its own Ed25519 key, `/.well-known/olan`,
 * the JWKS, the token endpoint and the project routes, all reached through the `fetch` the server
 * is given. Requests are signed exactly as Olan signs them (contract §5.3).
 */

const ISSUER = 'https://olan.test';
const KID = 'olan-test-1';
const INSTALLATION = '3f1b5c1e-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000001';

type Pair = { privateKey: CryptoKey; publicKey: CryptoKey };
const generate = async () => (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as Pair;
const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64');

let olanKey: Pair;
let otherKey: Pair;
let dataDir: string;
let server: StandupServer;
const tokenRequests: Record<string, unknown>[] = [];
const createdTasks: Record<string, unknown>[] = [];

const today = new Date().toISOString().slice(0, 10);
const PROJECT = {
  project: { id: 'p1', name: 'Lansman' },
  members: [{ userId: USER, displayName: 'Utku' }],
  lists: [{ id: 'l-old', archived: true, parentId: null }, { id: 'l-step', archived: false, parentId: 'l1' }, { id: 'l1', archived: false, parentId: null, isDefault: true }],
  tasks: [
    { id: 't1', title: 'Basın bülteni', status: 'needs-action', due: '2020-01-01', assigneeId: USER },
    { id: 't2', title: 'Web sayfası', status: 'in-process', due: null, assigneeId: null },
    { id: 't3', title: 'Afiş', status: 'completed', due: null, assigneeId: null, updatedAt: new Date().toISOString() },
  ],
};

async function fakeOlan(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== ISSUER) throw new Error(`unexpected fetch ${url.href}`);
  const auth = new Headers(init?.headers).get('authorization');
  if (url.pathname === '/.well-known/olan') return Response.json({ apps: { jwksUri: `${ISSUER}/api/v2/apps/jwks.json`, tokenEndpoint: `${ISSUER}/api/v2/apps/oauth/token` } });
  if (url.pathname === '/api/v2/apps/jwks.json') {
    const jwk = await crypto.subtle.exportKey('jwk', olanKey.publicKey);
    return Response.json({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: KID, alg: 'EdDSA', use: 'sig' }] });
  }
  if (url.pathname === '/api/v2/apps/oauth/token') {
    const form = new URLSearchParams(String(init?.body ?? ''));
    const claims = JSON.parse(Buffer.from(form.get('client_assertion')!.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    tokenRequests.push(claims);
    const user = typeof claims.olan_user_id === 'string';
    return Response.json({ access_token: user ? 'renewed-user-token' : 'app-identity-token', token_type: 'Bearer', expires_in: 900, scope: 'openid projects:read', permissions: ['projects:read'] });
  }
  // Projects: the person's tokens see p1; the app identity was added to no project.
  if (auth === 'Bearer app-identity-token') return Response.json({ error: 'forbidden' }, { status: 403 });
  if (auth !== 'Bearer embedded-token' && auth !== 'Bearer renewed-user-token') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (url.pathname === '/api/v2/projects') return Response.json({ items: [{ id: 'p1', name: 'Lansman', archived: false }, { id: 'old', name: 'Eski', archived: true }] });
  if (url.pathname === '/api/v2/projects/p1/tasks' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    createdTasks.push(body);
    return Response.json({ id: 't-new', projectId: 'p1', ...body });
  }
  if (url.pathname === '/api/v2/projects/p1') return Response.json(PROJECT);
  return Response.json({ error: 'project_not_found' }, { status: 404 });
}

/** Runs one request through `server.handle` with Node-like request/response objects. */
async function call(method: string, path: string, body = '', headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method, url: path, headers: { 'content-type': 'application/json', ...headers },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const response = {
    writeHead(code: number) { status = code; return response; },
    end(chunk?: Uint8Array | string) { text = chunk === undefined ? '' : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return response; },
  } as unknown as ServerResponse;
  await server.handle(request, response);
  return { status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function signed(path: string, id: string, body: Record<string, unknown>, options: { key?: CryptoKey; timestamp?: number; issuer?: string; attempt?: number; type?: string } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = await crypto.subtle.sign('Ed25519', options.key ?? olanKey.privateKey, new TextEncoder().encode(`${id}.${timestamp}.${raw}`));
  return call('POST', path, raw, {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1a,${b64(signature)}`,
    'olan-issuer': options.issuer ?? ISSUER,
    'olan-key-id': KID,
    'olan-installation-id': INSTALLATION,
    ...(options.type ? { 'olan-event-type': options.type, 'olan-delivery-attempt': String(options.attempt ?? 1) } : {}),
  });
}

const event = (id: string) => ({
  id, type: 'project.task.created', version: 1, occurredAt: new Date().toISOString(), issuer: ISSUER,
  installationId: INSTALLATION, appId: 'com.olan.examples.team-standup', actor: { kind: 'user', id: USER },
  data: { projectId: 'p1', task: { id: 't9', title: 'Yeni görev' } },
});
const sendEvent = (id: string, options: Parameters<typeof signed>[3] = {}) => signed('/olan/events', id, event(id), { type: 'project.task.created', ...options });

const toolCall = (id: string, input: Record<string, unknown>, accessToken = 'embedded-token', tool = 'standup_summary') => ({
  id, tool, installationId: INSTALLATION, appId: 'com.olan.examples.team-standup', issuer: ISSUER, channel: 'assistant',
  user: { id: USER, locale: 'tr', timeZone: 'UTC' }, input, token: { accessToken, expiresIn: 300 },
});

before(async () => {
  olanKey = await generate();
  otherKey = await generate();
  dataDir = mkdtempSync(join(tmpdir(), 'team-standup-'));
  server = await createStandupServer({ issuers: [ISSUER], dataDir, fetch: fakeOlan as typeof fetch });
});
after(() => rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => {
  server.reset();
  tokenRequests.length = 0;
  createdTasks.length = 0;
});

test('serves its JWKS, health and 404s', async () => {
  const jwks = await call('GET', '/.well-known/jwks.json');
  const keys = jwks.json.keys as { kid: string; kty: string; crv: string }[];
  assert.equal(keys[0]?.kid, server.keyId);
  assert.equal(keys[0]?.crv, 'Ed25519');
  assert.equal((await call('GET', '/health')).json.ok, true);
  assert.equal((await call('GET', '/olan/unknown')).status, 404);
});

test('keeps its key across restarts', async () => {
  const again = await createStandupServer({ issuers: [ISSUER], dataDir, fetch: fakeOlan as typeof fetch });
  assert.equal(again.keyId, server.keyId);
});

test('accepts a signed event and logs it', async () => {
  const answer = await sendEvent('evt_ok');
  assert.equal(answer.status, 200);
  const [entry] = server.log();
  assert.equal(entry?.kind, 'event');
  assert.equal(entry?.webhookId, 'evt_ok');
  assert.equal(entry?.type, 'project.task.created');
  assert.equal(entry?.installationId, INSTALLATION);
  assert.equal(entry?.attempt, 1);
  assert.deepEqual(entry?.data, { projectId: 'p1', task: { id: 't9', title: 'Yeni görev' } });
});

test('rejects a forged signature, a stale timestamp and an unknown issuer', async () => {
  assert.equal((await sendEvent('evt_forged', { key: otherKey.privateKey })).status, 401);
  assert.equal((await sendEvent('evt_stale', { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  assert.equal((await sendEvent('evt_issuer', { issuer: 'https://evil.example' })).status, 401);
  assert.deepEqual(server.log().map((entry) => [entry.kind, entry.error]), [
    ['rejected', 'invalid_signature'],
    ['rejected', 'timestamp_out_of_range'],
    ['rejected', 'issuer_not_allowed'],
  ]);
});

test('processes a webhook-id once', async () => {
  assert.equal((await sendEvent('evt_dup')).status, 200);
  assert.equal((await sendEvent('evt_dup', { attempt: 2 })).status, 200);
  assert.deepEqual(server.log().map((entry) => entry.kind), ['event', 'duplicate']);
});

test('fails on purpose three times, then takes the retry', async () => {
  assert.equal((await call('POST', '/__test/fail', JSON.stringify({ count: 3 }))).status, 200);
  for (const attempt of [1, 2, 3]) assert.equal((await sendEvent('evt_retry', { attempt })).status, 500);
  assert.equal((await sendEvent('evt_retry', { attempt: 4 })).status, 200);
  assert.deepEqual(server.log().map((entry) => [entry.kind, entry.attempt]), [
    ['failed_on_purpose', 1], ['failed_on_purpose', 2], ['failed_on_purpose', 3], ['event', 4],
  ]);
  const log = await call('GET', '/__test/log');
  assert.equal((log.json.entries as unknown[]).length, 4);
});

test('fails on purpose only for the given event type', async () => {
  assert.equal((await call('POST', '/__test/fail', JSON.stringify({ count: 1, status: 410, type: 'project.task.created' }))).status, 200);
  const other = await signed('/olan/events', 'evt_chat', { ...event('evt_chat'), type: 'chat.message.created' }, { type: 'chat.message.created' });
  assert.equal(other.status, 200);
  assert.equal((await sendEvent('evt_gone')).status, 410);
  assert.deepEqual(server.log().map((entry) => [entry.kind, entry.type, entry.status ?? null]), [
    ['event', 'chat.message.created', null], ['failed_on_purpose', 'project.task.created', 410],
  ]);
});

test('standup_summary summarises the visible projects with the embedded token', async () => {
  const answer = await signed('/olan/ai-tools/standup_summary', 'call_1', toolCall('call_1', {}));
  assert.equal(answer.status, 200);
  assert.equal(answer.json.ok, true);
  assert.equal(answer.json.summary, '2 açık, 1 gecikmiş görev');
  const result = answer.json.result as { today: string; projects: { id: string; open: number; overdue: number; completedToday: number; tasks: { title: string; assignee: string | null }[] }[] };
  assert.equal(result.today, today);
  assert.deepEqual(result.projects.map((project) => [project.id, project.open, project.overdue, project.completedToday]), [['p1', 2, 1, 1]]);
  assert.deepEqual(result.projects[0]!.tasks[0], { title: 'Basın bülteni', due: '2020-01-01', assignee: 'Utku' });
  assert.deepEqual(server.log().map((entry) => [entry.kind, entry.callId, entry.channel]), [['tool_call', 'call_1', 'assistant']]);
  assert.equal(tokenRequests.length, 0);
});

test('standup_summary renews an expired embedded token once, on behalf of the person', async () => {
  const answer = await signed('/olan/ai-tools/standup_summary', 'call_2', toolCall('call_2', { projectId: 'p1' }, 'expired'));
  assert.equal(answer.json.ok, true);
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0]?.olan_user_id, USER);
  assert.equal(tokenRequests[0]?.olan_installation_id, INSTALLATION);
  assert.equal(tokenRequests[0]?.aud, `${ISSUER}/api/v2/apps/oauth/token`);
});

test('standup_summary answers project_not_found and refuses unsigned calls', async () => {
  const missing = await signed('/olan/ai-tools/standup_summary', 'call_3', toolCall('call_3', { projectId: 'missing' }));
  assert.deepEqual(missing.json, { ok: false, error: { code: 'project_not_found', message: 'Proje bulunamadı ya da görülemiyor' } });
  const forged = await signed('/olan/ai-tools/standup_summary', 'call_4', toolCall('call_4', {}), { key: otherKey.privateKey });
  assert.equal(forged.status, 401);
  assert.equal(server.log().at(-1)?.error, 'invalid_signature');
});

test('standup_add_task adds the task to the default work package with a creation key from the call id', async () => {
  const id = 'call_0b7c6e5e-1f6d-4b8e-9d55-6f1c0a3b2c11';
  const answer = await signed('/olan/ai-tools/standup_add_task', id, toolCall(id, { projectId: 'p1', title: '  Demo hazırlığı ', description: 'Cuma' }, 'embedded-token', 'standup_add_task'));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { ok: true, result: { projectId: 'p1', taskId: 't-new', title: 'Demo hazırlığı' }, summary: '"Demo hazırlığı" Lansman projesine eklendi' });
  assert.deepEqual(createdTasks, [{ title: 'Demo hazırlığı', listId: 'l1', creationKey: '0b7c6e5e-1f6d-4b8e-9d55-6f1c0a3b2c11', description: 'Cuma' }]);
  assert.deepEqual(server.log().map((entry) => [entry.kind, entry.tool, entry.channel]), [['tool_call', 'standup_add_task', 'assistant']]);
});

test('standup_add_task needs a title and a visible project', async () => {
  const empty = await signed('/olan/ai-tools/standup_add_task', 'call_5', toolCall('call_5', { projectId: 'p1', title: ' ' }, 'embedded-token', 'standup_add_task'));
  assert.equal((empty.json.error as { code: string }).code, 'invalid_input');
  const missing = await signed('/olan/ai-tools/standup_add_task', 'call_6', toolCall('call_6', { projectId: 'missing', title: 'X' }, 'embedded-token', 'standup_add_task'));
  assert.equal((missing.json.error as { code: string }).code, 'project_not_found');
  assert.equal(createdTasks.length, 0);
});

test('the card action "done" answers the completed card', async () => {
  const answer = await signed('/olan/card-actions', 'act_1', {
    id: 'act_1', issuer: ISSUER, installationId: INSTALLATION, user: { id: USER, locale: 'tr' }, conversationId: 'c1', messageId: 'msg-1',
    name: 'done', payload: { day: '2026-10-17', note: 'Dün: API' }, token: { accessToken: 'embedded-token', expiresIn: 300 },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json.toast, { text: 'Standup tamamlandı', tone: 'success' });
  const card = answer.json.card as { version: number; fallbackText: string; nodes: { type: string; props: Record<string, unknown> }[] };
  assert.equal(card.version, 1);
  assert.equal(card.nodes.find((node) => node.type === 'Badge')?.props.text, 'Tamamlandı');
  assert.equal(card.nodes.some((node) => node.type === 'Button'), false);
  assert.match(card.fallbackText, /^Standup tamamlandı · 2026-10-17/);
  assert.deepEqual(server.log().map((entry) => [entry.kind, entry.name, entry.messageId]), [['card_action', 'done', 'msg-1']]);
});

test('app identity gets a token but cannot read a project it was not added to', async () => {
  const answer = await call('POST', '/__test/app-identity', JSON.stringify({ issuer: ISSUER, installationId: INSTALLATION, path: '/api/v2/projects/p1' }));
  assert.deepEqual(answer.json, { tokenOk: true, status: 403, body: { error: 'forbidden' } });
  assert.equal(tokenRequests[0]?.olan_user_id, undefined);
  assert.equal(tokenRequests[0]?.sub, 'com.olan.examples.team-standup');
});
