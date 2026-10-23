// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { strFromU8, unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { signHookRequest, verifyHookSignature } from '@olan-app/sdk/server';

import { buildBackend } from '../src/backend/build';
import { createBackendHarness } from '../src/backend/harness';
import { CliError } from '../src/errors';
import { buildApp } from '../src/commands/build';
import { processAlive, startDevServer } from '../src/commands/dev';
import { renderApp } from '../src/testing';
import { packApp } from '../src/commands/pack';
import { validateApp } from '../src/commands/validate';
import { initApp } from '../src/commands/init';
import { manifest, tempProject, type TempProject } from './helpers';

const APP = `import { Screen, Text, defineApp, olan, useQuery } from '@olan-app/sdk';
function Home() {
  const summary = useQuery(() => olan.backend.call<{ count: number }>('summary'), []);
  return <Screen title="Kutu"><Text text={summary.data ? \`\${summary.data.count} kayıt\` : '…'} /></Screen>;
}
export default defineApp({ app: Home });
`;

const SERVER = `import { defineBackend, olan } from '@olan-app/sdk/backend';
const items = () => olan.db.collection('items');
export default defineBackend({
  functions: {
    async summary() { return { count: await items().count(), configured: (await olan.secrets.get('token')) !== null }; },
    async add(args) { const row = await items().insert({ title: String(args.title) }); console.log('added', args.title); return row.id; },
    boom() { throw new Error('kaboom'); },
    onTask: async (event) => { await items().insert({ title: 'task:' + event.data.task.title }); },
    settings: () => olan.settings.get(),
    ui: async () => { try { await (globalThis).__olan.call('ui.toast', '{"text":"x"}'); return 'no'; } catch (error) { return error.code; } },
  },
  schedules: { tick: async (ctx) => { await items().insert({ title: 'tick ' + ctx.scheduledAt }); } },
  hooks: { inbound: async (request) => ({ status: 201, headers: { 'X-Echo': 'yes' }, body: request.body.toUpperCase() }) },
});
`;

const backendManifest = (server: Record<string, unknown> = {}) =>
  manifest({
    sdk: '^1.4.0',
    permissions: ['db', 'projects:read'],
    settings: { token: { type: 'string', label: 'Token', secret: true }, hookSecret: { type: 'string', label: 'Hook', secret: true }, title: { type: 'string', label: 'Başlık', default: 'Kutu' } },
    data: { version: 1, collections: { items: { scope: 'organization', fields: { title: { type: 'string', required: true, maxLength: 200 } } } } },
    server: {
      entry: 'server/index.ts',
      schedules: [{ name: 'tick', cron: '*/5 * * * *', function: 'tick' }],
      events: { 'project.task.created': 'onTask' },
      hooks: [{ name: 'inbound', function: 'inbound', verify: { kind: 'hmac-sha256', header: 'x-signature', secretSetting: 'hookSecret' } }],
      ...server,
    },
  });

const projects: TempProject[] = [];
const project = (name: string, files: Record<string, string> = {}) => {
  const created = tempProject(name, {
    'olan-app.json': backendManifest(),
    'src/app.tsx': APP,
    'server/index.ts': SERVER,
    'fixtures/settings.json': JSON.stringify({ token: 'tok-1', hookSecret: 'hook-1' }),
    ...files,
  });
  projects.push(created);
  return created;
};

afterAll(() => {
  for (const created of projects) created.remove();
});

describe('backend build', () => {
  it('bundles server.entry into an IIFE with __olanBackendModule and the SDK inside', async () => {
    const app = project('backend-build');
    const { result } = await buildApp(app.dir);
    expect(result.backend).toMatchObject({ file: 'dist/server.js' });
    const code = readFileSync(join(app.dir, 'dist/server.js'), 'utf8');
    expect(code).not.toMatch(/\bimport\b|\brequire\(/);
    const sandbox: Record<string, unknown> = {};
    runInNewContext(code, sandbox);
    const module = sandbox.__olanBackendModule as { default: { $olanBackend: number; functions: Record<string, unknown> } };
    expect(module.default.$olanBackend).toBe(1);
    expect(Object.keys(module.default.functions)).toEqual(['summary', 'add', 'boom', 'onTask', 'settings', 'ui']);
  });

  it('rejects Node modules with build.backend_node_import', async () => {
    const app = project('backend-node', { 'server/index.ts': `import { readFileSync } from 'node:fs';\nimport { defineBackend } from '@olan-app/sdk/backend';\nexport default defineBackend({ functions: { f: () => readFileSync('x', 'utf8') } });\n` });
    const failure = await buildBackend(app.dir, JSON.parse(readFileSync(join(app.dir, 'olan-app.json'), 'utf8'))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).issues.map((item) => item.code)).toContain('build.backend_node_import');
    expect((failure as CliError).issues[0]!.file).toBe('server/index.ts');
  });
});

