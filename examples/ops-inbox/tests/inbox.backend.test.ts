import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBackendHarness, signHookRequest, type BackendHarnessOptions } from '@olan-app/cli/testing';

// Headless backend tests: server/index.ts runs in @olan-app/runtime (isolated-vm, or QuickJS with
// `olan-app test --engine quickjs`); olan.* is answered by the mock host with fixtures/*.json.

const NOW = '2026-10-17T09:00:00.000Z';
const start = (options: BackendHarnessOptions = {}) => createBackendHarness({ now: NOW, ...options });

const PUSH = { ref: 'refs/heads/main', repository: { full_name: 'visetra/olan' }, commits: [{ id: 'a' }, { id: 'b' }], pusher: { name: 'utku' } };

test('summary counts the records and only says whether the token is set', async () => {
  const backend = await start();
  try {
    const result = await backend.call<{ counts: Record<string, number>; apiConfigured: boolean }>('summary');
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.value?.counts, { task: 1, push: 1, digest: 0 });
    assert.equal(result.value?.apiConfigured, true);
    assert.ok(!JSON.stringify(result.value).includes('ops-fixture-token'));
  } finally {
    await backend.dispose();
  }
});

test('the digest schedule (every 5 minutes) writes a digest and posts it with the secret token', async () => {
  const backend = await start();
  try {
    const schedule = backend.manifest.server?.schedules?.find((entry) => entry.name === 'digest');
    assert.equal(schedule?.cron, '*/5 * * * *');
    const run = await backend.runSchedule('digest', { scheduledAt: '2026-10-17T09:05:00.000Z' });
    assert.equal(run.ok, true, run.error?.message);
    const digest = backend.host.data.db.records?.find((row) => row.data.kind === 'digest');
    assert.deepEqual(digest?.data.detail, { tasks: 1, pushes: 1, since: null, trigger: 'schedule', scheduledAt: '2026-10-17T09:05:00.000Z' });
    const post = backend.calls('http.fetch')[0];
    assert.equal(post?.ok, true);
    // Recorded calls never hold secret values: the token the backend sent shows as [secret].
    assert.equal((post?.params as { headers: Record<string, string> }).headers.authorization, 'Bearer [secret]');
    assert.equal(backend.calls('secrets.get')[0]?.result, '[secret]');
    assert.ok(run.logs.some((line) => line.message.startsWith('digest written')));

    // The next run only counts what arrived since this digest.
    await backend.emit({ type: 'project.task.created', data: { projectId: 'p1', task: { id: 't-new', title: 'Yedekleri kontrol et' } } });
    await backend.runSchedule('digest');
    const titles = backend.host.data.db.records?.filter((row) => row.data.kind === 'digest').map((row) => row.data.title);
    assert.deepEqual(titles, ['Özet: 1 yeni görev, 1 push', 'Özet: 1 yeni görev, 0 push']);
  } finally {
    await backend.dispose();
  }
});

test('without the token the digest stays in Olan', async () => {
  const backend = await start({ secrets: { apiToken: null } });
  try {
    assert.equal((await backend.runSchedule('digest')).ok, true);
    assert.deepEqual(backend.calls('http.fetch'), []);
  } finally {
    await backend.dispose();
  }
});

test('project.task.created is recorded (events map)', async () => {
  const backend = await start();
  try {
    const delivered = await backend.emit({ type: 'project.task.created', data: { projectId: 'p1', task: { id: 't-9', title: 'Disk alanı uyarısı' } } });
    assert.equal(delivered.ok, true, delivered.error?.message);
    const row = backend.host.data.db.records?.find((candidate) => candidate.data.title === 'Disk alanı uyarısı');
    assert.deepEqual(row?.data, { kind: 'task', title: 'Disk alanı uyarısı', projectId: 'p1', detail: { taskId: 't-9', by: 'app' } });
    // A sample event built from the fixtures works too.
    assert.equal((await backend.emit('project.task.created')).ok, true);
  } finally {
    await backend.dispose();
  }
});

test('the github hook records a verified push', async () => {
  const backend = await start();
  try {
    // What GitHub sends: x-hub-signature-256 = sha256=<HMAC of the raw body with the webhook secret>.
    const body = JSON.stringify(PUSH);
    const signature = await signHookRequest({ kind: 'hmac-sha256', header: 'x-hub-signature-256' }, body, 'gh-fixture-secret');
    const response = await backend.hook('github', { headers: { 'x-github-event': 'push', ...signature }, body });
    assert.equal(response.verified, true);
    assert.equal(response.status, 200, response.error?.message);
    const recorded = JSON.parse(response.body) as { recorded: string };
    const row = backend.host.data.db.records?.find((candidate) => candidate.id === recorded.recorded);
    assert.equal(row?.data.title, 'visetra/olan: main dalına 2 commit');

    const ping = await backend.hook('github', { headers: { 'x-github-event': 'ping' }, body: {} });
    assert.deepEqual([ping.status, ping.body], [200, 'pong']);
  } finally {
    await backend.dispose();
  }
});

test('the github hook rejects a forged or missing signature before the function runs', async () => {
  const backend = await start();
  try {
    const before = backend.host.data.db.records?.length;
    const forged = await backend.hook('github', { headers: { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, body: PUSH });
    assert.deepEqual([forged.status, forged.verified, forged.error?.code], [401, false, 'hook_verification_failed']);
    const wrongSecret = await backend.hook('github', { headers: { 'x-github-event': 'push', ...(await signHookRequest({ kind: 'hmac-sha256', header: 'x-hub-signature-256' }, JSON.stringify(PUSH), 'not-the-secret')) }, body: PUSH });
    assert.equal(wrongSecret.status, 401);
    const unsigned = await backend.hook('github', { headers: { 'x-github-event': 'push' }, body: PUSH, sign: false });
    assert.equal(unsigned.status, 401);
    assert.equal(backend.host.data.db.records?.length, before);
    assert.deepEqual(backend.logs(), []);
  } finally {
    await backend.dispose();
  }
});

test('secrets reach only the backend', async () => {
  const backend = await start();
  try {
    // The UI path: settings.get hides them, secrets.get does not exist.
    assert.deepEqual(await backend.host.handle('settings.get', {}), { ok: true, result: { apiToken: null, githubSecret: null } });
    const fromUi = await backend.host.handle('secrets.get', { name: 'apiToken' });
    assert.equal(fromUi.ok ? 'ok' : fromUi.error.code, 'unknown_method');
    // The backend path (__olan.call).
    assert.deepEqual(await backend.host.handle('secrets.get', { name: 'apiToken' }, { backend: true }), { ok: true, result: 'ops-fixture-token' });
  } finally {
    await backend.dispose();
  }
});

test('errors map to the olan.backend.call codes', async () => {
  const backend = await start();
  try {
    const missing = await backend.call('nope');
    assert.deepEqual([missing.error?.code, missing.error?.runtimeCode], ['backend_function_not_found', 'not_found']);
    // Trigger handlers and the manifest's fallback names are not callable from the UI.
    for (const name of ['github', 'digest', 'onTaskCreated']) assert.equal((await backend.call(name)).error?.code, 'backend_function_not_found');
    const denied = await backend.call('summary', null, { permissions: ['projects:read'] });
    assert.equal(denied.error?.code, 'backend_error');
    assert.match(denied.error?.message ?? '', /db permission/);
  } finally {
    await backend.dispose();
  }
});
