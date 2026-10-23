// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { PackageSignature } from '@olan-app/schema';

import { formatLogEntry, lanAddresses, parseLogEntries, startDevServer, type DevServer, type DevServerEvent } from '../src/commands/dev';
import { verifyPackageSignature } from '../src/commands/pack';
import { keyFingerprint } from '../src/dev-key';
import { manifest, tempProject, type TempProject } from './helpers';

const appSource = (greeting: string) => `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() { return <Screen title="Dev"><Text text="${greeting}" /></Screen>; }
export default defineApp({ app: Home });
`;

function nextMessage(socket: WebSocket, predicate: (message: { type: string; [key: string]: unknown }) => boolean, ms = 15_000) {
  return new Promise<{ type: string; [key: string]: unknown }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no matching WebSocket message')), ms);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as { type: string };
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

describe('dev server', () => {
  let project: TempProject;
  let dev: DevServer;
  beforeAll(async () => {
    project = tempProject('dev', { 'olan-app.json': manifest(), 'src/app.tsx': appSource('Merhaba') });
    dev = await startDevServer({ projectDir: project.dir, port: 0 });
  });
  afterAll(async () => {
    await dev?.close();
    project?.remove();
  });

  it('serves the manifest, the bundle, the status, fixtures and the mock RPC', async () => {
    expect(dev.url).toBe(`http://localhost:${dev.port}`);
    const base = `http://127.0.0.1:${dev.port}`;
    const manifestResponse = await fetch(`${base}/manifest`);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(await manifestResponse.json()).toMatchObject({ id: 'com.example.test-app', kind: 'app', permissions: ['projects:read'] });

    const bundle = await fetch(`${base}/app.js`);
    expect(bundle.headers.get('content-type')).toContain('application/javascript');
    const code = await bundle.text();
    expect(code).toContain('Merhaba');
    expect(code.trimStart().startsWith('(() => {')).toBe(true);

    const status = (await (await fetch(`${base}/status`)).json()) as { appId: string; buildId: string; errors: unknown[] };
    expect(status).toMatchObject({ appId: 'com.example.test-app', version: '0.1.0', errors: [] });
    expect(status.buildId).toMatch(/^[0-9a-f]{12}$/);

    const fixtures = (await (await fetch(`${base}/fixtures`)).json()) as { projects: { project: { id: string } }[] };
    expect(fixtures.projects.map((detail) => detail.project.id)).toEqual(['p0', 'p1', 'p2']);

    const rpc = async (body: unknown) => (await fetch(`${base}/rpc`, { method: 'POST', body: JSON.stringify(body) })).json();
    expect(await rpc({ method: 'projects.list', params: { limit: 1 } })).toMatchObject({ ok: true, result: { items: [{ id: 'p0' }], nextCursor: '1' } });
    expect(await rpc({ method: 'projects.list', params: {}, permissions: [] })).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('pushes rebuilt and error messages over the WebSocket', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${dev.port}/ws`);
    const hello = await nextMessage(socket, () => true);
    expect(hello).toEqual({ type: 'rebuilt', buildId: dev.status().buildId });

    const first = dev.status().buildId;
    const rebuilt = nextMessage(socket, (message) => message.type === 'rebuilt' && message.buildId !== first);
    project.write('src/app.tsx', appSource('Merhaba yeni'));
    const message = await rebuilt;
    expect(message.buildId).toBe(dev.status().buildId);
    expect(await (await fetch(`http://127.0.0.1:${dev.port}/app.js`)).text()).toContain('Merhaba yeni');

    const failed = nextMessage(socket, (next) => next.type === 'error');
    project.write('src/app.tsx', 'export default defineApp({ app: ;\n');
    const error = await failed;
    expect(error.errors).toMatchObject([{ code: 'build.error', file: 'src/app.tsx', line: 1 }]);
    const status = (await (await fetch(`http://127.0.0.1:${dev.port}/status`)).json()) as { errors: unknown[] };
    expect(status.errors).toHaveLength(1);
    // The last good bundle stays available.
    expect(await (await fetch(`http://127.0.0.1:${dev.port}/app.js`)).text()).toContain('Merhaba yeni');

    const manifestChanged = nextMessage(socket, (next) => next.type === 'manifest');
    project.write('olan-app.json', readFileSync(join(project.dir, 'olan-app.json'), 'utf8').replace('"0.1.0"', '"0.2.0"'));
    await manifestChanged;
    expect(dev.status().version).toBe('0.2.0');
    socket.close();
  });
});

describe('dev server logs and user (Phase 2 server contract §5, §10.1)', () => {
  let project: TempProject;
  let dev: DevServer;
  const events: DevServerEvent[] = [];
  beforeAll(async () => {
    project = tempProject('dev-logs', { 'olan-app.json': manifest(), 'src/app.tsx': appSource('Log') });
    dev = await startDevServer({ projectDir: project.dir, port: 0, host: '127.0.0.1', onEvent: (event) => events.push(event) });
  });
  afterAll(async () => {
    await dev?.close();
    project?.remove();
  });

  it('accepts POST /logs, reports log events and names the mock user in /status', async () => {
    expect(dev).toMatchObject({ host: '127.0.0.1', lanUrls: [], url: `http://localhost:${dev.port}` });
    const base = `http://127.0.0.1:${dev.port}`;
    const post = (body: unknown) => fetch(`${base}/logs`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    const ok = await post({ entries: [{ level: 'info', args: ['merhaba', { n: 1 }], at: '2026-10-17T10:00:00Z' }, { level: 'error', args: [] }] });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    expect(events.filter((event) => event.type === 'log')).toEqual([
      { type: 'log', level: 'info', args: ['merhaba', { n: 1 }], at: '2026-10-17T10:00:00Z' },
      { type: 'log', level: 'error', args: [], at: null },
    ]);
    expect(formatLogEntry({ level: 'info', args: ['merhaba', { n: 1 }], at: '2026-10-17T10:00:00Z' })).toBe('[app info] 2026-10-17T10:00:00Z merhaba {"n":1}');

    expect((await post('nope')).status).toBe(400);
    expect(await (await post({ entries: [{ level: 'loud', args: [] }] })).json()).toMatchObject({ error: 'invalid_request', message: expect.stringContaining('level') });
    expect((await post({ entries: Array.from({ length: 101 }, () => ({ level: 'info', args: [] })) })).status).toBe(400);
    expect((await post({ entries: [{ level: 'info', args: ['x'.repeat(9000)] }] })).status).toBe(400);
    expect(events.filter((event) => event.type === 'log')).toHaveLength(2);

    const status = (await (await fetch(`${base}/status`)).json()) as { user: { id: string } };
    expect(status.user).toEqual({ id: '00000000-0000-4000-8000-000000000001' });
    const rpc = await (await fetch(`${base}/rpc`, { method: 'POST', body: JSON.stringify({ method: 'users.get', params: { ids: [status.user.id] }, permissions: ['users:read'] }) })).json();
    expect(rpc).toMatchObject({ ok: true, result: { users: [{ id: status.user.id, displayName: 'Utku' }] } });
  });

  it('parses log batches and lists LAN addresses', () => {
    expect(parseLogEntries({ entries: [] })).toEqual({ ok: true, entries: [] });
    expect(parseLogEntries({ entries: [{ level: 'warn', args: [1], at: 5 }] })).toMatchObject({ ok: false });
    for (const address of lanAddresses()) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe('dev server GET /package (Studio "Bu kurumda dene")', () => {
  let project: TempProject;
  let dev: DevServer;
  let keyFile = '';
  const SERVER_SOURCE = `import { defineBackend } from '@olan-app/sdk/backend';\nexport default defineBackend({ functions: { ping: () => 'pong' } });\n`;
  beforeAll(async () => {
    project = tempProject('dev-package', {
      'olan-app.json': manifest({ sdk: '^1.4.0', permissions: [], server: { entry: 'server/index.ts' } }),
      'src/app.tsx': appSource('Paket'),
      'server/index.ts': SERVER_SOURCE,
    });
    keyFile = join(project.dir, '.keys', 'dev.key.json');
    dev = await startDevServer({ projectDir: project.dir, port: 0, env: { OLAN_APP_DEV_KEY: keyFile } });
  });
  afterAll(async () => {
    await dev?.close();
    project?.remove();
  });

  it('serves the current build packed and signed with the development key', async () => {
    const base = `http://127.0.0.1:${dev.port}`;
    const response = await fetch(`${base}/package`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="com.example.test-app-0.1.0.olanapp"');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['digest.json', 'dist/app.js', 'dist/server.js', 'olan-app.json', 'signature.json']);
    // The dev server's own build (what /app.js serves), not a file on disk.
    expect(strFromU8(files['dist/app.js']!)).toBe(await (await fetch(`${base}/app.js`)).text());
    expect(strFromU8(files['dist/server.js']!)).toContain('__olanBackendModule');
    const digest = JSON.parse(strFromU8(files['digest.json']!)) as { package: string };
    const signature = JSON.parse(strFromU8(files['signature.json']!)) as PackageSignature;
    expect(response.headers.get('x-olan-package-sha256')).toBe(digest.package);
    expect(verifyPackageSignature(digest.package, signature)).toBe(true);
    // Signed with the development key (created on first use at OLAN_APP_DEV_KEY).
    const key = JSON.parse(readFileSync(keyFile, 'utf8')) as { publicKey: string };
    expect(signature.publicKey).toBe(key.publicKey);
    expect(response.headers.get('x-olan-signing-key')).toBe(keyFingerprint(key.publicKey));
  });

  it('packs and signs under ?version= (the server-named -dev.N) without touching olan-app.json', async () => {
    const base = `http://127.0.0.1:${dev.port}`;
    const onDisk = readFileSync(join(project.dir, 'olan-app.json'), 'utf8');
    const response = await fetch(`${base}/package?version=0.1.0-dev.3`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="com.example.test-app-0.1.0-dev.3.olanapp"');
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect((JSON.parse(strFromU8(files['olan-app.json']!)) as { version: string }).version).toBe('0.1.0-dev.3');
    const digest = JSON.parse(strFromU8(files['digest.json']!)) as { package: string; files: Record<string, string> };
    expect(verifyPackageSignature(digest.package, JSON.parse(strFromU8(files['signature.json']!)) as PackageSignature)).toBe(true);
    expect(digest.files['olan-app.json']).toBe(createHash('sha256').update(files['olan-app.json']!).digest('hex'));
    expect(readFileSync(join(project.dir, 'olan-app.json'), 'utf8')).toBe(onDisk);
    const invalid = await fetch(`${base}/package?version=next`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'version_invalid' });
  });

  it('follows rebuilds and answers 503 while the build fails', async () => {
    const base = `http://127.0.0.1:${dev.port}`;
    const rebuilt = dev.nextBuild();
    project.write('src/app.tsx', appSource('Paket yeni'));
    await rebuilt;
    const files = unzipSync(new Uint8Array(await (await fetch(`${base}/package`)).arrayBuffer()));
    expect(strFromU8(files['dist/app.js']!)).toContain('Paket yeni');

    project.write('server/index.ts', 'export default defineBackend({ functions: { ;\n');
    const broken = await fetch(`${base}/package`);
    expect(broken.status).toBe(503);
    expect(await broken.json()).toMatchObject({ error: 'build_failed', errors: [expect.objectContaining({ file: 'server/index.ts' })] });
    project.write('server/index.ts', SERVER_SOURCE);
  });
});