describe('backend validate and pack', () => {
  it('loads dist/server.js and reports schedules, events and hooks without a handler', async () => {
    const app = project('backend-validate', {
      'olan-app.json': backendManifest({ schedules: [{ name: 'nightly', cron: '0 3 * * *', function: 'missingFn' }], hooks: [] }),
    });
    const { errors, result } = await validateApp(app.dir, { typecheck: false, engine: 'quickjs' });
    expect(errors.map((item) => item.code)).toEqual(['validate.backend_handler_missing']);
    expect(errors[0]!.message).toContain('"nightly"');
    expect(result.checks.find((check) => check.name === 'backend')).toEqual({ name: 'backend', ok: false });
    expect(result.backend?.handlers?.schedules).toEqual(['tick']);
  });

  it('passes with every handler resolved and packs dist/server.js under the digest', async () => {
    const app = project('backend-pack');
    const { errors } = await validateApp(app.dir, { typecheck: false });
    expect(errors).toEqual([]);
    const packed = await packApp(app.dir, { signKey: false });
    expect(packed.files.map((file) => file.path).sort()).toEqual(['dist/app.js', 'dist/server.js', 'olan-app.json']);
    const entries = unzipSync(readFileSync(join(app.dir, packed.file)));
    const digest = JSON.parse(strFromU8(entries['digest.json']!)) as { files: Record<string, string> };
    expect(Object.keys(digest.files)).toContain('dist/server.js');
  });

  it('validate --strict counts permissions only the backend uses (dist/server.js)', async () => {
    const app = project('backend-strict', {
      'olan-app.json': backendManifest(),
      'server/index.ts': SERVER.replace('async summary() {', "async summary() { await olan.http.fetch('https://ops.example.com/x');"),
    });
    app.write('olan-app.json', JSON.stringify({ ...JSON.parse(backendManifest()), permissions: ['db', 'projects:read', 'http:ops.example.com'] }));
    const { errors, warnings } = await validateApp(app.dir, { typecheck: false, strict: true, engine: 'quickjs' });
    expect(errors).toEqual([]);
    // db (backend olan.db), projects:read (server.events) and http:ops.example.com (backend olan.http.fetch).
    expect(warnings.map((item) => item.code).filter((code) => code.startsWith('permissions.'))).toEqual([]);
    // A permission nothing uses is still reported.
    app.write('olan-app.json', JSON.stringify({ ...JSON.parse(backendManifest()), permissions: ['db', 'projects:read', 'http:ops.example.com', 'storage'] }));
    const again = await validateApp(app.dir, { typecheck: false, strict: true, engine: 'quickjs' });
    expect(again.warnings.filter((item) => item.code === 'permissions.unused').map((item) => item.message)).toEqual([expect.stringContaining('"storage"')]);
  }, 120_000);

  it('reports a bundle without a defineBackend default export', async () => {
    const app = project('backend-noexport', { 'server/index.ts': `export const x = 1;\n` });
    const { errors } = await validateApp(app.dir, { typecheck: false, engine: 'quickjs' });
    expect(errors.map((item) => item.code)).toContain('validate.backend_default_export');
  });
});

describe('createBackendHarness', () => {
  it('calls functions against the mock host, with secrets only in the backend', async () => {
    const app = project('backend-harness');
    const backend = await createBackendHarness({ root: app.dir, engine: 'quickjs', now: '2026-10-17T09:00:00Z' });
    try {
      expect(backend.engine).toBe('quickjs');
      expect(await backend.call('add', { title: 'Bir' })).toMatchObject({ ok: true, logs: [expect.objectContaining({ level: 'log', message: 'added Bir' })] });
      expect((await backend.call('summary')).value).toEqual({ count: 1, configured: true });
      expect((await backend.call('settings')).value).toEqual({ title: 'Kutu', token: null, hookSecret: null });
      expect((await backend.call('ui')).value).toBe('unknown_method');
      expect((await backend.call('boom')).error).toEqual({ code: 'backend_error', runtimeCode: 'handler_error', message: 'kaboom' });
      expect((await backend.call('missing')).error?.code).toBe('backend_function_not_found');
      expect((await backend.call('add', { title: 'x' }, { permissions: [] })).error?.message).toMatch(/db permission/);
      expect(backend.calls('db.insert').every((call) => call.source === 'backend')).toBe(true);
      // Recorded backend calls never hold secret values.
      expect(backend.calls('secrets.get')[0]).toMatchObject({ params: { name: 'token' }, ok: true, result: '[secret]', source: 'backend' });
      expect(JSON.stringify(backend.host.calls)).not.toContain('tok-1');
      // §15.1: a trigger's fallback function (the event's `onTask`) is not callable from the UI and
      // is answered like a missing function.
      expect(await backend.call('onTask', { data: { task: { title: 'forged' } } })).toEqual({
        ok: false, error: { code: 'backend_function_not_found', runtimeCode: 'not_found', message: 'no handler for function "onTask"' }, logs: [], cpuMs: 0, wallMs: 0,
      });
      expect(backend.host.data.db.items?.some((row) => row.data.title === 'task:forged')).toBe(false);
      const unset = await createBackendHarness({ root: app.dir, engine: 'quickjs', secrets: { token: null } });
      expect((await unset.call('summary')).value).toMatchObject({ configured: false });
      await unset.dispose();
    } finally {
      await backend.dispose();
    }
  });

  it('runs schedules, events and verified hooks', async () => {
    const app = project('backend-triggers');
    // A fixed clock: each write is 1 s later, so rows keep their insertion order.
    const backend = await createBackendHarness({ root: app.dir, engine: 'quickjs', now: '2026-10-17T09:00:00Z' });
    try {
      expect((await backend.runSchedule('tick', { scheduledAt: '2026-10-17T09:05:00Z' })).ok).toBe(true);
      expect((await backend.emit({ type: 'project.task.created', data: { projectId: 'p0', task: { id: 't', title: 'Yeni' } } })).ok).toBe(true);
      expect((await backend.emit('project.task.created')).ok).toBe(true);
      expect(backend.host.data.db.items?.map((row) => row.data.title)).toEqual(['tick 2026-10-17T09:05:00Z', 'task:Yeni', 'task:Görev 1']);
      await expect(backend.emit('chat.message.created')).rejects.toThrow(/not in olan-app.json server.events/);
      await expect(backend.runSchedule('nope')).rejects.toThrow(/no "nope"/);

      const signed = await backend.hook('inbound', { body: 'merhaba' });
      expect([signed.status, signed.body, signed.headers['x-echo'], signed.verified]).toEqual([201, 'MERHABA', 'yes', true]);
      const forged = await backend.hook('inbound', { body: 'merhaba', headers: { 'x-signature': 'sha256=00' } });
      expect([forged.status, forged.verified, forged.error?.code]).toEqual([401, false, 'hook_verification_failed']);
      expect((await backend.hook('inbound', { body: 'x', sign: false })).status).toBe(401);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps a hook fallback function in functions away from backend.call', async () => {
    const app = project('backend-hook-fallback', {
      'olan-app.json': backendManifest({ hooks: [{ name: 'raw', function: 'rawHook', verify: { kind: 'hmac-sha256', header: 'x-signature', secretSetting: 'hookSecret' } }] }),
      'server/index.ts': SERVER.replace('    boom() {', '    rawHook: async (request) => ({ status: 200, body: { got: request.body } }),\n    boom() {'),
    });
    const backend = await createBackendHarness({ root: app.dir, engine: 'quickjs' });
    try {
      // The UI cannot reach the hook function without the signature check.
      expect((await backend.call('rawHook', { body: 'forged' })).error?.code).toBe('backend_function_not_found');
      const hook = await backend.hook('raw', { body: { a: 1 } });
      expect([hook.status, hook.headers['content-type'], hook.body]).toEqual([200, 'application/json; charset=utf-8', JSON.stringify({ got: '{"a":1}' })]);
    } finally {
      await backend.dispose();
    }
  });

  it('runs on isolated-vm in a forked runtime process', async () => {
    const app = project('backend-ivm');
    const backend = await createBackendHarness({ root: app.dir, engine: 'isolated-vm' });
    try {
      expect(backend.engine).toBe('isolated-vm');
      expect((await backend.call('summary')).value).toEqual({ count: 0, configured: true });
    } finally {
      await backend.dispose();
    }
  });
});

describe('hook signatures (@olan-app/sdk/server)', () => {
  it('signs and verifies hmac-sha256 and standard-webhooks', async () => {
    const hmac = { kind: 'hmac-sha256' as const, header: 'X-Hub-Signature-256', secretSetting: 's' };
    const headers = await signHookRequest(hmac, '{"a":1}', 'secret');
    expect(Object.keys(headers)).toEqual(['x-hub-signature-256']);
    expect(await verifyHookSignature(hmac, { headers, body: '{"a":1}' }, 'secret')).toEqual({ ok: true });
    expect(await verifyHookSignature(hmac, { headers, body: '{"a":2}' }, 'secret')).toMatchObject({ ok: false, status: 401 });
    expect(await verifyHookSignature(hmac, { headers, body: '{"a":1}' }, null)).toMatchObject({ ok: false, status: 503, code: 'hook_secret_missing' });
    const standard = { kind: 'standard-webhooks' as const, secretSetting: 's' };
    const secret = `whsec_${Buffer.from('k'.repeat(24)).toString('base64')}`;
    const signedHeaders = await signHookRequest(standard, 'body', secret, { now: 1_760_000_000_000 });
    expect(await verifyHookSignature(standard, { headers: signedHeaders, body: 'body' }, secret, { now: 1_760_000_000_000 })).toEqual({ ok: true });
    expect(await verifyHookSignature(standard, { headers: signedHeaders, body: 'body' }, secret, { now: 1_760_000_000_000 + 600_000 })).toMatchObject({ ok: false });
    expect(await verifyHookSignature({ kind: 'none' }, { headers: {}, body: '' }, null)).toMatchObject({ ok: false });
    expect(await verifyHookSignature({ kind: 'none' }, { headers: {}, body: '' }, null, { development: true })).toEqual({ ok: true });
  });
});

describe('renderApp and dev with a backend', () => {
  it('serves backend.call, schedules and hooks from olan-app dev', async () => {
    const app = project('backend-dev');
    const events: { type: string }[] = [];
    const dev = await startDevServer({ projectDir: app.dir, port: 0, engine: 'quickjs', onEvent: (event) => events.push(event) });
    try {
      expect(dev.status().backend).toMatchObject({ engine: 'quickjs', schedules: ['tick'], hooks: ['inbound'], errors: [] });
      const post = async (path: string, body: string, headers: Record<string, string> = {}) => {
        const response = await fetch(`${dev.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
        return { status: response.status, text: await response.text() };
      };
      expect(JSON.parse((await post('/rpc', JSON.stringify({ method: 'backend.call', params: { name: 'add', args: { title: 'dev' } } }))).text)).toMatchObject({ ok: true });
      expect(JSON.parse((await post('/rpc', JSON.stringify({ method: 'settings.get', params: {} }))).text)).toEqual({ ok: true, result: { title: 'Kutu', token: null, hookSecret: null } });
      expect(JSON.parse((await post('/backend/schedules/tick/run', '{}')).text)).toMatchObject({ ok: true });
      const signature = await signHookRequest({ kind: 'hmac-sha256', header: 'x-signature' }, 'ping', 'hook-1');
      expect(await post('/hooks/inbound', 'ping', signature)).toEqual({ status: 201, text: 'PING' });
      expect((await post('/hooks/inbound', 'ping', { 'x-signature': 'sha256=00' })).status).toBe(401);
      const called = JSON.parse((await post('/backend/call', JSON.stringify({ name: 'summary' }))).text);
      expect(called).toEqual({ ok: true, value: { count: 2, configured: true }, result: { count: 2, configured: true }, logs: [], cpuMs: expect.any(Number), wallMs: expect.any(Number) });
      expect(JSON.parse((await post('/backend/call', JSON.stringify({ name: 'onTask' }))).text)).toEqual({
        ok: false, error: { code: 'backend_function_not_found', runtimeCode: 'not_found', message: 'no handler for function "onTask"' }, logs: [], cpuMs: 0, wallMs: 0,
      });
      expect(JSON.parse((await post('/rpc', JSON.stringify({ method: 'backend.call', params: { name: 'onTask', args: {} } }))).text))
        .toEqual({ ok: false, error: { code: 'backend_function_not_found', message: 'no handler for function "onTask"' } });
      expect(events.filter((event) => event.type === 'backend-invocation').length).toBeGreaterThanOrEqual(5);
    } finally {
      await dev.close();
    }
  });

  it('renderApp records UI and backend calls, redacts secrets and refuses trigger functions', async () => {
    const app = project('backend-render');
    const rendered = await renderApp({ root: app.dir, backend: { engine: 'quickjs' } });
    try {
      await rendered.waitForText('0 kayıt', 10_000);
      expect(rendered.calls('backend.call', { source: 'ui' })).toHaveLength(1);
      expect(rendered.calls(undefined, { source: 'ui' }).every((call) => call.source === 'ui')).toBe(true);
      expect(rendered.calls('secrets.get')).toEqual([{ method: 'secrets.get', params: { name: 'token' }, ok: true, result: '[secret]', source: 'backend' }]);
      expect(await rendered.host.handle('backend.call', { name: 'onTask', args: {} })).toEqual({ ok: false, error: { code: 'backend_function_not_found', message: 'no handler for function "onTask"' } });
    } finally {
      await rendered.dispose();
    }
  });

  it('tells whether a process runs (olan-app dev stops with its parent)', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('init --backend creates an app that validates', async () => {
    const scratch = tempProject('backend-init');
    projects.push(scratch);
    initApp({ name: 'Arka uç', template: 'backend', cwd: scratch.dir, dir: 'app' });
    const dir = join(scratch.dir, 'app');
    expect(existsSync(join(dir, 'server/index.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'tests/backend.test.ts'), 'utf8')).toContain('createBackendHarness');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('olan.secrets.get');
    const { errors } = await validateApp(dir, { typecheck: false, engine: 'quickjs' });
    expect(errors).toEqual([]);
  });
});
